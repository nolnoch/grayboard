//! Where a request's bearer token comes from (#929; `docs/sdk-rust.md` §5): a fixed token, or a service credential that mints its own run tokens.

use crate::error::{AuthError, Error, server_text};
use futures_util::future::BoxFuture;
use serde::Deserialize;
use std::sync::Arc;
use std::time::Duration;
use tokio::time::Instant;

/// A source of bearer tokens. The transport calls `token` before every request and every retry, so a credential that re-mints is picked up on the next request.
///
/// The methods return boxed `Send` futures so a `Client` can hold an `Arc<dyn Credential>` and its tasks can be spawned; the shape matches hosted-core's `AuthProvider`.
pub trait Credential: Send + Sync + 'static {
    /// The token for the next request. A `retryable` error fails the request as `Error::Unreachable`, a terminal one as `Error::Auth`.
    fn token(&self) -> BoxFuture<'_, Result<String, AuthError>>;
    /// The server answered 401 to `rejected`. Return `Ok` once a fresh token is ready (the request is retried once), or an error to fail it: `Unauthorized` when terminal, `Unreachable` when `retryable`.
    fn unauthorized<'a>(&'a self, rejected: &'a str) -> BoxFuture<'a, Result<(), AuthError>>;
    /// A generation counter that moves whenever the credential installs a new token, or `None` (the default) for one whose token never changes on its own. The delivery stream watches it and reopens its listen stream on the new token at once (#1265): the server closes a stream when the token it was opened with expires.
    fn changes(&self) -> Option<tokio::sync::watch::Receiver<u64>> {
        None
    }
}

/// A fixed token: a CI token or a run token a launcher minted. A 401 is terminal.
#[derive(Clone)]
pub struct StaticBearer(String);

impl StaticBearer {
    pub fn new(token: impl Into<String>) -> Self {
        Self(token.into())
    }
}

impl std::fmt::Debug for StaticBearer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("StaticBearer(..)")
    }
}

impl Credential for StaticBearer {
    fn token(&self) -> BoxFuture<'_, Result<String, AuthError>> {
        let token = self.0.clone();
        Box::pin(async move { Ok(token) })
    }
    fn unauthorized<'a>(&'a self, _rejected: &'a str) -> BoxFuture<'a, Result<(), AuthError>> {
        Box::pin(async {
            Err(AuthError::terminal(
                "the server rejected the static bearer token",
            ))
        })
    }
}

/// A token is re-minted once this fraction of its lifetime has passed: the server closes a listen stream when its token expires, so the next one must be ready before then.
const RENEW_AT: f64 = 0.8;
/// The first retry of a failed mint waits this long, doubling per failure in a row up to `BACKOFF_MAX`; a longer `Retry-After` wins.
const BACKOFF_UNIT: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(60);
/// With no usable token, `token` waits out a backoff this short itself rather than failing the request (the transport bounds `token` by its request timeout, 10 s).
const WAIT_MAX: Duration = Duration::from_secs(2);
/// Each metadata, token or revocation request, body included.
const HTTP_TIMEOUT: Duration = Duration::from_secs(4);
/// A token's lifetime is clamped to this (the server's own ceiling), so a broken issuer's huge `expires_in` can't overflow an `Instant`.
const LIFETIME_MAX: Duration = Duration::from_secs(366 * 24 * 60 * 60);

/// A service credential (#270): a `svc_` client ID and its secret, which mint run tokens with the OAuth client-credentials grant, no browser.
///
/// It reads the server's authorization-server metadata once (RFC 8414) and refuses metadata that names another issuer, so the caller pins the issuer; then it posts `grant_type=client_credentials` with the secret in the Basic header (`client_secret_basic`) and `resource` set to the MCP endpoint. A token is cached and re-minted at 80% of its lifetime, and once more when the server rejects it. A capacity refusal (`slow_down`, 429), a 5xx or an unreachable server backs off, the current token serving while it lasts; `invalid_client` (a revoked or expired credential or secret, a disabled service) and any other refusal are terminal: every later call fails without asking the server again.
///
/// Cheap to clone: clones share one cache, so several `Client`s on one credential share its token (the server caps mints per credential per minute). The secret never appears in `Debug` output or in an error.
#[derive(Clone)]
pub struct ClientCredentials {
    inner: Arc<Inner>,
    _owner: Arc<Owner>,
}

