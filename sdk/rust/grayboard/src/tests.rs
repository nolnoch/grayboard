//! Transport tests against a scripted HTTP/1.1 endpoint: one handler decides each reply, and every request is recorded.

use crate::credential::Credential;
use crate::error::AuthError;
use crate::transport::Timeouts;
use crate::{Client, ClientInfo, DeliveryMode, Error, StaticBearer};
use futures_util::future::BoxFuture;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Debug, Clone)]
pub(crate) struct Req {
    pub(crate) headers: HashMap<String, String>,
    pub(crate) body: Value,
}

impl Req {
    pub(crate) fn method(&self) -> &str {
        self.body["method"].as_str().unwrap_or("")
    }
    pub(crate) fn id(&self) -> Value {
        self.body["id"].clone()
    }
}

/// A reply: status, headers, then body chunks, each after its delay. `hold` keeps the connection open afterwards for that long.
pub(crate) struct Reply {
    status: u16,
    headers: Vec<(&'static str, String)>,
    chunks: Vec<(Duration, Vec<u8>)>,
    hold: Duration,
    /// After `chunks`, each chunk sent here is written as it comes; the connection closes when every sender is gone.
    live: Option<tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>>,
}

impl Reply {
    pub(crate) fn json(value: Value) -> Self {
        Self {
            status: 200,
            headers: vec![("content-type", "application/json".into())],
            chunks: vec![(Duration::ZERO, value.to_string().into_bytes())],
            hold: Duration::ZERO,
            live: None,
        }
    }
    pub(crate) fn result(req: &Req, result: Value) -> Self {
        Self::json(json!({"jsonrpc": "2.0", "id": req.id(), "result": result}))
    }
    pub(crate) fn status(status: u16, body: &str) -> Self {
        Self {
            status,
            headers: vec![("content-type", "text/plain".into())],
            chunks: vec![(Duration::ZERO, body.as_bytes().to_vec())],
            hold: Duration::ZERO,
            live: None,
        }
    }
    pub(crate) fn sse(events: Vec<(Duration, String)>, hold: Duration) -> Self {
        Self {
            status: 200,
            headers: vec![("content-type", "text/event-stream".into())],
            chunks: events
                .into_iter()
                .map(|(d, e)| (d, e.into_bytes()))
                .collect(),
            hold,
            live: None,
        }
    }
    pub(crate) fn with_status(mut self, status: u16) -> Self {
        self.status = status;
        self
    }
    /// An event stream: `first`, then whatever `live` sends, until its senders are gone.
    pub(crate) fn live(
        first: Vec<String>,
        live: tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>,
    ) -> Self {
        let mut reply = Self::sse(
            first.into_iter().map(|e| (Duration::ZERO, e)).collect(),
            Duration::ZERO,
        );
        reply.live = Some(live);
        reply
    }
}

pub(crate) fn event(message: Value) -> String {
    format!("event: message\ndata: {message}\n\n")
}

fn discover(req: &Req) -> Reply {
    Reply::result(
        req,
        json!({"supportedVersions": ["2026-07-28"], "capabilities": {"tools": {}}, "instructions": "hello", "resultType": "complete"}),
    )
}

type Handler = Arc<dyn Fn(&Req, usize) -> Reply + Send + Sync>;

pub(crate) struct Fake {
    pub(crate) url: String,
    requests: Arc<Mutex<Vec<Req>>>,
}

impl Fake {
    /// `handler` gets each non-discover request and its index among them; discover is answered as a current server would unless `handle_discover`.
    pub(crate) async fn start(
        handle_discover: bool,
        handler: impl Fn(&Req, usize) -> Reply + Send + Sync + 'static,
    ) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        let requests: Arc<Mutex<Vec<Req>>> = Arc::default();
        let handler: Handler = Arc::new(handler);
        let counter = Arc::new(AtomicUsize::new(0));
        let recorded = Arc::clone(&requests);
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let (handler, recorded, counter) = (
                    Arc::clone(&handler),
                    Arc::clone(&recorded),
                    Arc::clone(&counter),
                );
                tokio::spawn(async move {
                    let Some(req) = read_request(&mut socket).await else {
                        return;
                    };
                    recorded.lock().unwrap().push(req.clone());
                    let reply = if req.method() == "server/discover" && !handle_discover {
                        discover(&req)
                    } else {
                        let n = counter.fetch_add(1, Ordering::SeqCst);
                        handler(&req, n)
                    };
                    let mut head = format!("HTTP/1.1 {} X\r\nconnection: close\r\n", reply.status);
                    for (k, v) in &reply.headers {
                        head.push_str(&format!("{k}: {v}\r\n"));
                    }
                    head.push_str("\r\n");
                    if socket.write_all(head.as_bytes()).await.is_err() {
                        return;
                    }
                    for (delay, chunk) in reply.chunks {
                        tokio::time::sleep(delay).await;
                        if socket.write_all(&chunk).await.is_err() {
                            return;
                        }
                    }
                    if let Some(mut live) = reply.live {
                        while let Some(chunk) = live.recv().await {
                            if socket.write_all(&chunk).await.is_err() {
                                return;
                            }
                        }
                    }
                    tokio::time::sleep(reply.hold).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        Self { url, requests }
    }

    pub(crate) fn requests(&self) -> Vec<Req> {
        self.requests.lock().unwrap().clone()
    }
    pub(crate) fn calls(&self, method: &str) -> Vec<Req> {
        self.requests()
            .into_iter()
            .filter(|r| r.method() == method)
            .collect()
    }
}

async fn read_request(socket: &mut tokio::net::TcpStream) -> Option<Req> {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    let header_end = loop {
        let n = socket.read(&mut tmp).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
    };
    let head = String::from_utf8_lossy(&buf[..header_end]).into_owned();
    let mut headers = HashMap::new();
    for line in head.lines().skip(1) {
        if let Some((k, v)) = line.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_owned());
        }
    }
    let len: usize = headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    while buf.len() < header_end + len {
        let n = socket.read(&mut tmp).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&tmp[..n]);
    }
    let body = serde_json::from_slice(&buf[header_end..header_end + len]).unwrap_or(Value::Null);
    Some(Req { headers, body })
}

