//! One HTTP connection to the hosted MCP endpoint, in one role (#929; `docs/sdk-rust.md` §1): the envelope, JSON-or-SSE responses, the 429 rule, timeouts and error classes.

use crate::credential::Credential;
use crate::envelope::{
    ClientInfo, DeliveryMode, PROTOCOL_VERSION, encode_header_value, mcp_name, request_meta,
};
use crate::error::{AuthError, Error, domain_code, server_text};
use crate::sse::SseParser;
use bytes::Bytes;
use futures_util::{Stream, StreamExt};
use reqwest::StatusCode;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE, HeaderValue};
use serde_json::{Map, Value, json};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::OnceCell;
use tokio_util::sync::CancellationToken;

/// The transport's and the delivery stream's time limits (#929; `docs/sdk-rust.md`). Fixed in a release; tests shorten them.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Timeouts {
    /// An ordinary request attempt, body included; also bounds a credential's `token` and `unauthorized`.
    pub request: Duration,
    /// A listen stream's acknowledgement.
    pub listen_ack: Duration,
    /// An open listen stream with no bytes for this long is dead: three missed 5 s keepalives.
    pub listen_idle: Duration,
    /// The delivery stream renews its lease this often, idle or while an item is handed out (the server's TTL is 30 s).
    pub renew: Duration,
    /// A reopen waits `min(backoff_max, backoff_unit * 2^n)` after its n-th outage or failure in a row.
    pub backoff_unit: Duration,
    pub backoff_max: Duration,
    /// An admission-throttled reopen waits at least `min(backoff_max, throttle_unit * 2^n)`.
    pub throttle_unit: Duration,
}

impl Default for Timeouts {
    fn default() -> Self {
        Self {
            request: Duration::from_secs(10),
            listen_ack: Duration::from_secs(10),
            listen_idle: Duration::from_secs(15),
            renew: Duration::from_secs(10),
            backoff_unit: Duration::from_millis(250),
            backoff_max: Duration::from_secs(8),
            throttle_unit: Duration::from_millis(500),
        }
    }
}
/// Admission-throttled attempts before `RateLimited`.
const ADMISSION_ATTEMPTS: u32 = 8;
/// A refused connect's body is kept up to this many bytes before the text cap.
const REFUSAL_BODY_LIMIT: usize = 4096;
/// A JSON-RPC response larger than this is refused.
pub(crate) const MAX_RESPONSE: usize = 16 << 20;
/// A connect that hasn't finished by then is unreachable: shorter than the request timeout, so a blackholed endpoint fails as a connect error (never sent) rather than a request timeout (outcome unknown for a write).
pub(crate) const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Role {
    /// The agent tool surface.
    Native,
    /// The session's lease, inbox and subscriber tools (`X-Grayboard-Client: subscriber`).
    Subscriber,
}

/// What `server/discover` reported.
#[derive(Debug, Clone)]
pub struct Discovery {
    pub instructions: Option<String>,
    pub capabilities: Value,
}

/// The shared parts every connection of a client uses.
pub(crate) struct Shared {
    pub http: reqwest::Client,
    pub endpoint: reqwest::Url,
    pub credential: Arc<dyn Credential>,
    pub info: ClientInfo,
    pub timeouts: Timeouts,
}

pub(crate) struct Connection {
    pub(crate) shared: Arc<Shared>,
    role: Role,
    session: String,
    delivery: Option<DeliveryMode>,
    lease: Mutex<Option<String>>,
    pub(crate) cancel: CancellationToken,
    next_id: AtomicU64,
    discovered: OnceCell<Discovery>,
}

/// A notification from a listen stream.
#[derive(Debug, Clone)]
pub struct Notification {
    pub method: String,
    pub params: Value,
}

impl Connection {
    pub(crate) fn new(
        shared: Arc<Shared>,
        role: Role,
        session: String,
        delivery: Option<DeliveryMode>,
        cancel: CancellationToken,
    ) -> Self {
        Self {
            shared,
            role,
            session,
            delivery,
            lease: Mutex::new(None),
            cancel,
            next_id: AtomicU64::new(1),
            discovered: OnceCell::new(),
        }
    }

    /// Sets or clears the lease capability sent as `X-Grayboard-Lease` (subscriber role).
    pub(crate) fn set_lease(&self, capability: Option<String>) {
        *self.lease.lock().unwrap_or_else(|e| e.into_inner()) = capability;
    }