/// Shared by every clone; dropped with the last, it aborts a renewal still in flight (#1375 F3), whose guard records it as a cancelled mint. A `Weak`, so the task's own strong reference is all that keeps the state alive meanwhile.
struct Owner(std::sync::Weak<Inner>);

impl Drop for Owner {
    fn drop(&mut self) {
        if let Some(inner) = self.0.upgrade() {
            let renewal = inner.state().renewal.take();
            if let Some(renewal) = renewal {
                renewal.abort();
            }
        }
    }
}

struct Inner {
    http: reqwest::Client,
    issuer: String,
    resource: String,
    client_id: String,
    secret: Secret,
    backoff_unit: Duration,
    /// The metadata's endpoints, read once; concurrent first calls share one read.
    endpoints: tokio::sync::OnceCell<Endpoints>,
    /// Never held across an `.await`: a mint runs unlocked, single-flighted by `State::minting` (#1263).
    state: std::sync::Mutex<State>,
    /// Woken when a mint ends, however it ends, for callers that had no valid token to serve.
    minted: tokio::sync::Notify,
    /// Bumped whenever a mint installs a new token (`Credential::changes`, #1265).
    generation: tokio::sync::watch::Sender<u64>,
}

/// The secret: never printed.
struct Secret(String);

#[derive(Default)]
struct State {
    current: Option<Minted>,
    /// A mint is in flight: other callers serve the current token while it's valid, or wait for the mint.
    minting: bool,
    /// Tokens `revoke` took out of service whose revocation hasn't succeeded yet: never served again, and retried by the next `revoke`.
    revoking: Vec<String>,
    /// Set by a terminal refusal; every later call fails with it.
    dead: Option<String>,
    /// While set and in the future, no mint is attempted.
    retry_at: Option<Instant>,
    /// The renewal task, if one was spawned (#1375 F3): aborted when the last clone drops.
    renewal: Option<tokio::task::AbortHandle>,
    /// `unauthorized` is answering a rejection: the next token installed, whoever minted it, is that answer and takes `replaced_rejected` (#1375 F4). Cleared by any mint's end.
    answering_rejection: bool,
    failures: u32,
    last_failure: String,
    /// Replacement tokens the server rejected in a row (#1264): each backs off the next mint, doubling. Reset when a token that was served lives to its renewal unrejected (#1375 F5).
    rejections: u32,
}

struct Endpoints {
    token: reqwest::Url,
    revocation: Option<reqwest::Url>,
}

struct Minted {
    token: String,
    expires_at: Instant,
    renew_at: Instant,
    /// Minted to replace a token the server rejected, or handed to a request in answer to one: a rejection of this one is not answered with another mint.
    replaced_rejected: bool,
    /// Handed to a caller at least once. A token a background renewal installed that sat unused until its own renewal proves nothing about the server taking this credential's tokens.
    served: bool,
}

enum MintError {
    /// Worth retrying later: unreachable, a 5xx, a 429, a malformed answer.
    Transient {
        message: String,
        retry_after: Option<Duration>,
    },
    /// Retrying can't help: the credential, the issuer or the configuration is wrong.
    Terminal(String),
}

impl MintError {
    /// As a request's error: a transient failure is `Unreachable`, as the transport classes one.
    fn into_error(self) -> Error {
        match self {
            Self::Transient { message, .. } => Error::Unreachable(message),
            Self::Terminal(message) => Error::Auth(AuthError::terminal(message)),
        }
    }
}

#[derive(Deserialize)]
struct ServerMetadata {
    issuer: String,
    token_endpoint: String,
    revocation_endpoint: Option<String>,
    grant_types_supported: Option<Vec<String>>,
    token_endpoint_auth_methods_supported: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    token_type: String,
    expires_in: u64,
}

#[derive(Deserialize)]
struct OAuthErrorBody {
    error: String,
}

impl std::fmt::Debug for ClientCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClientCredentials")
            .field("issuer", &self.inner.issuer)
            .field("resource", &self.inner.resource)
            .field("client_id", &self.inner.client_id)
            .field("secret", &"..")
            .finish()
    }
}

