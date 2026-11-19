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
    /// The token for the next request.
    fn token(&self) -> BoxFuture<'_, Result<String, AuthError>>;
    /// The server answered 401 to `rejected`. Return `Ok` once a fresh token is ready (the request is retried once), or an error to fail it as `Unauthorized`.
    fn unauthorized<'a>(&'a self, rejected: &'a str) -> BoxFuture<'a, Result<(), AuthError>>;
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
            Err(AuthError(
                "the server rejected the static bearer token".into(),
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

/// A service credential (#270): a `svc_` client ID and its secret, which mint run tokens with the OAuth client-credentials grant, no browser.
///
/// It reads the server's authorization-server metadata once (RFC 8414) and refuses metadata that names another issuer, so the caller pins the issuer; then it posts `grant_type=client_credentials` with the secret in the Basic header (`client_secret_basic`) and `resource` set to the MCP endpoint. A token is cached and re-minted at 80% of its lifetime, and once more when the server rejects it. A capacity refusal (`slow_down`, 429), a 5xx or an unreachable server backs off, the current token serving while it lasts; `invalid_client` (a revoked or expired credential or secret, a disabled service) and any other refusal are terminal: every later call fails without asking the server again.
///
/// Cheap to clone: clones share one cache, so several `Client`s on one credential share its token (the server caps mints per credential per minute). The secret never appears in `Debug` output or in an error.
#[derive(Clone)]
pub struct ClientCredentials {
    inner: Arc<Inner>,
}

struct Inner {
    http: reqwest::Client,
    issuer: String,
    resource: String,
    client_id: String,
    secret: Secret,
    backoff_unit: Duration,
    state: tokio::sync::Mutex<State>,
}

/// The secret: never printed.
struct Secret(String);

#[derive(Default)]
struct State {
    endpoints: Option<Endpoints>,
    current: Option<Minted>,
    /// Set by a terminal refusal; every later call fails with it.
    dead: Option<String>,
    /// While set and in the future, no mint is attempted.
    retry_at: Option<Instant>,
    failures: u32,
    last_failure: String,
}

struct Endpoints {
    token: reqwest::Url,
    revocation: Option<reqwest::Url>,
}

struct Minted {
    token: String,
    expires_at: Instant,
    renew_at: Instant,
    /// Minted to replace a token the server rejected: a rejection of this one is not answered with another mint.
    replaced_rejected: bool,
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
    fn message(self) -> String {
        match self {
            Self::Transient { message, .. } | Self::Terminal(message) => message,
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
        Ok(Self {
            inner: Arc::new(Inner {
                http,
                issuer: issuer.to_owned(),
                resource: endpoint.to_owned(),
                client_id,
                secret: Secret(secret),
                backoff_unit: BACKOFF_UNIT,
                state: tokio::sync::Mutex::default(),
            }),
        })
    }

    #[cfg(test)]
    pub(crate) fn with_backoff_unit(mut self, unit: Duration) -> Self {
        Arc::get_mut(&mut self.inner)
            .expect("set before any clone")
            .backoff_unit = unit;
        self
    }

    /// Revokes the current token (RFC 7009, at the server's revocation endpoint with the same Basic auth), so a run's token ends when the run does: its sessions are refused on their next call. Call it after `Session::end`. With no current token nothing is sent; a later `token` mints a new one.
    pub async fn revoke(&self) -> Result<(), Error> {
        let mut s = self.inner.state.lock().await;
        let Some(current) = s.current.take() else {
            return Ok(());
        };
        let endpoints = self
            .inner
            .endpoints(&mut s)
            .await
            .map_err(|e| Error::Auth(AuthError(e.message())))?;
        let Some(url) = endpoints.revocation.clone() else {
            return Err(Error::Auth(AuthError(
                "the server's metadata names no revocation endpoint".into(),
            )));
        };
        let response = self
            .inner
            .post(url, format!("token={}", form_encode(&current.token)))
            .send()
            .await
            .map_err(|e| Error::Unreachable(format!("revoke: {}", e.without_url())))?;
        if !response.status().is_success() {
            return Err(Error::Auth(AuthError(format!(
                "revoke answered HTTP {}",
                response.status().as_u16()
            ))));
        }
        Ok(())
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

    /// The metadata's endpoints, read once.
    async fn endpoints<'s>(&self, s: &'s mut State) -> Result<&'s Endpoints, MintError> {
        if s.endpoints.is_none() {
            s.endpoints = Some(self.discover().await?);
        }
        Ok(s.endpoints.as_ref().expect("set above"))
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

    async fn mint(&self, s: &mut State) -> Result<Minted, MintError> {
        let url = self.endpoints(s).await?.token.clone();
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
        let lifetime = Duration::from_secs(issued.expires_in);
        Ok(Minted {
            token: issued.access_token,
            expires_at: started + lifetime,
            renew_at: started + lifetime.mul_f64(RENEW_AT),
            replaced_rejected: false,
        })
    }

    /// Mints, recording the outcome: a terminal error kills the credential, a transient one schedules the next attempt.
    async fn mint_recorded(&self, s: &mut State) -> Result<(), AuthError> {
        match self.mint(s).await {
            Ok(minted) => {
                s.current = Some(minted);
                s.failures = 0;
                s.retry_at = None;
                Ok(())
            }
            Err(MintError::Terminal(message)) => {
                let message = format!("the service credential is refused: {message}");
                s.dead = Some(message.clone());
                s.current = None;
                Err(AuthError(message))
            }
            Err(MintError::Transient {
                message,
                retry_after,
            }) => {
                s.failures = s.failures.saturating_add(1);
                let doubled = self
                    .backoff_unit
                    .saturating_mul(1 << s.failures.saturating_sub(1).min(16));
                let wait = doubled
                    .max(retry_after.unwrap_or_default())
                    .min(BACKOFF_MAX);
                s.retry_at = Some(Instant::now() + wait);
                s.last_failure = message.clone();
                Err(AuthError(message))
            }
        }
    }

    /// A mint now, waiting out a short backoff first; a longer one fails at once with the last failure.
    async fn mint_soon(&self, s: &mut State) -> Result<(), AuthError> {
        loop {
            if let Some(dead) = &s.dead {
                return Err(AuthError(dead.clone()));
            }
            if let Some(at) = s.retry_at {
                let wait = at.saturating_duration_since(Instant::now());
                if wait > WAIT_MAX {
                    return Err(AuthError(format!(
                        "minting a token is backing off for {wait:?} after: {}",
                        s.last_failure
                    )));
                }
                tokio::time::sleep(wait).await;
            }
            // A transient failure loops: the next pass waits or gives up by the new backoff.
            if self.mint_recorded(s).await.is_ok() {
                return Ok(());
            }
        }
    }

    async fn token(&self) -> Result<String, AuthError> {
        // Held across the mint: concurrent callers share one mint and its token.
        let mut s = self.state.lock().await;
        if let Some(dead) = &s.dead {
            return Err(AuthError(dead.clone()));
        }
        let now = Instant::now();
        if let Some(m) = &s.current {
            if now < m.renew_at {
                return Ok(m.token.clone());
            }
            // Due for renewal but still valid: it serves when a backoff holds the mint or the mint fails transiently.
            if now < m.expires_at {
                let token = m.token.clone();
                if s.retry_at.is_some_and(|at| now < at) {
                    return Ok(token);
                }
                return match self.mint_recorded(&mut s).await {
                    Ok(()) => Ok(s.current.as_ref().expect("minted").token.clone()),
                    Err(e) if s.dead.is_some() => Err(e),
                    Err(_) => Ok(token),
                };
            }
        }
        s.current = None;
        self.mint_soon(&mut s).await?;
        Ok(s.current.as_ref().expect("minted").token.clone())
    }

    async fn unauthorized(&self, rejected: &str) -> Result<(), AuthError> {
        let mut s = self.state.lock().await;
        if let Some(dead) = &s.dead {
            return Err(AuthError(dead.clone()));
        }
        if let Some(m) = &s.current {
            // Another request already replaced it.
            if m.token != rejected {
                return Ok(());
            }
            // A token minted to replace a rejected one was rejected too: another mint won't help this request. The next `token` mints afresh.
            if m.replaced_rejected {
                s.current = None;
                return Err(AuthError(
                    "the server rejected a freshly minted token".into(),
                ));
            }
        }
        s.current = None;
        self.mint_soon(&mut s).await?;
        s.current.as_mut().expect("minted").replaced_rejected = true;
        Ok(())
    }
}

impl Credential for ClientCredentials {
    fn token(&self) -> BoxFuture<'_, Result<String, AuthError>> {
        Box::pin(self.inner.token())
    }
    fn unauthorized<'a>(&'a self, rejected: &'a str) -> BoxFuture<'a, Result<(), AuthError>> {
        Box::pin(self.inner.unauthorized(rejected))
    }
}