    /// `server/discover`, once per connection: refuses a server without this crate's protocol, and surfaces a refused declaration or session key as `ConnectRefused`.
    pub(crate) async fn discover(&self) -> Result<&Discovery, Error> {
        self.discovered
            .get_or_try_init(|| async {
                let result = self.exchange("server/discover", json!({})).await?;
                let offered: Vec<String> = result
                    .get("supportedVersions")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect()
                    })
                    .unwrap_or_default();
                if !offered.iter().any(|v| v == PROTOCOL_VERSION) {
                    return Err(Error::Incompatible {
                        expected: PROTOCOL_VERSION,
                        offered: offered.iter().take(16).map(|v| server_text(v)).collect(),
                    });
                }
                Ok(Discovery {
                    instructions: result
                        .get("instructions")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    capabilities: result.get("capabilities").cloned().unwrap_or(Value::Null),
                })
            })
            .await
    }

    /// One request after discovery; returns its `result`.
    pub(crate) async fn request(&self, method: &str, params: Value) -> Result<Value, Error> {
        self.discover().await?;
        self.exchange(method, params).await
    }

    fn body(&self, id: Option<u64>, method: &str, mut params: Value) -> Value {
        let mut meta = request_meta(&self.session, self.delivery.as_ref(), &self.shared.info);
        if let Some(Value::Object(own)) = params.get("_meta") {
            meta.extend(own.clone());
        }
        if !params.is_object() {
            params = Value::Object(Map::new());
        }
        params["_meta"] = Value::Object(meta);
        let mut body = json!({"jsonrpc": "2.0", "method": method, "params": params});
        if let Some(id) = id {
            body["id"] = json!(id);
        }
        body
    }

    fn post(
        &self,
        token: &str,
        method: &str,
        body: &Value,
    ) -> Result<reqwest::RequestBuilder, Error> {
        // Checked here, not deferred to `send`: reqwest would surface a bad value as a send error, classed like a lost request.
        let mut authorization =
            HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| {
                Error::Auth(AuthError::terminal(
                    "the credential's token is not a valid header value",
                ))
            })?;
        authorization.set_sensitive(true);
        let mut rb = self
            .shared
            .http
            .post(self.shared.endpoint.clone())
            .header("accept", "application/json, text/event-stream")
            .header(CONTENT_TYPE, "application/json")
            .header(AUTHORIZATION, authorization)
            .header("mcp-protocol-version", PROTOCOL_VERSION);
        // Requests carry Mcp-Method; a notification (no id) doesn't, as the reference client sends it (sdk/rust/schema/wire/requests.json).
        if body.get("id").is_some() {
            rb = rb.header("mcp-method", method);
        }
        if let Some(name) = body.get("params").and_then(|p| mcp_name(method, p)) {
            let value = HeaderValue::from_str(&encode_header_value(name))
                .map_err(|e| Error::InvalidResponse(format!("unencodable Mcp-Name: {e}")))?;
            rb = rb.header("mcp-name", value);
        }
        if self.role == Role::Subscriber {
            rb = rb.header("x-grayboard-client", "subscriber");
            if let Some(lease) = self
                .lease
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .as_deref()
            {
                let mut lease = HeaderValue::from_str(lease).map_err(|_| {
                    Error::InvalidArgument(
                        "the lease capability is not a valid header value".into(),
                    )
                })?;
                lease.set_sensitive(true);
                rb = rb.header("x-grayboard-lease", lease);
            }
        }
        Ok(rb.body(serde_json::to_vec(body).expect("a JSON value serializes")))
    }

    /// Sends with the 429 and 401 rules, returning a 2xx response. `timeout` bounds each attempt until its body is read; `None` for a stream. The credential's calls are bounded by the request timeout either way.
    async fn send(
        &self,
        method: &str,
        body: &Value,
        timeout: Option<Duration>,
    ) -> Result<reqwest::Response, Error> {
        let write = method == "tools/call";
        let mut reauthorized = false;
        let mut attempt = 0;
        loop {
            let limit = self.shared.timeouts.request;
            let token = tokio::time::timeout(limit, self.shared.credential.token())
                .await
                .map_err(|_| {
                    Error::Unreachable(format!("the credential gave no token within {limit:?}"))
                })?
                .map_err(credential_error)?;
            let mut rb = self.post(&token, method, body)?;
            if let Some(t) = timeout {
                rb = rb.timeout(t);
            }
            let response = tokio::select! {
                _ = self.cancel.cancelled() => return Err(Error::Cancelled),
                r = rb.send() => r.map_err(|e| transport_error(&e, write))?,
            };
            let status = response.status();
            if status.is_success() {
                return Ok(response);
            }
            match status {
                StatusCode::UNAUTHORIZED if !reauthorized => {
                    reauthorized = true;
                    tokio::time::timeout(limit, self.shared.credential.unauthorized(&token))
                        .await
                        .map_err(|_| {
                            Error::Unreachable(format!(
                                "the credential did not replace the token within {limit:?}"
                            ))
                        })?
                        .map_err(|e| {
                            if e.retryable {
                                credential_error(e)
                            } else {
                                Error::Unauthorized(e.message)
                            }
                        })?;
                    continue;
                }
                StatusCode::UNAUTHORIZED => {
                    return Err(Error::Unauthorized(
                        "the server rejected the replacement token".into(),
                    ));
                }
                StatusCode::FORBIDDEN => return Err(Error::InsufficientScope),
                StatusCode::BAD_GATEWAY
                | StatusCode::SERVICE_UNAVAILABLE
                | StatusCode::GATEWAY_TIMEOUT => {
                    // A gateway can answer after the server acted: a write's outcome is unknown.
                    let text = format!("HTTP {}", status.as_u16());
                    return Err(if write {
                        Error::OutcomeUnknown(text)
                    } else {
                        Error::Unreachable(text)
                    });
                }
                _ => {}
            }
            let text = limited_text(response, REFUSAL_BODY_LIMIT).await;
            if status == StatusCode::TOO_MANY_REQUESTS {
                let data = serde_json::from_str::<Value>(&text)
                    .ok()
                    .and_then(|v| v.pointer("/error/data").cloned());
                let retry = data
                    .as_ref()
                    .filter(|d| d.get("code").and_then(Value::as_str) == Some("rate_limited"))
                    .and_then(|d| d.get("retry_after_ms"))
                    .and_then(Value::as_f64)
                    .filter(|ms| ms.is_finite() && *ms > 0.0);
                let Some(ms) = retry else {
                    return Err(Error::Capacity(server_text(&text)));
                };
                let wait = Duration::from_millis(ms.ceil() as u64);
                attempt += 1;
                if attempt >= ADMISSION_ATTEMPTS {
                    return Err(Error::RateLimited { retry_after: wait });
                }
                tokio::select! {
                    _ = self.cancel.cancelled() => return Err(Error::Cancelled),
                    _ = tokio::time::sleep(wait) => continue,
                }
            }
            if method == "server/discover" {
                return Err(Error::ConnectRefused {
                    status: status.as_u16(),
                    body: server_text(&text),
                });
            }
            if let Ok(message) = serde_json::from_str::<Value>(&text)
                && let Some(error) = message.get("error")
            {
                return Err(rpc_error(error));
            }
            return Err(Error::InvalidResponse(format!(
                "HTTP {}: {}",
                status.as_u16(),
                server_text(&text)
            )));
        }
    }

    /// A request and its matching response, JSON or SSE. Each attempt (a 429 retry is a new one) must finish, body included, within the request timeout.
    async fn exchange(&self, method: &str, params: Value) -> Result<Value, Error> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let body = self.body(Some(id), method, params);
        let write = method == "tools/call";
        let work = async {
            let response = self
                .send(method, &body, Some(self.shared.timeouts.request))
                .await?;
            let sse = is_sse(&response);
            let mut stream = response.bytes_stream();
            if sse {
                let mut parser = SseParser::default();
                while let Some(chunk) = stream.next().await {
                    let chunk = chunk.map_err(|e| transport_error(&e, write))?;
                    for event in parser.feed(&chunk)? {
                        let message: Value = serde_json::from_str(&event.data)
                            .map_err(|e| Error::InvalidResponse(format!("event data: {e}")))?;
                        if message.get("id").and_then(Value::as_u64) == Some(id) {
                            return result_of(message);
                        }
                    }
                }
                Err(if write {
                    Error::OutcomeUnknown("stream closed before the result".into())
                } else {
                    Error::Unreachable("stream closed before the result".into())
                })
            } else {
                let mut buf = Vec::new();
                while let Some(chunk) = stream.next().await {
                    let chunk = chunk.map_err(|e| transport_error(&e, write))?;
                    if buf.len() + chunk.len() > MAX_RESPONSE {
                        return Err(Error::InvalidResponse("response too large".into()));
                    }
                    buf.extend_from_slice(&chunk);
                }
                let message: Value = serde_json::from_slice(&buf)
                    .map_err(|e| Error::InvalidResponse(format!("response body: {e}")))?;
                if message.get("id").and_then(Value::as_u64) != Some(id) {
                    return Err(Error::InvalidResponse(
                        "response id does not match the request".into(),
                    ));
                }
                result_of(message)
            }
        };
        tokio::select! {
            _ = self.cancel.cancelled() => Err(Error::Cancelled),
            r = work => r,
        }
    }

    /// A notification (no id): the server answers 202.
    pub(crate) async fn notify(&self, method: &str, params: Value) -> Result<(), Error> {
        let body = self.body(None, method, params);
        let work = async {
            let response = self
                .send(method, &body, Some(self.shared.timeouts.request))
                .await?;
            if response.status() != StatusCode::ACCEPTED {
                return Err(Error::InvalidResponse(format!(
                    "notification answered HTTP {}",
                    response.status().as_u16()
                )));
            }
            Ok(())
        };
        work.await
    }

    /// `subscriptions/listen` on `uris`. Resolves once the server acknowledges and honors every URI.
    pub(crate) async fn listen(self: &Arc<Self>, uris: &[&str]) -> Result<Subscription, Error> {
        self.discover().await?;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let body = self.body(
            Some(id),
            "subscriptions/listen",
            json!({"notifications": {"resourceSubscriptions": uris}}),
        );
        let open = async {
            let response = self.send("subscriptions/listen", &body, None).await?;
            if !is_sse(&response) {
                // A JSON answer to a listen is its refusal.
                let text = limited_text(response, MAX_RESPONSE).await;
                let message: Value = serde_json::from_str(&text).map_err(|_| {
                    Error::InvalidResponse(format!("listen answered: {}", server_text(&text)))
                })?;
                return Err(match result_of(message) {
                    Err(e) => e,
                    Ok(_) => Error::InvalidResponse("listen answered without a stream".into()),
                });
            }
            let mut sub = Subscription {
                conn: Arc::clone(self),
                id,
                stream: Box::pin(response.bytes_stream()),
                parser: SseParser::default(),
                pending: Vec::new(),
                closed: false,
            };
            let ack = loop {
                let message = sub.next_message().await?.ok_or_else(|| {
                    Error::Unreachable("listen stream closed before its acknowledgement".into())
                })?;
                if message.get("id").and_then(Value::as_u64) == Some(id) {
                    // A response to the listen request before any acknowledgement ends it.
                    result_of(message)?;
                    return Err(Error::InvalidResponse(
                        "listen ended before its acknowledgement".into(),
                    ));
                }
                if message.get("method").and_then(Value::as_str)
                    == Some("notifications/subscriptions/acknowledged")
                {
                    break message;
                }
            };
            let honored: Vec<&str> = ack
                .pointer("/params/notifications/resourceSubscriptions")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            if let Some(missing) = uris.iter().find(|u| !honored.contains(u)) {
                let missing = (*missing).to_owned();
                sub.close().await;
                return Err(Error::InvalidResponse(format!(
                    "server did not acknowledge the {missing} subscription"
                )));
            }
            Ok(sub)
        };
        tokio::select! {
            _ = self.cancel.cancelled() => Err(Error::Cancelled),
            r = tokio::time::timeout(self.shared.timeouts.listen_ack, open) => r.unwrap_or_else(|_| Err(Error::Unreachable(format!("listen not acknowledged within {:?}", self.shared.timeouts.listen_ack)))),
        }
    }
}