/// HTTPS, or HTTP to a loopback host: a secret and its tokens never cross a network in the clear.
fn secure_url(what: &str, raw: &str) -> Result<reqwest::Url, Error> {
    let url = reqwest::Url::parse(raw)
        .map_err(|e| Error::InvalidArgument(format!("invalid {what} {raw:?}: {e}")))?;
    let host = url.host_str().unwrap_or("");
    let loopback = host == "localhost"
        || host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback());
    if !(url.scheme() == "https" || (url.scheme() == "http" && loopback)) {
        return Err(Error::InvalidArgument(format!(
            "{what} {raw:?} must be HTTPS (or HTTP to a loopback host)"
        )));
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(Error::InvalidArgument(format!(
            "{what} {raw:?} must have no credentials, query or fragment"
        )));
    }
    Ok(url)
}

/// `application/x-www-form-urlencoded` for one value; RFC 6749 §2.3.1 applies it to the Basic header's client ID and secret too.
pub(crate) fn form_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for b in value.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn retry_after(response: &reqwest::Response) -> Option<Duration> {
    response
        .headers()
        .get("retry-after")?
        .to_str()
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()
        .map(Duration::from_secs)
}

/// A request that got no answer. Its text never carries the secret, which only the Basic header holds.
fn unreachable(what: &str, e: reqwest::Error) -> MintError {
    MintError::Transient {
        message: format!("{what}: {}", e.without_url()),
        retry_after: None,
    }
}

/// A non-success status: 429 and 5xx are transient, anything else terminal. Only the server's OAuth `error` code is kept, capped.
async fn refused(what: &str, response: reqwest::Response) -> MintError {
    let status = response.status();
    let after = retry_after(&response);
    let code = response
        .json::<OAuthErrorBody>()
        .await
        .ok()
        .map(|b| server_text(&b.error));
    let message = match code {
        Some(code) => format!("{what} refused (HTTP {}): {code}", status.as_u16()),
        None => format!("{what} answered HTTP {}", status.as_u16()),
    };
    if status.as_u16() == 429 || status.is_server_error() {
        MintError::Transient {
            message,
            retry_after: after,
        }
    } else {
        MintError::Terminal(message)
    }
}

impl ClientCredentials {
    /// `endpoint` is the MCP endpoint the tokens are for (the `Client`'s URL, sent as `resource`); `issuer` is the server's OAuth issuer exactly as its metadata names it (its public URL, for example `https://bus.example.com`), on the endpoint's origin. Both must be HTTPS, or HTTP to a loopback host. Nothing is sent until the first `token`.
    pub fn new(
        endpoint: &str,
        issuer: &str,
        client_id: impl Into<String>,
        secret: impl Into<String>,
    ) -> Result<Self, Error> {
        let resource = secure_url("endpoint", endpoint)?;
        let at = secure_url("issuer", issuer)?;
        if at.origin() != resource.origin() {
            return Err(Error::InvalidArgument(format!(
                "issuer {issuer:?} is not on the endpoint's origin"
            )));
        }
        let (client_id, secret) = (client_id.into(), secret.into());
        if client_id.is_empty() || secret.is_empty() {
            return Err(Error::InvalidArgument(
                "a client ID and a secret are required".into(),
            ));
        }
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(crate::transport::CONNECT_TIMEOUT)
            .timeout(HTTP_TIMEOUT)
            .build()
            .map_err(|e| Error::InvalidResponse(format!("HTTP client: {e}")))?;
        Ok(Self::wrap(Inner {
            http,
            issuer: issuer.to_owned(),
            resource: endpoint.to_owned(),
            client_id,
            secret: Secret(secret),
            backoff_unit: BACKOFF_UNIT,
            endpoints: tokio::sync::OnceCell::new(),
            state: std::sync::Mutex::default(),
            minted: tokio::sync::Notify::new(),
            generation: tokio::sync::watch::Sender::new(0),
        }))
    }

    fn wrap(inner: Inner) -> Self {
        let inner = Arc::new(inner);
        Self {
            _owner: Arc::new(Owner(Arc::downgrade(&inner))),
            inner,
        }
    }

    #[cfg(test)]
    pub(crate) fn with_backoff_unit(self, unit: Duration) -> Self {
        let Self { inner, _owner } = self;
        drop(_owner);
        let mut inner = Arc::try_unwrap(inner).ok().expect("set before any clone");
        inner.backoff_unit = unit;
        Self::wrap(inner)
    }