pub(crate) fn fast() -> Timeouts {
    Timeouts {
        request: Duration::from_millis(500),
        listen_ack: Duration::from_millis(500),
        listen_idle: Duration::from_millis(1500),
        renew: Duration::from_secs(10),
        backoff_unit: Duration::from_millis(5),
        backoff_max: Duration::from_millis(40),
        throttle_unit: Duration::from_millis(5),
    }
}

pub(crate) fn client(fake: &Fake) -> Client {
    Client::new(
        &fake.url,
        StaticBearer::new("tok-1"),
        ClientInfo::new("rust-sdk-test", "0.0.1"),
    )
    .unwrap()
    .with_timeouts(fast())
}

pub(crate) fn session(fake: &Fake) -> crate::Session {
    client(fake).session("s-1", DeliveryMode::push("rust-sdk-test").unwrap())
}

fn ok_text(req: &Req) -> Reply {
    Reply::result(req, json!({"content": [{"type": "text", "text": "ok"}]}))
}

#[tokio::test]
async fn envelope_headers_and_meta() {
    let fake = Fake::start(false, |req, _| ok_text(req)).await;
    let s = session(&fake);
    let r = s
        .call_raw("board_post", json!({"board": "e2e", "body": "hi"}))
        .await
        .unwrap();
    assert_eq!(r.texts().collect::<Vec<_>>(), ["ok"]);
    s.call_subscriber("whoami", json!({})).await.unwrap_err(); // "ok" is not JSON: InvalidResponse
    s.read_resource("grayboard://inbox").await.unwrap_err();

    let reqs = fake.requests();
    // One discover per connection: native and subscriber.
    assert_eq!(fake.calls("server/discover").len(), 2);
    for req in &reqs {
        let h = &req.headers;
        assert_eq!(h["accept"], "application/json, text/event-stream");
        assert_eq!(h["content-type"], "application/json");
        assert_eq!(h["authorization"], "Bearer tok-1");
        assert_eq!(h["mcp-protocol-version"], "2026-07-28");
        assert_eq!(h["mcp-method"], req.method());
        let meta = &req.body["params"]["_meta"];
        assert_eq!(
            meta["io.modelcontextprotocol/protocolVersion"],
            "2026-07-28"
        );
        assert_eq!(
            meta["io.modelcontextprotocol/clientInfo"],
            json!({"name": "rust-sdk-test", "version": "0.0.1"})
        );
        assert_eq!(
            meta["io.modelcontextprotocol/clientCapabilities"],
            json!({})
        );
        assert_eq!(meta["io.github.nolnoch.grayboard/sessionID"], "s-1");
        assert_eq!(
            meta["io.github.nolnoch.grayboard/delivery"],
            json!({"mode": "push", "source": "rust-sdk-test"})
        );
        assert_eq!(req.body["jsonrpc"], "2.0");
    }
    let post = &fake.calls("tools/call")[0];
    assert_eq!(post.headers["mcp-name"], "board_post");
    assert!(!post.headers.contains_key("x-grayboard-client"));
    assert_eq!(
        post.body["params"]["arguments"],
        json!({"board": "e2e", "body": "hi"})
    );
    let whoami = &fake.calls("tools/call")[1];
    assert_eq!(whoami.headers["x-grayboard-client"], "subscriber");
    assert_eq!(whoami.headers["mcp-name"], "whoami");
    let read = &fake.calls("resources/read")[0];
    assert_eq!(read.headers["mcp-name"], "grayboard://inbox");
    assert!(
        !fake.calls("server/discover")[0]
            .headers
            .contains_key("mcp-name")
    );
}