/// An open listen stream. It never reconnects on its own: a closed stream is `Ok(None)` from `next`, and the caller reopens.
pub struct Subscription {
    conn: Arc<Connection>,
    id: u64,
    stream: Pin<Box<dyn Stream<Item = reqwest::Result<Bytes>> + Send>>,
    parser: SseParser,
    pending: Vec<Value>,
    closed: bool,
}

impl Subscription {
    async fn next_message(&mut self) -> Result<Option<Value>, Error> {
        loop {
            if !self.pending.is_empty() {
                return Ok(Some(self.pending.remove(0)));
            }
            if self.closed {
                return Ok(None);
            }
            let chunk = tokio::select! {
                _ = self.conn.cancel.cancelled() => return Err(Error::Cancelled),
                r = tokio::time::timeout(self.conn.shared.timeouts.listen_idle, self.stream.next()) => match r {
                    Err(_) => return Err(Error::Unreachable(format!("listen stream idle for {:?}", self.conn.shared.timeouts.listen_idle))),
                    Ok(None) => { self.closed = true; return Ok(None) }
                    Ok(Some(chunk)) => chunk.map_err(|e| Error::Unreachable(format!("listen stream: {e}")))?,
                },
            };
            for event in self.parser.feed(&chunk)? {
                let message: Value = serde_json::from_str(&event.data)
                    .map_err(|e| Error::InvalidResponse(format!("event data: {e}")))?;
                self.pending.push(message);
            }
        }
    }