    /// Revokes the current token (RFC 7009, at the server's revocation endpoint with the same Basic auth), so a run's token ends when the run does: its sessions are refused on their next call. Call it after `Session::end`. The token is out of service from the start, so a later `token` mints a new one; if the revocation fails (`Unreachable`, or `Auth` for a refusal), calling `revoke` again retries the same token. Each pending token is sent on its own, so one that keeps failing doesn't hold back the rest. A mint in flight is waited for, so its token is revoked too. With no token to revoke nothing is sent; when the server advertises no revocation endpoint nothing is kept to retry.
    pub async fn revoke(&self) -> Result<(), Error> {
        // The current token goes out of service at once; a mint in flight finishes first, so the token it installs is revoked too rather than left live. Each take shares a critical section with the check of `minting`.
        let mut had_current = false;
        let pending = loop {
            let notified = self.inner.minted.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let mut s = self.inner.state();
                if let Some(current) = s.current.take() {
                    had_current = true;
                    // Known to be unrevocable: nothing to keep (#1271 R3).
                    let unrevocable = self
                        .inner
                        .endpoints
                        .get()
                        .is_some_and(|e| e.revocation.is_none());
                    if !unrevocable {
                        s.revoking.push(current.token);
                    }
                }
                if !s.minting {
                    break s.revoking.clone();
                }
            }
            notified.await;
        };
        // Nothing to revoke: nothing sent, not even the metadata read.
        if pending.is_empty() && !had_current {
            return Ok(());
        }
        let endpoints = self
            .inner
            .endpoints()
            .await
            .map_err(MintError::into_error)?;
        // Nothing is queued once the endpoints are known without one, and a current token means they are.
        let Some(url) = endpoints.revocation.clone() else {
            return Err(Error::Auth(AuthError::terminal(
                "the server's metadata names no revocation endpoint",
            )));
        };
        // Unlocked while sending (#1263): requests keep being served meanwhile.
        let mut first_error = None;
        let mut revoked = Vec::new();
        for token in pending {
            match self.inner.revoke_one(url.clone(), &token).await {
                Ok(()) => revoked.push(token),
                Err(e) => {
                    first_error.get_or_insert(e);
                }
            }
        }
        self.inner.state().revoking.retain(|t| !revoked.contains(t));
        first_error.map_or(Ok(()), Err)
    }

    /// The tokens still waiting on a revocation.
    #[cfg(test)]
    pub(crate) fn pending_revocations(&self) -> usize {
        self.inner.state().revoking.len()
    }

    /// Lifts a backoff in force, so a test reaches the next mint without waiting it out.
    #[cfg(test)]
    pub(crate) fn skip_backoff(&self) {
        self.inner.state().retry_at = None;
    }

    /// Until no mint is in flight: a background renewal has installed its token or recorded its failure.
    #[cfg(test)]
    pub(crate) async fn settled(&self) {
        loop {
            let notified = self.inner.minted.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if !self.inner.state().minting {
                return;
            }
            notified.await;
        }
    }

    /// Ages the current token: into its renewal window, or past its expiry too.
    #[cfg(test)]
    pub(crate) fn age_token(&self, expired: bool) {
        let now = Instant::now();
        let mut s = self.inner.state();
        let m = s.current.as_mut().expect("a token to age");
        m.renew_at = now;
        if expired {
            m.expires_at = now;
        }
    }
}

/// What a caller does next, decided under the lock and done outside it.
enum Step {
    Serve(String),
    /// Mint with no valid token to serve.
    Mint,
    /// Serve this still-valid token and renew it in the background (#1375 F3).
    Renew(String),
    /// Another caller is minting and there's no valid token: wait for it.
    Wait,
    /// A short backoff holds the mint.
    Sleep(Duration),
}

/// Owned by the caller running a mint: however the mint ends, cancelled included, the flag is cleared and waiters woken (#1271 F8).
struct MintGuard<'a> {
    inner: &'a Inner,
    done: bool,
}