#[tokio::test]
async fn lease_header_on_subscriber_requests_only_once_set() {
    let fake = Fake::start(false, |req, _| {
        Reply::result(req, json!({"content": [{"type": "text", "text": "{}"}]}))
    })
    .await;
    let s = session(&fake);
    s.call_subscriber("whoami", json!({})).await.unwrap();
    s.set_lease(Some("cap-123".into()));
    s.call_subscriber("delivery_renew", json!({}))
        .await
        .unwrap();
    let calls = fake.calls("tools/call");
    assert!(!calls[0].headers.contains_key("x-grayboard-lease"));
    assert_eq!(calls[1].headers["x-grayboard-lease"], "cap-123");
}

#[tokio::test]
async fn sse_response_takes_the_matching_id() {
    let fake = Fake::start(false, |req, _| {
        let id = req.id();
        Reply::sse(
            vec![
                (Duration::ZERO, ": keepalive\n\n".into()),
                (Duration::from_millis(20), event(json!({"jsonrpc": "2.0", "method": "notifications/message", "params": {}}))),
                (Duration::ZERO, event(json!({"jsonrpc": "2.0", "id": 999, "result": {"content": [{"type": "text", "text": "wrong"}]}}))),
                (Duration::from_millis(20), event(json!({"jsonrpc": "2.0", "id": id, "result": {"content": [{"type": "text", "text": "right"}], "structuredContent": {"n": 1}}}))),
            ],
            Duration::from_secs(5),
        )
    })
    .await;
    let r = session(&fake)
        .call_raw("board_read", json!({}))
        .await
        .unwrap();
    assert_eq!(r.texts().collect::<Vec<_>>(), ["right"]);
    assert_eq!(r.structured_content, Some(json!({"n": 1})));
}