    /// The next notification, or `Ok(None)` once the server closes the stream. Keepalives reset the idle timeout and are not returned.
    pub async fn next(&mut self) -> Result<Option<Notification>, Error> {
        while let Some(message) = self.next_message().await? {
            if message.get("id").and_then(Value::as_u64) == Some(self.id) {
                // The server ended the listen with a response.
                self.closed = true;
                result_of(message)?;
                return Ok(None);
            }
            if let Some(method) = message.get("method").and_then(Value::as_str) {
                return Ok(Some(Notification {
                    method: method.to_owned(),
                    params: message.get("params").cloned().unwrap_or(Value::Null),
                }));
            }
        }
        Ok(None)
    }

    /// Closes the stream: `notifications/cancelled` for the listen, best effort, then drops the connection.
    pub async fn close(mut self) {
        self.closed = true;
        let _ = self
            .conn
            .notify("notifications/cancelled", json!({"requestId": self.id}))
            .await;
    }
}

fn is_sse(response: &reqwest::Response) -> bool {
    response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            v.trim_start()
                .to_ascii_lowercase()
                .starts_with("text/event-stream")
        })
}

/// Up to `limit` bytes of a response body, lossily decoded.
async fn limited_text(response: reqwest::Response, limit: usize) -> String {
    let mut buf = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(Ok(chunk)) = stream.next().await {
        let room = limit.saturating_sub(buf.len());
        buf.extend_from_slice(&chunk[..chunk.len().min(room)]);
        if buf.len() >= limit {
            break;
        }
    }
    String::from_utf8_lossy(&buf).into_owned()
}