impl Drop for MintGuard<'_> {
    fn drop(&mut self) {
        if !self.done {
            // Cut off mid-mint (the transport's request bound, a caller's timeout, a renewal aborted with the credential): a transient failure, so the next mint backs off.
            let mut s = self.inner.state();
            s.minting = false;
            s.answering_rejection = false;
            self.inner
                .back_off(&mut s, "a token request was cancelled".into(), None);
        }
        self.inner.minted.notify_waiters();
    }
}

impl Inner {
    /// A form POST with the client ID and secret in the Basic header (marked sensitive by reqwest).
    fn post(&self, url: reqwest::Url, body: String) -> reqwest::RequestBuilder {
        self.http
            .post(url)
            .basic_auth(
                form_encode(&self.client_id),
                Some(form_encode(&self.secret.0)),
            )
            .header("content-type", "application/x-www-form-urlencoded")
            .header("accept", "application/json")
            .body(body)
    }

    /// The state; a panic elsewhere while it was held leaves nothing half-written that matters here.
    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The metadata's endpoints, read once.
    async fn endpoints(&self) -> Result<&Endpoints, MintError> {
        self.endpoints.get_or_try_init(|| self.discover()).await
    }

    /// One RFC 7009 revocation.
    async fn revoke_one(&self, url: reqwest::Url, token: &str) -> Result<(), Error> {
        let response = self
            .post(url, format!("token={}", form_encode(token)))
            .send()
            .await
            .map_err(|e| Error::Unreachable(format!("revoke: {}", e.without_url())))?;
        let status = response.status();
        if status.is_success() {
            return Ok(());
        }
        let text = format!("revoke answered HTTP {}", status.as_u16());
        Err(if status.as_u16() == 429 || status.is_server_error() {
            Error::Unreachable(text)
        } else {
            Error::Auth(AuthError::terminal(text))
        })
    }

    /// RFC 8414 §3: the metadata is at the issuer's origin, the issuer's path after the well-known prefix.
    async fn discover(&self) -> Result<Endpoints, MintError> {
        let issuer = reqwest::Url::parse(&self.issuer).expect("checked in new");
        let path = issuer.path().trim_end_matches('/');
        let at = format!(
            "{}/.well-known/oauth-authorization-server{path}",
            issuer.origin().ascii_serialization()
        );
        let response = self
            .http
            .get(&at)
            .header("accept", "application/json")
            .send()
            .await
            .map_err(|e| unreachable("authorization-server metadata", e))?;
        if !response.status().is_success() {
            return Err(refused("authorization-server metadata", response).await);
        }
        let meta: ServerMetadata = response.json().await.map_err(|e| MintError::Transient {
            message: format!("authorization-server metadata: {}", e.without_url()),
            retry_after: None,
        })?;
        if meta.issuer != self.issuer {
            return Err(MintError::Terminal(format!(
                "the server's metadata names issuer {:?}, expected {:?}",
                server_text(&meta.issuer),
                self.issuer
            )));
        }
        if let Some(grants) = &meta.grant_types_supported
            && !grants.iter().any(|g| g == "client_credentials")
        {
            return Err(MintError::Terminal(
                "the server doesn't offer the client-credentials grant".into(),
            ));
        }
        if let Some(methods) = &meta.token_endpoint_auth_methods_supported
            && !methods.iter().any(|m| m == "client_secret_basic")
        {
            return Err(MintError::Terminal(
                "the server doesn't take client_secret_basic".into(),
            ));
        }
        // The secret and its tokens only ever go to the issuer's own origin.
        let on_origin = |raw: &str| -> Result<reqwest::Url, MintError> {
            match reqwest::Url::parse(raw) {
                Ok(u) if u.origin() == issuer.origin() => Ok(u),
                _ => Err(MintError::Terminal(format!(
                    "the server's metadata names an endpoint off the issuer's origin: {:?}",
                    server_text(raw)
                ))),
            }
        };
        Ok(Endpoints {
            token: on_origin(&meta.token_endpoint)?,
            revocation: meta
                .revocation_endpoint
                .as_deref()
                .map(on_origin)
                .transpose()?,
        })
    }