#[tokio::test]
async fn refusal_is_a_result_on_native_and_an_error_on_subscriber() {
    let fake = Fake::start(false, |req, _| Reply::result(req, json!({"content": [{"type": "text", "text": "No such name"}], "structuredContent": {"code": "identity_unknown", "known": ["a", "b"]}, "isError": true}))).await;
    let s = session(&fake);
    let raw = s.call_raw("bind", json!({"name": "x"})).await.unwrap();
    assert!(raw.is_error);
    match s.call_subscriber("bind", json!({"name": "x"})).await {
        Err(Error::Refusal { code, known, .. }) => {
            assert_eq!(code, "identity_unknown");
            assert_eq!(known, ["a", "b"]);
        }
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn admission_429_retries_with_a_fresh_token_read() {
    let fake = Fake::start(false, |req, n| {
        if n < 2 {
            Reply { status: 429, ..Reply::json(json!({"jsonrpc": "2.0", "id": req.id(), "error": {"code": -32000, "message": "slow down", "data": {"code": "rate_limited", "retry_after_ms": 5}}})) }
        } else {
            ok_text(req)
        }
    })
    .await;
    let counting = Counting::default();
    let reads = Arc::clone(&counting.reads);
    let c = Client::new(&fake.url, counting, ClientInfo::new("t", "0"))
        .unwrap()
        .with_timeouts(fast());
    let r = c
        .session("s-1", DeliveryMode::push("t").unwrap())
        .call_raw("board_post", json!({}))
        .await
        .unwrap();
    assert_eq!(r.texts().collect::<Vec<_>>(), ["ok"]);
    assert_eq!(fake.calls("tools/call").len(), 3);
    // discover + three attempts, each reading the token.
    assert_eq!(reads.load(Ordering::SeqCst), 4);
}

#[tokio::test]
async fn admission_429_gives_up_after_eight_attempts() {
    let fake = Fake::start(false, |req, _| Reply { status: 429, ..Reply::json(json!({"jsonrpc": "2.0", "id": req.id(), "error": {"code": -32000, "message": "slow", "data": {"code": "rate_limited", "retry_after_ms": 1}}})) }).await;
    let err = session(&fake)
        .call_raw("board_post", json!({}))
        .await
        .unwrap_err();
    assert!(
        matches!(err, Error::RateLimited { retry_after } if retry_after == Duration::from_millis(1)),
        "{err:?}"
    );
    assert_eq!(fake.calls("tools/call").len(), 8);
}

#[tokio::test]
async fn plain_429_is_capacity_and_not_retried() {
    let fake = Fake::start(false, |_, _| Reply::status(429, "Too many requests")).await;
    let err = session(&fake)
        .call_raw("board_post", json!({}))
        .await
        .unwrap_err();
    assert!(
        matches!(err, Error::Capacity(ref t) if t == "Too many requests"),
        "{err:?}"
    );
    assert_eq!(fake.calls("tools/call").len(), 1);
}

#[tokio::test]
async fn static_bearer_401_is_terminal() {
    let fake = Fake::start(false, |_, _| Reply::status(401, "")).await;
    let err = session(&fake)
        .call_raw("board_post", json!({}))
        .await
        .unwrap_err();
    assert!(matches!(err, Error::Unauthorized(_)), "{err:?}");
    assert_eq!(fake.calls("tools/call").len(), 1);
}

#[tokio::test]
async fn a_401_lets_the_credential_replace_its_token_once() {
    let fake = Fake::start(false, |req, _| {
        if req.headers["authorization"] == "Bearer fresh" {
            ok_text(req)
        } else {
            Reply::status(401, "")
        }
    })
    .await;
    let rotating = Rotating {
        token: Mutex::new("stale".into()),
    };
    let c = Client::new(&fake.url, rotating, ClientInfo::new("t", "0"))
        .unwrap()
        .with_timeouts(fast());
    // discover is refused with the stale token, rotated, then everything uses the fresh one.
    let r = c
        .session("s-1", DeliveryMode::push("t").unwrap())
        .call_raw("board_post", json!({}))
        .await
        .unwrap();
    assert_eq!(r.texts().collect::<Vec<_>>(), ["ok"]);
}

/// A credential whose replacement after a 401 fails, transiently or terminally.
struct Unreplaceable {
    retryable: bool,
}

impl Credential for Unreplaceable {
    fn token(&self) -> BoxFuture<'_, Result<String, AuthError>> {
        Box::pin(async { Ok("t".into()) })
    }
    fn unauthorized<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Result<(), AuthError>> {
        let retryable = self.retryable;
        Box::pin(async move {
            Err(if retryable {
                AuthError::transient("the authorization server answered 503")
            } else {
                AuthError::terminal("invalid_client")
            })
        })
    }
}

// #929 R1: a 401 whose replacement fails transiently (the token expired while the authorization server is down) is `Unreachable`, so a delivery stream backs off and reopens; a terminal failure stays `Unauthorized`. The server refused the request, so neither is `OutcomeUnknown`.
#[tokio::test]
async fn a_401_whose_replacement_fails_transiently_is_unreachable_and_terminally_unauthorized() {
    for (retryable, want) in [(true, "Unreachable"), (false, "Unauthorized")] {
        let fake = Fake::start(false, |_, _| Reply::status(401, "")).await;
        let err = Client::new(
            &fake.url,
            Unreplaceable { retryable },
            ClientInfo::new("t", "0"),
        )
        .unwrap()
        .with_timeouts(fast())
        .session("s-1", DeliveryMode::push("t").unwrap())
        .call_raw("board_post", json!({}))
        .await
        .unwrap_err();
        match (&err, retryable) {
            (Error::Unreachable(m), true) => assert!(m.contains("503"), "{m}"),
            (Error::Unauthorized(m), false) => assert!(m.contains("invalid_client"), "{m}"),
            _ => panic!("expected {want}, got {err:?}"),
        }
    }
}

#[tokio::test]
async fn forbidden_is_insufficient_scope() {
    let fake = Fake::start(false, |_, _| Reply::status(403, "")).await;
    assert!(matches!(
        session(&fake).call_raw("board_post", json!({})).await,
        Err(Error::InsufficientScope)
    ));
}

#[tokio::test]
async fn gateway_statuses_unreachable_for_reads_outcome_unknown_for_writes() {
    let fake = Fake::start(false, |_, _| Reply::status(502, "<html>bad gateway</html>")).await;
    let s = session(&fake);
    assert!(matches!(s.list_tools().await, Err(Error::Unreachable(_))));
    assert!(matches!(
        s.call_raw("board_post", json!({})).await,
        Err(Error::OutcomeUnknown(_))
    ));
}

#[tokio::test]
async fn connect_failure_is_unreachable_even_for_a_write() {
    // Bound but never listening, and held to the end: a connect is refused, and no other test's fake can take the port. A released port was retaken under load (#1383): this call then reached a stranger's fake, and its board_post landed in that test's counts.
    let socket = tokio::net::TcpSocket::new_v4().unwrap();
    socket.bind("127.0.0.1:0".parse().unwrap()).unwrap();
    let url = format!("http://{}/mcp", socket.local_addr().unwrap());
    let c = Client::new(&url, StaticBearer::new("t"), ClientInfo::new("t", "0"))
        .unwrap()
        .with_timeouts(fast());
    let err = c
        .session("s", DeliveryMode::push("t").unwrap())
        .call_raw("board_post", json!({}))
        .await
        .unwrap_err();
    assert!(matches!(err, Error::Unreachable(_)), "{err:?}");
    drop(socket);
}

#[tokio::test]
async fn a_write_that_times_out_is_outcome_unknown_and_not_retried() {
    // The stream stays open well past the outer bound: only the request timeout (500 ms) can end these calls in time.
    let fake = Fake::start(false, |_, _| Reply::sse(vec![], Duration::from_secs(30))).await;
    let s = session(&fake);
    let bound = Duration::from_secs(3);
    let err = tokio::time::timeout(bound, s.call_raw("board_post", json!({})))
        .await
        .expect("the request timeout ends the write")
        .unwrap_err();
    assert!(matches!(err, Error::OutcomeUnknown(_)), "{err:?}");
    assert_eq!(fake.calls("tools/call").len(), 1);
    let read = tokio::time::timeout(bound, s.list_tools())
        .await
        .expect("the request timeout ends the read");
    assert!(matches!(read, Err(Error::Unreachable(_))), "{read:?}");
}

#[tokio::test]
async fn discover_refusal_is_connect_refused_with_the_server_body() {
    let fake = Fake::start(true, |_, _| {
        Reply::status(
            400,
            "{\"code\":\"bad_request\",\"message\":\"invalid delivery declaration\"}",
        )
    })
    .await;
    match session(&fake).call_raw("board_post", json!({})).await {
        Err(Error::ConnectRefused { status: 400, body }) => {
            assert!(body.contains("invalid delivery declaration"))
        }
        other => panic!("{other:?}"),
    }
    assert!(fake.calls("tools/call").is_empty());
}

#[tokio::test]
async fn an_older_server_is_incompatible() {
    let fake = Fake::start(true, |req, _| {
        Reply::result(req, json!({"supportedVersions": ["2025-11-25"]}))
    })
    .await;
    match session(&fake).call_raw("board_post", json!({})).await {
        Err(Error::Incompatible { offered, .. }) => assert_eq!(offered, ["2025-11-25"]),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn header_mismatch_and_protocol_errors() {
    let fake = Fake::start(false, |req, n| {
        let error = if n == 0 {
            json!({"code": -32020, "message": "Mcp-Name does not match"})
        } else {
            json!({"code": -32602, "message": "not found", "data": {"code": "not_found"}})
        };
        Reply {
            status: 400,
            ..Reply::json(json!({"jsonrpc": "2.0", "id": req.id(), "error": error}))
        }
    })
    .await;
    let s = session(&fake);
    assert!(matches!(
        s.call_raw("x", json!({})).await,
        Err(Error::HeaderMismatch(_))
    ));
    match s.read_resource("grayboard://inbox").await {
        Err(Error::Refusal { code, .. }) => assert_eq!(code, "not_found"),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn server_text_is_capped() {
    let body = "x".repeat(5000);
    let fake = Fake::start(true, move |_, _| Reply::status(500, &body)).await;
    match session(&fake).list_tools().await {
        Err(Error::ConnectRefused { body, .. }) => {
            assert!(body.ends_with("(3584 more characters cut)"), "{body}")
        }
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn tools_list_follows_pagination() {
    let fake = Fake::start(false, |req, _| {
        let page2 = req.body["params"]["cursor"] == "c2";
        Reply::result(
            req,
            if page2 {
                json!({"tools": [{"name": "b"}]})
            } else {
                json!({"tools": [{"name": "a"}], "nextCursor": "c2"})
            },
        )
    })
    .await;
    let names: Vec<_> = session(&fake)
        .list_tools()
        .await
        .unwrap()
        .into_iter()
        .map(|t| t["name"].clone())
        .collect();
    assert_eq!(names, [json!("a"), json!("b")]);
}

pub(crate) fn listen_reply(
    req: &Req,
    honored: &[&str],
    then: Vec<(Duration, String)>,
    hold: Duration,
) -> Reply {
    let mut events = vec![(
        Duration::ZERO,
        event(
            json!({"jsonrpc": "2.0", "method": "notifications/subscriptions/acknowledged", "params": {"notifications": {"resourceSubscriptions": honored}, "_meta": {"io.modelcontextprotocol/subscriptionId": req.id()}}}),
        ),
    )];
    events.extend(then);
    Reply::sse(events, hold)
}

pub(crate) fn hint() -> String {
    event(
        json!({"jsonrpc": "2.0", "method": "notifications/resources/updated", "params": {"uri": "grayboard://inbox"}}),
    )
}

#[tokio::test]
async fn listen_delivers_hints_through_keepalives_and_closes_with_cancelled() {
    let fake = Fake::start(false, |req, _| match req.method() {
        "subscriptions/listen" => listen_reply(
            req,
            &["grayboard://inbox"],
            vec![
                (Duration::from_millis(50), hint()),
                (Duration::from_millis(300), ": keepalive\n\n".into()),
                (Duration::from_millis(300), hint()),
            ],
            Duration::from_secs(5),
        ),
        _ => Reply {
            status: 202,
            headers: vec![],
            chunks: vec![],
            hold: Duration::ZERO,
            live: None,
        },
    })
    .await;
    let s = session(&fake);
    let mut sub = s.listen(&["grayboard://inbox"]).await.unwrap();
    for _ in 0..2 {
        let n = sub.next().await.unwrap().unwrap();
        assert_eq!(n.method, "notifications/resources/updated");
        assert_eq!(n.params["uri"], "grayboard://inbox");
    }
    sub.close().await;
    let listen = &fake.calls("subscriptions/listen")[0];
    assert_eq!(listen.headers["x-grayboard-client"], "subscriber");
    assert_eq!(
        listen.body["params"]["notifications"],
        json!({"resourceSubscriptions": ["grayboard://inbox"]})
    );
    let cancelled = &fake.calls("notifications/cancelled")[0];
    assert_eq!(cancelled.body["params"]["requestId"], listen.id());
    assert!(cancelled.body.get("id").is_none());
}

#[tokio::test]
async fn listen_requires_the_uri_in_the_honored_filter() {
    let fake = Fake::start(false, |req, _| match req.method() {
        "subscriptions/listen" => listen_reply(req, &[], vec![], Duration::from_secs(5)),
        _ => Reply {
            status: 202,
            headers: vec![],
            chunks: vec![],
            hold: Duration::ZERO,
            live: None,
        },
    })
    .await;
    let err = session(&fake)
        .listen(&["grayboard://inbox"])
        .await
        .err()
        .unwrap();
    assert!(
        matches!(err, Error::InvalidResponse(ref t) if t.contains("grayboard://inbox")),
        "{err:?}"
    );
    assert_eq!(fake.calls("notifications/cancelled").len(), 1);
}

#[tokio::test]
async fn listen_without_an_acknowledgement_times_out() {
    let fake = Fake::start(false, |_, _| {
        Reply::sse(
            vec![(Duration::ZERO, ": keepalive\n\n".into())],
            Duration::from_secs(5),
        )
    })
    .await;
    let err = session(&fake)
        .listen(&["grayboard://inbox"])
        .await
        .err()
        .unwrap();
    // The ack limit (500 ms), not the idle one (1500 ms), ends it.
    assert!(
        matches!(err, Error::Unreachable(ref t) if t.contains("not acknowledged")),
        "{err:?}"
    );
}

#[tokio::test]
async fn an_idle_listen_stream_is_unreachable_and_a_closed_one_ends() {
    let fake = Fake::start(false, |req, n| {
        listen_reply(
            req,
            &["grayboard://inbox"],
            vec![],
            if n == 0 {
                Duration::from_secs(5)
            } else {
                Duration::ZERO
            },
        )
    })
    .await;
    let s = session(&fake);
    let mut idle = s.listen(&["grayboard://inbox"]).await.unwrap();
    assert!(matches!(idle.next().await, Err(Error::Unreachable(ref t)) if t.contains("idle")));
    let mut closed = s.listen(&["grayboard://inbox"]).await.unwrap();
    assert!(matches!(closed.next().await, Ok(None)));
}

#[tokio::test]
async fn ending_a_session_cancels_an_in_flight_request() {
    let fake = Fake::start(false, |req, _| {
        if req.method() == "subscriptions/listen" {
            listen_reply(req, &["grayboard://inbox"], vec![], Duration::from_secs(5))
        } else {
            Reply::result(req, json!({"content": [{"type": "text", "text": "{}"}]}))
        }
    })
    .await;
    let s = session(&fake);
    let mut sub = s.listen(&["grayboard://inbox"]).await.unwrap();
    let waiting = tokio::spawn(async move { sub.next().await });
    tokio::time::sleep(Duration::from_millis(50)).await;
    s.end().await.unwrap();
    assert!(matches!(waiting.await.unwrap(), Err(Error::Cancelled)));
    let end = fake.calls("tools/call");
    assert_eq!(end.last().unwrap().body["params"]["name"], "session_end");
}

#[test]
fn bad_arguments_are_refused_before_sending() {
    assert!(matches!(
        Client::new(
            "ftp://x/mcp",
            StaticBearer::new("t"),
            ClientInfo::new("t", "0")
        ),
        Err(Error::InvalidArgument(_))
    ));
    assert!(matches!(
        Client::new(
            "not a url",
            StaticBearer::new("t"),
            ClientInfo::new("t", "0")
        ),
        Err(Error::InvalidArgument(_))
    ));
}

#[tokio::test]
async fn a_token_that_is_not_a_header_value_is_an_auth_error_and_nothing_is_sent() {
    let fake = Fake::start(true, |req, _| ok_text(req)).await;
    let s = Client::new(
        &fake.url,
        StaticBearer::new("tok-1\n"),
        ClientInfo::new("rust-sdk-test", "0.0.1"),
    )
    .unwrap()
    .with_timeouts(fast())
    .session("s-1", DeliveryMode::push("rust-sdk-test").unwrap());
    let write = s.call_raw("board_post", json!({})).await.unwrap_err();
    assert!(matches!(write, Error::Auth(_)), "{write:?}");
    assert!(matches!(s.list_tools().await, Err(Error::Auth(_))));
    assert!(fake.requests().is_empty());
}

struct Hanging;

impl Credential for Hanging {
    fn token(&self) -> BoxFuture<'_, Result<String, AuthError>> {
        Box::pin(std::future::pending())
    }
    fn unauthorized<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Result<(), AuthError>> {
        Box::pin(std::future::pending())
    }
}

#[tokio::test]
async fn a_credential_that_never_answers_is_bounded_by_the_request_timeout_and_unreachable() {
    let fake = Fake::start(true, |req, _| ok_text(req)).await;
    let s = Client::new(
        &fake.url,
        Hanging,
        ClientInfo::new("rust-sdk-test", "0.0.1"),
    )
    .unwrap()
    .with_timeouts(fast())
    .session("s-1", DeliveryMode::push("rust-sdk-test").unwrap());
    let err = tokio::time::timeout(Duration::from_secs(3), s.call_raw("board_post", json!({})))
        .await
        .expect("the credential's token call is bounded")
        .unwrap_err();
    // Transient: nothing was sent, and a delivery stream backs off and reopens rather than stopping.
    assert!(matches!(err, Error::Unreachable(_)), "{err:?}");
}

#[derive(Default)]
struct Counting {
    reads: Arc<AtomicUsize>,
}

impl Credential for Counting {
    fn token(&self) -> BoxFuture<'_, Result<String, AuthError>> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok("t".into()) })
    }
    fn unauthorized<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Result<(), AuthError>> {
        Box::pin(async { Err(AuthError::terminal("no")) })
    }
}

struct Rotating {
    token: Mutex<String>,
}

impl Credential for Rotating {
    fn token(&self) -> BoxFuture<'_, Result<String, AuthError>> {
        let t = self.token.lock().unwrap().clone();
        Box::pin(async move { Ok(t) })
    }
    fn unauthorized<'a>(&'a self, rejected: &'a str) -> BoxFuture<'a, Result<(), AuthError>> {
        assert_eq!(rejected, "stale");
        *self.token.lock().unwrap() = "fresh".into();
        Box::pin(async { Ok(()) })
    }
}

/// The headers and body fields `scripts/record_rust_fixtures.ts` keeps, normalized the same way.
fn normalized(req: &Req) -> Value {
    // The HTTP stack's own headers; every other header is compared, as the recorder keeps it.
    const TRANSPORT_HEADERS: [&str; 6] = [
        "host",
        "content-length",
        "user-agent",
        "accept-encoding",
        "connection",
        "transfer-encoding",
    ];
    let mut headers = serde_json::Map::new();
    for (name, value) in &req.headers {
        if TRANSPORT_HEADERS.contains(&name.as_str()) {
            continue;
        }
        let value = match name.as_str() {
            "authorization" => "Bearer <token>".to_owned(),
            "x-grayboard-lease" => "<lease>".to_owned(),
            _ => value.clone(),
        };
        headers.insert(name.clone(), Value::String(value));
    }
    let mut body = req.body.clone();
    if body.get("id").is_some() {
        body["id"] = json!("<id>");
    }
    if body["params"].get("requestId").is_some() {
        body["params"]["requestId"] = json!("<id>");
    }
    json!({"headers": headers, "body": body})
}

/// Each operation's requests equal the reference client's, as recorded in `sdk/rust/schema/wire/requests.json` (#929 R1): the envelope is checked against the TS wire, not against this crate's idea of it.
#[tokio::test]
async fn requests_match_the_reference_clients_recording() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../schema/wire/requests.json")).unwrap();
    let fake = Fake::start(false, |req, _| match req.method() {
        "tools/call" if req.body["params"]["name"] == "delivery_open" => Reply::result(
            req,
            json!({"content": [{"type": "text", "text": "{\"capability\": \"cap-1\"}"}]}),
        ),
        "tools/call" => ok_text(req),
        "tools/list" => Reply::result(req, json!({"tools": []})),
        "resources/read" => Reply::result(
            req,
            json!({"contents": [{"uri": "grayboard://inbox", "text": "{\"items\": []}"}]}),
        ),
        "subscriptions/listen" => {
            listen_reply(req, &["grayboard://inbox"], vec![], Duration::from_secs(5))
        }
        _ => Reply {
            status: 202,
            headers: vec![],
            chunks: vec![],
            hold: Duration::ZERO,
            live: None,
        },
    })
    .await;
    let client = Client::new(
        &fake.url,
        StaticBearer::new("tok-1"),
        ClientInfo::new(
            fixture["client"]["name"].as_str().unwrap(),
            fixture["client"]["version"].as_str().unwrap(),
        ),
    )
    .unwrap()
    .with_timeouts(fast());
    let s = client.session(
        fixture["session"].as_str().unwrap(),
        DeliveryMode::push(fixture["source"].as_str().unwrap()).unwrap(),
    );
    let mut seen = 0;
    let mut took = |name: &str| {
        let all = fake.requests.lock().unwrap().clone();
        let got: Vec<Value> = all[seen..].iter().map(normalized).collect();
        seen = all.len();
        assert_eq!(
            Value::Array(got),
            fixture["operations"][name],
            "operation {name} differs from the reference client's recording"
        );
    };
    s.discover().await.unwrap();
    took("native_discover");
    // The bare native call: `call_raw("bind")` adds the bind rule's subscriber whoami, which isn't this operation.
    s.native_call("bind", json!({"name": "fixture-w1", "create": true}))
        .await
        .unwrap();
    took("native_call");
    s.list_tools().await.unwrap();
    took("native_list_tools");
    s.subscriber_connection().discover().await.unwrap();
    took("subscriber_discover");
    let lease = s.call_subscriber("delivery_open", json!({})).await.unwrap();
    took("subscriber_call");
    s.list_subscriber_tools().await.unwrap();
    took("subscriber_list_tools");
    s.set_lease(Some(lease["capability"].as_str().unwrap().into()));
    s.read_resource("grayboard://inbox").await.unwrap();
    took("read_resource");
    let sub = s.listen(&["grayboard://inbox"]).await.unwrap();
    sub.close().await;
    took("listen_and_close");
}