/// A credential failure before anything was sent: a transient one is `Unreachable`, so the delivery stream backs off and reopens rather than stopping; a terminal one is `Auth`.
fn credential_error(e: AuthError) -> Error {
    if e.retryable {
        Error::Unreachable(format!("credential: {}", e.message))
    } else {
        Error::Auth(e)
    }
}

fn transport_error(error: &reqwest::Error, write: bool) -> Error {
    let text = server_text(&error.to_string());
    // Refused before anything was sent: a local fault, never retried as unreachable.
    if error.is_builder() {
        return Error::InvalidArgument(text);
    }
    // A connect failure never reached the server, so even a write is safe to report as unreachable.
    if error.is_connect() || !write {
        Error::Unreachable(text)
    } else {
        Error::OutcomeUnknown(text)
    }
}

fn rpc_error(error: &Value) -> Error {
    let code = error.get("code").and_then(Value::as_i64).unwrap_or(0);
    let message = server_text(error.get("message").and_then(Value::as_str).unwrap_or(""));
    if code == -32020 {
        return Error::HeaderMismatch(message);
    }
    let data_code = error
        .pointer("/data/code")
        .and_then(Value::as_str)
        .filter(|c| domain_code(c))
        .map(str::to_owned);
    Error::Protocol {
        code,
        message,
        data_code,
    }
}

fn result_of(mut message: Value) -> Result<Value, Error> {
    if let Some(error) = message.get("error") {
        return Err(rpc_error(error));
    }
    message
        .get_mut("result")
        .map(Value::take)
        .ok_or_else(|| Error::InvalidResponse("response has neither result nor error".into()))
}