    async fn mint(&self) -> Result<Minted, MintError> {
        let url = self.endpoints().await?.token.clone();
        let started = Instant::now();
        let body = format!(
            "grant_type=client_credentials&resource={}",
            form_encode(&self.resource)
        );
        let response = self
            .post(url, body)
            .send()
            .await
            .map_err(|e| unreachable("token request", e))?;
        if !response.status().is_success() {
            return Err(refused("token request", response).await);
        }
        let issued: TokenResponse = response.json().await.map_err(|e| MintError::Transient {
            message: format!("token response: {}", e.without_url()),
            retry_after: None,
        })?;
        let valid = (1..=4096).contains(&issued.access_token.len())
            && issued
                .access_token
                .bytes()
                .all(|b| (0x21..=0x7e).contains(&b));
        if !valid || !issued.token_type.eq_ignore_ascii_case("bearer") || issued.expires_in == 0 {
            return Err(MintError::Transient {
                message: "the token response has no usable bearer token and lifetime".into(),
                retry_after: None,
            });
        }
        // Timed from the request's start, so the token's age is never underestimated.
        let lifetime = Duration::from_secs(issued.expires_in).min(LIFETIME_MAX);
        Ok(Minted {
            token: issued.access_token,
            expires_at: started + lifetime,
            renew_at: started + lifetime.mul_f64(RENEW_AT),
            replaced_rejected: false,
            served: false,
        })
    }

    /// Schedules the next mint attempt after a failure, doubling per failure in a row; a longer `retry_after` wins.
    fn back_off(&self, s: &mut State, message: String, retry_after: Option<Duration>) {
        s.failures = s.failures.saturating_add(1);
        let wait = self
            .doubled(s.failures)
            .max(retry_after.unwrap_or_default())
            .min(BACKOFF_MAX);
        s.retry_at = Some(Instant::now() + wait);
        s.last_failure = message;
    }

    /// The backoff unit doubled per failure after the first.
    fn doubled(&self, failures: u32) -> Duration {
        self.backoff_unit
            .saturating_mul(1 << failures.saturating_sub(1).min(16))
    }

    /// Runs one mint with no lock held, then records the outcome: a terminal error kills the credential, a transient one schedules the next attempt. The caller set `minting`. `served`: the token goes straight to a caller, not a background renewal.
    async fn mint_recorded(&self, served: bool) -> Result<String, AuthError> {
        let mut guard = MintGuard {
            inner: self,
            done: false,
        };
        let outcome = self.mint().await;
        let mut s = self.state();
        s.minting = false;
        guard.done = true;
        // The mark goes with the token installed after the rejection, whichever caller minted it (#1375 F4); a failed mint answers the rejection with its error.
        let answers_rejection = std::mem::take(&mut s.answering_rejection);
        match outcome {
            Ok(mut minted) => {
                minted.replaced_rejected = answers_rejection;
                minted.served = served;
                let token = minted.token.clone();
                s.current = Some(minted);
                s.failures = 0;
                s.retry_at = None;
                // Under the lock, so a watcher woken by it reads this token or a later one.
                self.generation.send_modify(|g| *g = g.wrapping_add(1));
                Ok(token)
            }
            Err(MintError::Terminal(message)) => {
                let message = format!("the service credential is refused: {message}");
                s.dead = Some(message.clone());
                s.current = None;
                Err(AuthError::terminal(message))
            }
            Err(MintError::Transient {
                message,
                retry_after,
            }) => {
                self.back_off(&mut s, message.clone(), retry_after);
                Err(AuthError::transient(message))
            }
        }
        // `guard` drops here, after the lock, and wakes the waiters.
    }

    /// The next step for a caller that wants a token, with no lock held after it returns.
    fn step(&self) -> Result<Step, AuthError> {
        let mut s = self.state();
        if let Some(dead) = &s.dead {
            return Err(AuthError::terminal(dead.clone()));
        }
        let now = Instant::now();
        let (minting, backing_off) = (s.minting, s.retry_at.is_some_and(|at| now < at));
        if let Some(m) = &mut s.current {
            if now < m.expires_at {
                // Valid: served by every caller, renewing in the background once due (#1375 F3); a renewal in flight, a backoff or a failed renewal leaves it serving until it expires.
                let used = std::mem::replace(&mut m.served, true);
                let token = m.token.clone();
                if now < m.renew_at || minting || backing_off {
                    return Ok(Step::Serve(token));
                }
                s.minting = true;
                // It lived to its renewal unrejected after a caller used it: the server takes this credential's tokens (#1375 F5).
                if used {
                    s.rejections = 0;
                }
                return Ok(Step::Renew(token));
            }
            s.current = None;
        }
        if s.minting {
            return Ok(Step::Wait);
        }
        if let Some(at) = s.retry_at {
            let wait = at.saturating_duration_since(now);
            if wait > WAIT_MAX {
                return Err(AuthError::transient(format!(
                    "minting a token is backing off for {wait:?} after: {}",
                    s.last_failure
                )));
            }
            if !wait.is_zero() {
                return Ok(Step::Sleep(wait));
            }
        }
        s.minting = true;
        Ok(Step::Mint)
    }

    /// A token: the cached one, or one mint shared by every caller (#1263). A token due for renewal is served while a background task renews it (#1375 F3). With no valid token, waits out a short backoff rather than failing; a longer one fails at once with the last failure.
    /// `serve`: the caller uses the token (`token`), rather than only wanting one ready (`unauthorized`).
    async fn acquire(self: &Arc<Self>, serve: bool) -> Result<String, AuthError> {
        loop {
            // Registered before the state is read, so a mint ending in between still wakes this caller.
            let notified = self.minted.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            match self.step()? {
                Step::Serve(token) => return Ok(token),
                Step::Renew(token) => {
                    self.renew();
                    return Ok(token);
                }
                Step::Wait => notified.await,
                Step::Sleep(wait) => tokio::time::sleep(wait).await,
                Step::Mint => match self.mint_recorded(serve).await {
                    Ok(token) => return Ok(token),
                    Err(e) if !e.retryable => return Err(e),
                    // A transient failure loops: the next pass waits or gives up by the new backoff.
                    Err(_) => {}
                },
            }
        }
    }

    /// Spawns the renewal `step` claimed (`minting` set). The task holds the state, not the credential; the last clone's drop aborts it, and its guard records that as a cancelled mint.
    fn renew(self: &Arc<Self>) {
        let inner = Arc::clone(self);
        let task = tokio::spawn(async move {
            // Its outcome is recorded in the state; a failure leaves the current token serving until it expires.
            let _ = inner.mint_recorded(false).await;
        });
        self.state().renewal = Some(task.abort_handle());
    }

    async fn token(self: &Arc<Self>) -> Result<String, AuthError> {
        self.acquire(true).await
    }

    async fn unauthorized(self: &Arc<Self>, rejected: &str) -> Result<(), AuthError> {
        {
            let mut s = self.state();
            if let Some(dead) = &s.dead {
                return Err(AuthError::terminal(dead.clone()));
            }
            if let Some(m) = &mut s.current {
                // Another caller's mint already replaced it: that token is this rejection's answer, so it takes the mark (#1375 F4).
                if m.token != rejected {
                    m.replaced_rejected = true;
                    return Ok(());
                }
                // A token minted to replace a rejected one was rejected too: another mint won't help this request. The next `token` mints afresh, after a backoff that doubles per rejection in a row (#1264).
                if m.replaced_rejected {
                    s.current = None;
                    s.rejections = s.rejections.saturating_add(1);
                    let wait = self.doubled(s.rejections).min(BACKOFF_MAX);
                    let at = Instant::now() + wait;
                    s.retry_at = Some(s.retry_at.map_or(at, |r| r.max(at)));
                    s.last_failure = "the server rejected a freshly minted token".into();
                    return Err(AuthError::terminal(
                        "the server rejected a freshly minted token",
                    ));
                }
            }
            s.current = None;
            // The next token installed answers this rejection, whichever caller's mint installs it (a renewal in flight included).
            s.answering_rejection = true;
        }
        // Not served: the request's retry asks `token` for it.
        self.acquire(false).await.map(drop)
    }
}

impl Credential for ClientCredentials {
    fn token(&self) -> BoxFuture<'_, Result<String, AuthError>> {
        Box::pin(self.inner.token())
    }
    fn unauthorized<'a>(&'a self, rejected: &'a str) -> BoxFuture<'a, Result<(), AuthError>> {
        Box::pin(self.inner.unauthorized(rejected))
    }
    fn changes(&self) -> Option<tokio::sync::watch::Receiver<u64>> {
        Some(self.inner.generation.subscribe())
    }
}
