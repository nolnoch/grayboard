//! `ClientCredentials` against a scripted authorization server: metadata and the issuer pin, the mint's wire, the cache and 80% renewal, the `unauthorized` re-mint, `slow_down` backoff, terminal refusals, revoke, and the secret kept out of every printed form.

use crate::credential::{ClientCredentials, Credential, form_encode};
use crate::error::Error;
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const ID: &str = "svc_0123456789abcdef0123456789abcdef";
/// Characters a form encoding must escape, so the test sees that the Basic header encodes them.
const SECRET: &str = "s3cret+/=:ünïcode-SECRET-VALUE";
/// `SECRET` form-encoded, by hand.
const SECRET_ENCODED: &str = "s3cret%2B%2F%3D%3A%C3%BCn%C3%AFcode-SECRET-VALUE";

#[derive(Debug, Clone)]
struct Seen {
    method: String,
    path: String,
    authorization: Option<String>,
    body: String,
}

/// status, extra headers, JSON body
type Answer = (u16, Vec<(&'static str, String)>, Value);

struct Auth {
    base: String,
    seen: Arc<Mutex<Vec<Seen>>>,
    /// Answers for the next POSTs to `/oauth/revoke`, in order; once empty, 200.
    revoke: Arc<Mutex<VecDeque<Answer>>>,
    /// While false, a token request is received (and counted) but not answered.
    gate: tokio::sync::watch::Sender<bool>,
    /// Token requests received so far.
    mints: tokio::sync::watch::Receiver<usize>,
}

impl Auth {
    /// `token` answers each POST to `/oauth/token` by its index among them; `metadata` gives the metadata for the server's base URL.
    async fn start(
        metadata: fn(&str) -> Value,
        token: impl Fn(usize) -> Answer + Send + Sync + 'static,
    ) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen: Arc<Mutex<Vec<Seen>>> = Arc::default();
        let revoke: Arc<Mutex<VecDeque<Answer>>> = Arc::default();
        let token = Arc::new(token);
        let (gate, open) = tokio::sync::watch::channel(true);
        let (counted, mints) = tokio::sync::watch::channel(0usize);
        let counted = Arc::new(counted);
        let (recorded, b, revokes) = (Arc::clone(&seen), base.clone(), Arc::clone(&revoke));
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let (recorded, token, b, revokes, mut open, counted) = (
                    Arc::clone(&recorded),
                    Arc::clone(&token),
                    b.clone(),
                    Arc::clone(&revokes),
                    open.clone(),
                    Arc::clone(&counted),
                );
                tokio::spawn(async move {
                    let Some(req) = read(&mut socket).await else {
                        return;
                    };
                    let mints = {
                        let mut all = recorded.lock().unwrap();
                        all.push(req.clone());
                        all.iter().filter(|r| r.path == "/oauth/token").count()
                    };
                    if req.path == "/oauth/token" {
                        counted.send_modify(|n| *n += 1);
                        if open.wait_for(|o| *o).await.is_err() {
                            return;
                        }
                    }
                    let (status, headers, body): Answer =
                        match (req.method.as_str(), req.path.as_str()) {
                            ("GET", "/.well-known/oauth-authorization-server") => {
                                (200, vec![], metadata(&b))
                            }
                            ("POST", "/oauth/token") => token(mints - 1),
                            ("POST", "/oauth/revoke") => revokes
                                .lock()
                                .unwrap()
                                .pop_front()
                                .unwrap_or((200, vec![], json!({}))),
                            _ => (404, vec![], json!({"error": "not_found"})),
                        };
                    let body = body.to_string();
                    let mut head = format!(
                        "HTTP/1.1 {status} X\r\nconnection: close\r\ncontent-type: application/json\r\ncontent-length: {}\r\n",
                        body.len()
                    );
                    for (k, v) in headers {
                        head.push_str(&format!("{k}: {v}\r\n"));
                    }
                    head.push_str("\r\n");
                    let _ = socket.write_all(head.as_bytes()).await;
                    let _ = socket.write_all(body.as_bytes()).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        Self {
            base,
            seen,
            revoke,
            gate,
            mints,
        }
    }

    /// Holds token requests unanswered until `open`.
    fn hold(&self) {
        self.gate.send_replace(false);
    }
    fn open(&self) {
        self.gate.send_replace(true);
    }
    /// Until `n` token requests have arrived.
    async fn mints_reach(&self, n: usize) {
        let mut rx = self.mints.clone();
        tokio::time::timeout(Duration::from_secs(5), rx.wait_for(|m| *m >= n))
            .await
            .unwrap_or_else(|_| panic!("{n} token requests never arrived"))
            .unwrap();
    }

    fn endpoint(&self) -> String {
        format!("{}/mcp", self.base)
    }
    fn credential(&self) -> ClientCredentials {
        ClientCredentials::new(&self.endpoint(), &self.base, ID, SECRET)
            .unwrap()
            .with_backoff_unit(Duration::from_millis(20))
    }
    fn seen(&self, path: &str) -> Vec<Seen> {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.path == path)
            .cloned()
            .collect()
    }
}

async fn read(socket: &mut tokio::net::TcpStream) -> Option<Seen> {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    let end = loop {
        let n = socket.read(&mut tmp).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
    };
    let head = String::from_utf8_lossy(&buf[..end]).into_owned();
    let mut lines = head.lines();
    let mut first = lines.next()?.split(' ');
    let (method, path) = (first.next()?.to_owned(), first.next()?.to_owned());
    let (mut len, mut authorization) = (0usize, None);
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            match k.trim().to_ascii_lowercase().as_str() {
                "content-length" => len = v.trim().parse().unwrap_or(0),
                "authorization" => authorization = Some(v.trim().to_owned()),
                _ => {}
            }
        }
    }
    while buf.len() < end + len {
        let n = socket.read(&mut tmp).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&tmp[..n]);
    }
    let body = String::from_utf8_lossy(&buf[end..end + len]).into_owned();
    Some(Seen {
        method,
        path,
        authorization,
        body,
    })
}

/// Metadata as the server answers it.
fn standard(b: &str) -> Value {
    json!({
        "issuer": b,
        "token_endpoint": format!("{b}/oauth/token"),
        "revocation_endpoint": format!("{b}/oauth/revoke"),
        "grant_types_supported": ["authorization_code", "refresh_token", "client_credentials"],
        "token_endpoint_auth_methods_supported": ["none", "client_secret_basic"],
    })
}

fn issued(token: &str, expires_in: u64) -> Answer {
    (
        200,
        vec![],
        json!({"access_token": token, "token_type": "Bearer", "expires_in": expires_in, "scope": "grayboard:tools grayboard:delivery"}),
    )
}

fn refused(status: u16, error: &str) -> Answer {
    (status, vec![], json!({"error": error}))
}

/// The Basic header's decoded `id:secret`, each still form-encoded.
fn basic(seen: &Seen) -> String {
    let b64 = seen
        .authorization
        .as_deref()
        .and_then(|a| a.strip_prefix("Basic "))
        .expect("a Basic header");
    // A small decoder: the crate has no base64 dependency of its own.
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut bits = 0u32;
    let mut n = 0;
    let mut out = Vec::new();
    for c in b64.bytes().filter(|&c| c != b'=') {
        bits = (bits << 6) | alphabet.iter().position(|&a| a == c).unwrap() as u32;
        n += 6;
        if n >= 8 {
            n -= 8;
            out.push((bits >> n) as u8);
        }
    }
    String::from_utf8(out).unwrap()
}

#[tokio::test]
async fn mints_with_basic_auth_and_the_resource_then_caches() {
    let auth = Auth::start(standard, |n| issued(&format!("tok-{n}"), 3600)).await;
    let c = auth.credential();
    assert_eq!(c.token().await.unwrap(), "tok-0");
    assert_eq!(c.clone().token().await.unwrap(), "tok-0");
    let mints = auth.seen("/oauth/token");
    assert_eq!(mints.len(), 1, "one mint, then the cache");
    assert_eq!(
        auth.seen("/.well-known/oauth-authorization-server").len(),
        1
    );
    // Literal expectations, not `form_encode` itself: the encoder is what's under test.
    assert_eq!(basic(&mints[0]), format!("{ID}:{SECRET_ENCODED}"));
    let port = auth.base.rsplit(':').next().unwrap();
    assert_eq!(
        mints[0].body,
        format!("grant_type=client_credentials&resource=http%3A%2F%2F127.0.0.1%3A{port}%2Fmcp")
    );
    assert!(!mints[0].body.contains("client_secret"));
}

#[tokio::test]
async fn concurrent_callers_share_one_mint() {
    let auth = Auth::start(standard, |n| issued(&format!("tok-{n}"), 3600)).await;
    let c = auth.credential();
    let all = futures_util::future::join_all((0..8).map(|_| c.token())).await;
    assert!(all.into_iter().all(|t| t.unwrap() == "tok-0"));
    assert_eq!(auth.seen("/oauth/token").len(), 1);
}

#[tokio::test]
async fn renews_at_80_percent_of_the_lifetime() {
    let auth = Auth::start(standard, |n| issued(&format!("tok-{n}"), 1)).await;
    let c = auth.credential();
    assert_eq!(c.token().await.unwrap(), "tok-0");
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(c.token().await.unwrap(), "tok-0", "before 80%: cached");
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(
        c.token().await.unwrap(),
        "tok-0",
        "past 80%: served while it renews"
    );
    prompt("the renewal", c.settled()).await;
    assert_eq!(c.token().await.unwrap(), "tok-1", "re-minted");
    assert_eq!(auth.seen("/oauth/token").len(), 2);
}

#[tokio::test]
async fn issuer_mismatch_is_terminal_and_sends_no_secret() {
    let auth = Auth::start(
        |_| json!({"issuer": "https://elsewhere.example.com", "token_endpoint": "https://elsewhere.example.com/oauth/token"}),
        |_| issued("never", 3600),
    )
    .await;
    let c = auth.credential();
    let e = c.token().await.unwrap_err();
    assert!(e.message.contains("issuer"), "{e}");
    assert!(!e.retryable, "terminal");
    assert!(c.token().await.is_err());
    assert_eq!(
        auth.seen("/.well-known/oauth-authorization-server").len(),
        1,
        "terminal: not asked again"
    );
    assert!(auth.seen("/oauth/token").is_empty());
}

#[tokio::test]
async fn an_endpoint_off_the_issuers_origin_is_refused() {
    let auth = Auth::start(
        |b| json!({"issuer": b, "token_endpoint": "https://elsewhere.example.com/oauth/token"}),
        |_| issued("never", 3600),
    )
    .await;
    let e = auth.credential().token().await.unwrap_err();
    assert!(e.message.contains("off the issuer"), "{e}");
    assert!(auth.seen("/oauth/token").is_empty());
}

#[tokio::test]
async fn invalid_client_is_terminal() {
    let auth = Auth::start(standard, |_| refused(401, "invalid_client")).await;
    let c = auth.credential();
    let e = c.token().await.unwrap_err();
    assert!(e.message.contains("invalid_client"), "{e}");
    assert!(!e.retryable, "terminal");
    let again = c.token().await.unwrap_err();
    assert_eq!(again.message, e.message);
    assert!(c.unauthorized("anything").await.is_err());
    assert_eq!(auth.seen("/oauth/token").len(), 1, "never asked again");
}

#[tokio::test]
async fn slow_down_backs_off_then_mints() {
    let auth = Auth::start(standard, |n| match n {
        0 | 1 => refused(429, "slow_down"),
        _ => issued("tok-ok", 3600),
    })
    .await;
    let c = auth.credential();
    let started = tokio::time::Instant::now();
    assert_eq!(c.token().await.unwrap(), "tok-ok");
    // 20 ms, then 40 ms.
    assert!(started.elapsed() >= Duration::from_millis(60));
    assert_eq!(auth.seen("/oauth/token").len(), 3);
}

#[tokio::test]
async fn a_long_retry_after_fails_the_call_rather_than_waiting() {
    let auth = Auth::start(standard, |_| {
        (
            429,
            vec![("retry-after", "30".into())],
            json!({"error": "slow_down"}),
        )
    })
    .await;
    let c = auth.credential();
    let e = c.token().await.unwrap_err();
    assert!(e.message.contains("slow_down"), "{e}");
    assert!(e.retryable, "a slow_down is transient");
    let e = c.token().await.unwrap_err();
    assert!(e.message.contains("backing off"), "{e}");
    assert!(e.retryable, "a backoff in force is transient");
    assert_eq!(
        auth.seen("/oauth/token").len(),
        1,
        "no mint inside the backoff"
    );
}

#[tokio::test]
async fn a_failed_renewal_keeps_serving_the_current_token_until_it_expires() {
    let auth = Auth::start(standard, |n| match n {
        0 => issued("tok-0", 1),
        _ => refused(503, "temporarily_unavailable"),
    })
    .await;
    let c = auth.credential().with_backoff_unit(Duration::from_secs(5));
    assert_eq!(c.token().await.unwrap(), "tok-0");
    tokio::time::sleep(Duration::from_millis(850)).await;
    assert_eq!(
        c.token().await.unwrap(),
        "tok-0",
        "the renewal failed; the token is still valid"
    );
    prompt("the renewal", c.settled()).await;
    assert_eq!(
        c.token().await.unwrap(),
        "tok-0",
        "inside the backoff: no mint"
    );
    assert_eq!(auth.seen("/oauth/token").len(), 2);
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert!(
        c.token().await.is_err(),
        "expired, and the backoff holds the mint"
    );
}

#[tokio::test]
async fn unauthorized_re_mints_once() {
    let auth = Auth::start(standard, |n| issued(&format!("tok-{n}"), 3600)).await;
    let c = auth.credential();
    assert_eq!(c.token().await.unwrap(), "tok-0");
    c.unauthorized("tok-0").await.unwrap();
    assert_eq!(c.token().await.unwrap(), "tok-1");
    // A stale rejection, after another request already replaced the token: no mint.
    c.unauthorized("tok-0").await.unwrap();
    assert_eq!(auth.seen("/oauth/token").len(), 2);
    // The replacement rejected too: no second mint for this request.
    assert!(c.unauthorized("tok-1").await.is_err());
    assert_eq!(auth.seen("/oauth/token").len(), 2);
    // The next request starts afresh.
    assert_eq!(c.token().await.unwrap(), "tok-2");
}

#[tokio::test]
async fn revoke_sends_the_current_token_with_basic_auth() {
    let auth = Auth::start(standard, |n| issued(&format!("tok-{n}"), 3600)).await;
    let c = auth.credential();
    c.revoke().await.unwrap();
    assert!(
        auth.seen("/oauth/revoke").is_empty(),
        "no token, nothing sent"
    );
    c.token().await.unwrap();
    c.revoke().await.unwrap();
    let revoked = auth.seen("/oauth/revoke");
    assert_eq!(revoked.len(), 1);
    assert_eq!(revoked[0].body, "token=tok-0");
    assert_eq!(basic(&revoked[0]), format!("{ID}:{SECRET_ENCODED}"));
    assert_eq!(c.token().await.unwrap(), "tok-1", "a later call mints anew");
}

#[test]
fn new_refuses_cleartext_off_loopback_and_an_issuer_elsewhere() {
    let new = |endpoint: &str, issuer: &str| ClientCredentials::new(endpoint, issuer, ID, SECRET);
    assert!(matches!(
        new("http://bus.example.com/mcp", "http://bus.example.com"),
        Err(Error::InvalidArgument(_))
    ));
    assert!(matches!(
        new("https://bus.example.com/mcp", "https://other.example.com"),
        Err(Error::InvalidArgument(_))
    ));
    assert!(matches!(
        new("https://bus.example.com/mcp?x=1", "https://bus.example.com"),
        Err(Error::InvalidArgument(_))
    ));
    assert!(new("https://bus.example.com/mcp", "https://bus.example.com").is_ok());
    assert!(new("http://127.0.0.1:9/mcp", "http://127.0.0.1:9").is_ok());
    assert!(new("http://[::1]:9/mcp", "http://[::1]:9").is_ok());
    assert!(matches!(
        ClientCredentials::new(
            "https://bus.example.com/mcp",
            "https://bus.example.com",
            ID,
            ""
        ),
        Err(Error::InvalidArgument(_))
    ));
}

#[tokio::test]
async fn the_secret_never_appears_in_debug_output_or_errors() {
    let encoded = form_encode(SECRET);
    let leaks = |text: &str| {
        text.contains(SECRET) || text.contains(&encoded) || text.contains("SECRET-VALUE")
    };
    let auth = Auth::start(standard, |n| match n {
        0 => (500, vec![], json!({"error": "server_error"})),
        _ => refused(401, "invalid_client"),
    })
    .await;
    let c = auth.credential();
    let debug = format!("{c:?} {c:#?}");
    assert!(!leaks(&debug), "{debug}");
    assert!(debug.contains(ID), "the client ID is not secret: {debug}");
    let mut errors = vec![];
    errors.push(c.token().await.unwrap_err());
    tokio::time::sleep(Duration::from_millis(30)).await;
    errors.push(c.token().await.unwrap_err());
    // Unreachable: nothing listens there.
    let gone =
        ClientCredentials::new("http://127.0.0.1:9/mcp", "http://127.0.0.1:9", ID, SECRET).unwrap();
    errors.push(gone.token().await.unwrap_err());
    let as_error = Error::Auth(errors[0].clone());
    for text in errors
        .iter()
        .flat_map(|e| [e.to_string(), format!("{e:?}")])
        .chain([as_error.to_string(), format!("{as_error:?}")])
    {
        assert!(!leaks(&text), "{text}");
    }
}

#[tokio::test]
async fn a_server_error_or_an_unreachable_server_is_retryable() {
    let auth = Auth::start(standard, |_| refused(503, "temporarily_unavailable")).await;
    let e = auth.credential().token().await.unwrap_err();
    assert!(e.retryable, "{e}");
    let gone =
        ClientCredentials::new("http://127.0.0.1:9/mcp", "http://127.0.0.1:9", ID, SECRET).unwrap();
    let e = gone.token().await.unwrap_err();
    assert!(e.retryable, "{e}");
}

#[tokio::test]
async fn retry_after_is_honoured_up_to_60_s() {
    let auth = Auth::start(standard, |_| {
        (
            429,
            vec![("retry-after", "3600".into())],
            json!({"error": "slow_down"}),
        )
    })
    .await;
    let c = auth.credential();
    c.token().await.unwrap_err();
    let e = c.token().await.unwrap_err();
    let wait = e
        .message
        .split_once("backing off for ")
        .and_then(|(_, rest)| rest.split_once("s after"))
        .map(|(secs, _)| secs.parse::<f64>().unwrap())
        .unwrap_or_else(|| panic!("no wait in {e}"));
    assert!((50.0..=60.0).contains(&wait), "{wait}");
}

#[tokio::test]
async fn a_huge_expires_in_is_clamped_rather_than_a_panic() {
    let auth = Auth::start(standard, |n| issued(&format!("tok-{n}"), u64::MAX)).await;
    let c = auth.credential();
    assert_eq!(c.token().await.unwrap(), "tok-0");
    assert_eq!(c.token().await.unwrap(), "tok-0", "cached");
    assert_eq!(auth.seen("/oauth/token").len(), 1);
}

#[tokio::test]
async fn a_failed_revoke_takes_the_token_out_of_service_and_a_retry_sends_it_again() {
    let auth = Auth::start(standard, |n| issued(&format!("tok-{n}"), 3600)).await;
    auth.revoke
        .lock()
        .unwrap()
        .push_back(refused(404, "not_found"));
    let c = auth.credential();
    assert_eq!(c.token().await.unwrap(), "tok-0");
    assert!(c.revoke().await.is_err());
    assert_eq!(
        c.token().await.unwrap(),
        "tok-1",
        "a token being revoked is never served"
    );
    c.revoke().await.unwrap();
    let bodies: Vec<String> = auth
        .seen("/oauth/revoke")
        .into_iter()
        .map(|r| r.body)
        .collect();
    assert_eq!(bodies, ["token=tok-0", "token=tok-0", "token=tok-1"]);
    c.revoke().await.unwrap();
    assert_eq!(
        auth.seen("/oauth/revoke").len(),
        3,
        "nothing left to revoke"
    );
}

// #929 R2: a revoke answered 429 or 5xx is transient (`Unreachable`), any other non-2xx is terminal (`Auth`); either way the token stays pending and a later `revoke` sends it again.
#[tokio::test]
async fn a_revoke_answered_429_or_5xx_is_unreachable_and_another_refusal_auth() {
    for (status, transient) in [(429, true), (503, true), (500, true), (400, false)] {
        let auth = Auth::start(standard, |n| issued(&format!("tok-{n}"), 3600)).await;
        auth.revoke
            .lock()
            .unwrap()
            .push_back(refused(status, "refused"));
        let c = auth.credential();
        c.token().await.unwrap();
        let m = match (c.revoke().await, transient) {
            (Err(Error::Unreachable(m)), true) => m,
            (Err(Error::Auth(e)), false) if !e.retryable => e.message,
            (other, _) => panic!("{status}: expected transient={transient}, got {other:?}"),
        };
        assert!(m.contains(&status.to_string()), "{status}: {m}");
        c.revoke().await.unwrap();
        let bodies: Vec<String> = auth
            .seen("/oauth/revoke")
            .into_iter()
            .map(|r| r.body)
            .collect();
        assert_eq!(
            bodies,
            ["token=tok-0", "token=tok-0"],
            "{status}: still pending"
        );
    }
}

/// A token or revocation endpoint that redirects to another origin: refused, and the redirect not followed.
#[tokio::test]
async fn a_redirect_from_the_token_or_revocation_endpoint_is_not_followed() {
    let other = Auth::start(standard, |n| issued(&format!("other-{n}"), 3600)).await;
    let to = other.base.clone();
    let auth = Auth::start(standard, move |_| {
        (
            307,
            vec![("location", format!("{to}/oauth/token"))],
            json!({}),
        )
    })
    .await;
    let e = auth.credential().token().await.unwrap_err();
    assert!(e.message.contains("307"), "{e}");
    assert!(!e.retryable, "a redirect is terminal");
    assert!(other.seen.lock().unwrap().is_empty(), "not followed");

    let auth = Auth::start(standard, |n| issued(&format!("tok-{n}"), 3600)).await;
    auth.revoke.lock().unwrap().push_back((
        307,
        vec![("location", format!("{}/oauth/revoke", other.base))],
        json!({}),
    ));
    let c = auth.credential();
    c.token().await.unwrap();
    assert!(c.revoke().await.is_err());
    assert!(other.seen.lock().unwrap().is_empty(), "not followed");
}

#[tokio::test]
async fn a_revocation_endpoint_off_the_issuers_origin_is_refused() {
    let auth = Auth::start(
        |b| {
            let mut m = standard(b);
            m["revocation_endpoint"] = json!("https://elsewhere.example.com/oauth/revoke");
            m
        },
        |_| issued("never", 3600),
    )
    .await;
    let e = auth.credential().token().await.unwrap_err();
    assert!(e.message.contains("off the issuer"), "{e}");
    assert!(auth.seen("/oauth/token").is_empty());
}

/// The origin is scheme, host and port: the same host under another scheme or on another port is elsewhere.
#[tokio::test]
async fn an_endpoint_on_the_issuers_host_under_another_scheme_or_port_is_refused() {
    fn other_scheme(b: &str) -> Value {
        let mut m = standard(b);
        m["token_endpoint"] = json!(format!(
            "{}/oauth/token",
            b.replacen("http://", "https://", 1)
        ));
        m
    }
    fn other_port(b: &str) -> Value {
        let (host, port) = b.rsplit_once(':').unwrap();
        let port: u16 = port.parse().unwrap();
        let mut m = standard(b);
        m["token_endpoint"] = json!(format!("{host}:{}/oauth/token", port.wrapping_add(1)));
        m
    }
    for metadata in [other_scheme as fn(&str) -> Value, other_port] {
        let auth = Auth::start(metadata, |_| issued("never", 3600)).await;
        let e = auth.credential().token().await.unwrap_err();
        assert!(e.message.contains("off the issuer"), "{e}");
        assert!(!e.retryable);
        assert!(auth.seen("/oauth/token").is_empty());
    }
}

#[tokio::test]
async fn metadata_without_the_grant_or_basic_auth_is_refused() {
    fn no_grant(b: &str) -> Value {
        let mut m = standard(b);
        m["grant_types_supported"] = json!(["authorization_code", "refresh_token"]);
        m
    }
    fn no_basic(b: &str) -> Value {
        let mut m = standard(b);
        m["token_endpoint_auth_methods_supported"] = json!(["none", "client_secret_post"]);
        m
    }
    for (metadata, says) in [
        (no_grant as fn(&str) -> Value, "client-credentials grant"),
        (no_basic, "client_secret_basic"),
    ] {
        let auth = Auth::start(metadata, |_| issued("never", 3600)).await;
        let e = auth.credential().token().await.unwrap_err();
        assert!(e.message.contains(says), "{e}");
        assert!(!e.retryable);
        assert!(auth.seen("/oauth/token").is_empty(), "no secret sent");
    }
}

/// Bounds a call that must not block: it fails the test rather than hang it.
async fn prompt<T>(what: &str, f: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(2), f)
        .await
        .unwrap_or_else(|_| panic!("{what} blocked"))
}

// #1263: while one caller renews, the others serve the still-valid token at once; one mint reaches the server.
#[tokio::test]
async fn a_slow_renewal_blocks_no_caller_while_the_token_is_valid() {
    let auth = Auth::start(standard, |n| issued(&format!("tok-{n}"), 3600)).await;
    let c = auth.credential();
    assert_eq!(c.token().await.unwrap(), "tok-0");
    c.age_token(false);
    auth.hold();
    // The caller that starts the renewal doesn't wait for it either (#1375 F3).
    assert_eq!(
        prompt("the renewing caller", c.token()).await.unwrap(),
        "tok-0"
    );
    auth.mints_reach(2).await;
    let all = prompt(
        "a caller during the renewal",
        futures_util::future::join_all((0..8).map(|_| c.token())),
    )
    .await;
    assert!(all.into_iter().all(|t| t.unwrap() == "tok-0"));
    assert_eq!(auth.seen("/oauth/token").len(), 2, "one renewal mint");
    auth.open();
    prompt("the renewal", c.settled()).await;
    assert_eq!(c.token().await.unwrap(), "tok-1");
    assert_eq!(auth.seen("/oauth/token").len(), 2);
}

// #1263: with no valid token every caller waits for the one mint in flight and gets its token.
#[tokio::test]
async fn callers_with_no_valid_token_wait_for_the_mint_in_flight() {
    let auth = Auth::start(standard, |n| issued(&format!("tok-{n}"), 3600)).await;
    let c = auth.credential();
    assert_eq!(c.token().await.unwrap(), "tok-0");
    c.age_token(true);
    auth.hold();
    let callers: Vec<_> = (0..8)
        .map(|_| {
            let c = c.clone();
            tokio::spawn(async move { c.token().await })
        })
        .collect();
    auth.mints_reach(2).await;
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
    assert!(
        callers.iter().all(|t| !t.is_finished()),
        "no token to serve: they wait"
    );
    auth.open();
    for t in callers {
        assert_eq!(prompt("a waiter", t).await.unwrap().unwrap(), "tok-1");
    }
    assert_eq!(auth.seen("/oauth/token").len(), 2, "one mint shared");
}

// #1271 F8: a mint cut off mid-request counts as a failure: the next call backs off instead of minting at once.
#[tokio::test]
async fn a_cancelled_mint_backs_off_the_next() {
    let auth = Auth::start(standard, |n| issued(&format!("tok-{n}"), 3600)).await;
    let c = auth.credential().with_backoff_unit(Duration::from_secs(5));
    auth.hold();
    cut_mid_mint(&auth, &c).await;
    auth.open();
    let e = prompt("the call after a cancelled mint", c.token())
        .await
        .unwrap_err();
    assert!(e.message.contains("cancelled"), "{e}");
    assert!(e.retryable);
    assert_eq!(
        auth.seen("/oauth/token").len(),
        1,
        "no mint inside the backoff"
    );
}

// #1271 F8: a cancelled mint clears the in-flight flag, so a later call mints rather than waiting forever.
#[tokio::test]
async fn a_cancelled_mint_leaves_no_mint_in_flight() {
    let auth = Auth::start(standard, |n| issued(&format!("tok-{n}"), 3600)).await;
    let c = auth
        .credential()
        .with_backoff_unit(Duration::from_millis(50));
    auth.hold();
    cut_mid_mint(&auth, &c).await;
    auth.open();
    let started = tokio::time::Instant::now();
    assert_eq!(prompt("the next mint", c.token()).await.unwrap(), "tok-1");
    assert!(
        started.elapsed() >= Duration::from_millis(40),
        "after the backoff"
    );
    assert_eq!(auth.seen("/oauth/token").len(), 2);
}

// #1264: a replacement token rejected too backs off the next mint.
#[tokio::test]
async fn a_rejected_replacement_backs_off_the_next_mint() {
    let auth = Auth::start(standard, |n| issued(&format!("tok-{n}"), 3600)).await;
    let c = auth.credential().with_backoff_unit(Duration::from_secs(5));
    assert_eq!(c.token().await.unwrap(), "tok-0");
    c.unauthorized("tok-0").await.unwrap();
    assert!(c.unauthorized("tok-1").await.is_err());
    let e = c.token().await.unwrap_err();
    assert!(e.message.contains("backing off"), "{e}");
    assert!(e.message.contains("rejected a freshly minted token"), "{e}");
    assert!(e.retryable);
    assert_eq!(
        auth.seen("/oauth/token").len(),
        2,
        "no mint inside the backoff"
    );
}

// #1271 R3: each pending token is revoked on its own: one that fails keeps its place without holding back the rest.
#[tokio::test]
async fn a_failing_revocation_doesnt_hold_back_the_others() {
    let auth = Auth::start(standard, |n| issued(&format!("tok-{n}"), 3600)).await;
    let c = auth.credential();
    auth.revoke.lock().unwrap().extend([
        refused(503, "temporarily_unavailable"),
        refused(503, "temporarily_unavailable"),
    ]);
    assert_eq!(c.token().await.unwrap(), "tok-0");
    assert!(c.revoke().await.is_err());
    assert_eq!(c.token().await.unwrap(), "tok-1");
    // tok-0 fails again; tok-1 is revoked all the same.
    assert!(matches!(c.revoke().await, Err(Error::Unreachable(_))));
    assert_eq!(c.pending_revocations(), 1, "tok-0 kept for a retry");
    c.revoke().await.unwrap();
    let bodies: Vec<String> = auth
        .seen("/oauth/revoke")
        .into_iter()
        .map(|r| r.body)
        .collect();
    assert_eq!(
        bodies,
        ["token=tok-0", "token=tok-0", "token=tok-1", "token=tok-0"]
    );
    assert_eq!(c.pending_revocations(), 0);
}

// #1271 R3: with no revocation endpoint advertised, nothing is queued to retry.
#[tokio::test]
async fn with_no_revocation_endpoint_nothing_is_queued() {
    let auth = Auth::start(
        |b| {
            let mut m = standard(b);
            m.as_object_mut().unwrap().remove("revocation_endpoint");
            m
        },
        |n| issued(&format!("tok-{n}"), 3600),
    )
    .await;
    let c = auth.credential();
    for expected in ["tok-0", "tok-1"] {
        assert_eq!(
            c.token().await.unwrap(),
            expected,
            "out of service all the same"
        );
        let e = c.revoke().await.unwrap_err();
        assert!(e.to_string().contains("no revocation endpoint"), "{e}");
        assert_eq!(c.pending_revocations(), 0);
    }
    assert!(auth.seen("/oauth/revoke").is_empty());
}

/// Starts a `token` call, lets its mint reach the held token endpoint, then cancels the call mid-mint.
async fn cut_mid_mint(auth: &Auth, c: &ClientCredentials) {
    let minter = tokio::spawn({
        let c = c.clone();
        async move { c.token().await }
    });
    // Read apart from the await: a `borrow` held across it would block the server's count.
    let next = *auth.mints.borrow() + 1;
    auth.mints_reach(next).await;
    minter.abort();
    assert!(minter.await.unwrap_err().is_cancelled());
}

// #1271 F8: a cancelled minter wakes the callers waiting on its mint, which then go on by the backoff rather than hang.
#[tokio::test]
async fn a_cancelled_mint_wakes_its_waiters() {
    let auth = Auth::start(standard, |n| issued(&format!("tok-{n}"), 3600)).await;
    let c = auth
        .credential()
        .with_backoff_unit(Duration::from_millis(50));
    auth.hold();
    let minter = tokio::spawn({
        let c = c.clone();
        async move { c.token().await }
    });
    auth.mints_reach(1).await;
    let waiter = c.token();
    tokio::pin!(waiter);
    assert!(
        futures_util::poll!(&mut waiter).is_pending(),
        "no token to serve: it waits on the mint in flight"
    );
    minter.abort();
    assert!(minter.await.unwrap_err().is_cancelled());
    auth.open();
    assert_eq!(prompt("the waiter", waiter).await.unwrap(), "tok-1");
}

// #1263: a renewal that fails doesn't serve the token `unauthorized` took out of service while it was in flight.
#[tokio::test]
async fn a_failed_renewal_doesnt_serve_a_token_taken_out_of_service() {
    let auth = Auth::start(standard, |n| match n {
        0 => issued("tok-0", 3600),
        _ => refused(503, "temporarily_unavailable"),
    })
    .await;
    let c = auth.credential().with_backoff_unit(Duration::from_secs(5));
    assert_eq!(c.token().await.unwrap(), "tok-0");
    c.age_token(false);
    auth.hold();
    assert_eq!(c.token().await.unwrap(), "tok-0", "served while it renews");
    auth.mints_reach(2).await;
    let rejected = c.unauthorized("tok-0");
    tokio::pin!(rejected);
    assert!(futures_util::poll!(&mut rejected).is_pending());
    auth.open();
    let e = prompt("the rejection", rejected).await.unwrap_err();
    assert!(e.retryable, "{e}");
    assert!(c.token().await.is_err(), "tok-0 is out of service");
}

// #1264: the rejection backoff restarts from one unit once a token lives to its renewal unrejected.
#[tokio::test]
async fn the_rejection_backoff_resets_once_a_token_lives_to_its_renewal() {
    let auth = Auth::start(standard, |n| issued(&format!("tok-{n}"), 3600)).await;
    let c = auth.credential().with_backoff_unit(Duration::from_secs(5));
    let backoff = |e: crate::error::AuthError| {
        e.message
            .split_once("backing off for ")
            .and_then(|(_, rest)| rest.split_once("s after"))
            .map(|(secs, _)| secs.parse::<f64>().unwrap())
            .unwrap_or_else(|| panic!("no wait in {e}"))
    };
    let reject_twice = async |first: &str, second: &str| {
        c.unauthorized(first).await.unwrap();
        assert!(c.unauthorized(second).await.is_err());
        backoff(c.token().await.unwrap_err())
    };
    assert_eq!(c.token().await.unwrap(), "tok-0");
    assert!(reject_twice("tok-0", "tok-1").await <= 5.0);
    c.skip_backoff();
    assert_eq!(c.token().await.unwrap(), "tok-2");
    c.age_token(false);
    assert_eq!(c.token().await.unwrap(), "tok-2");
    prompt("the renewal", c.settled()).await;
    assert_eq!(
        c.token().await.unwrap(),
        "tok-3",
        "renewed: it lived unrejected"
    );
    assert!(
        reject_twice("tok-3", "tok-4").await <= 5.0,
        "one unit again, not two"
    );
}

// #1271: `revoke` waits for a mint in flight and revokes its token too, so no fresh token outlives the run.
#[tokio::test]
async fn revoke_waits_for_a_mint_in_flight_and_revokes_its_token() {
    let auth = Auth::start(standard, |n| issued(&format!("tok-{n}"), 3600)).await;
    let c = auth.credential();
    assert_eq!(c.token().await.unwrap(), "tok-0");
    c.age_token(false);
    auth.hold();
    assert_eq!(c.token().await.unwrap(), "tok-0", "served while it renews");
    auth.mints_reach(2).await;
    let revoking = c.revoke();
    tokio::pin!(revoking);
    assert!(
        futures_util::poll!(&mut revoking).is_pending(),
        "waits for the mint"
    );
    auth.open();
    prompt("revoke", revoking).await.unwrap();
    let bodies: Vec<String> = auth
        .seen("/oauth/revoke")
        .into_iter()
        .map(|r| r.body)
        .collect();
    assert_eq!(bodies, ["token=tok-0", "token=tok-1"]);
    assert_eq!(
        c.token().await.unwrap(),
        "tok-2",
        "the revoked tok-1 is never served"
    );
}

// With nothing to revoke, `revoke` sends nothing, not even the metadata read, and succeeds even where the server couldn't revoke.
#[tokio::test]
async fn revoke_with_nothing_to_revoke_sends_nothing() {
    let auth = Auth::start(
        |b| {
            let mut m = standard(b);
            m.as_object_mut().unwrap().remove("revocation_endpoint");
            m
        },
        |n| issued(&format!("tok-{n}"), 3600),
    )
    .await;
    let c = auth.credential();
    c.revoke().await.unwrap();
    assert!(auth.seen.lock().unwrap().is_empty(), "nothing sent");
}

// #1265: every token a mint installs moves `changes`, the first, a renewal and a 401's replacement alike; a cached token doesn't.
#[tokio::test]
async fn each_installed_token_moves_the_change_generation() {
    let auth = Auth::start(standard, |n| issued(&format!("tok-{n}"), 3600)).await;
    let c = auth.credential();
    let mut changes = c.changes().expect("a minting credential reports changes");
    assert!(!changes.has_changed().unwrap());
    assert_eq!(c.token().await.unwrap(), "tok-0");
    assert!(changes.has_changed().unwrap(), "the first mint");
    changes.mark_unchanged();
    assert_eq!(c.token().await.unwrap(), "tok-0");
    assert!(
        !changes.has_changed().unwrap(),
        "a cached token is no change"
    );
    c.age_token(false);
    assert_eq!(c.token().await.unwrap(), "tok-0");
    prompt("the renewal", c.settled()).await;
    assert!(changes.has_changed().unwrap(), "a renewal");
    assert_eq!(c.token().await.unwrap(), "tok-1");
    changes.mark_unchanged();
    c.unauthorized("tok-1").await.unwrap();
    assert!(changes.has_changed().unwrap(), "a rejection's replacement");
    assert_eq!(c.token().await.unwrap(), "tok-2");
}

// #1375 F3: the last clone's drop aborts a renewal in flight rather than leave it holding the state until its request times out.
#[tokio::test]
async fn dropping_the_credential_aborts_its_renewal() {
    let auth = Auth::start(standard, |n| issued(&format!("tok-{n}"), 3600)).await;
    let c = auth.credential();
    assert_eq!(c.token().await.unwrap(), "tok-0");
    c.age_token(false);
    auth.hold();
    let mut changes = c.changes().unwrap();
    let clone = c.clone();
    assert_eq!(c.token().await.unwrap(), "tok-0");
    auth.mints_reach(2).await;
    drop(c);
    assert!(
        futures_util::poll!(std::pin::pin!(changes.changed())).is_pending(),
        "a clone keeps the renewal"
    );
    drop(clone);
    // The state goes with the aborted task: its change sender closes.
    assert!(
        prompt("the renewal's end", changes.changed())
            .await
            .is_err()
    );
}

// #1375 F4: a rejection answered by a renewal already in flight marks the renewal's token, so its own rejection mints no third token.
#[tokio::test]
async fn a_renewal_installed_after_a_rejection_carries_the_rejection_mark() {
    let auth = Auth::start(standard, |n| issued(&format!("tok-{n}"), 3600)).await;
    let c = auth.credential().with_backoff_unit(Duration::from_secs(5));
    assert_eq!(c.token().await.unwrap(), "tok-0");
    c.age_token(false);
    auth.hold();
    assert_eq!(c.token().await.unwrap(), "tok-0");
    auth.mints_reach(2).await;
    let rejected = c.unauthorized("tok-0");
    tokio::pin!(rejected);
    assert!(
        futures_util::poll!(&mut rejected).is_pending(),
        "waits for the renewal"
    );
    auth.open();
    prompt("the rejection", rejected).await.unwrap();
    assert_eq!(c.token().await.unwrap(), "tok-1");
    assert!(c.unauthorized("tok-1").await.is_err(), "no third mint");
    assert_eq!(auth.seen("/oauth/token").len(), 2);
}

// #1375 F4: a rejection of a token another caller's mint already replaced marks the replacement it is handed.
#[tokio::test]
async fn a_replacement_handed_to_a_stale_rejection_carries_the_mark() {
    let auth = Auth::start(standard, |n| issued(&format!("tok-{n}"), 3600)).await;
    let c = auth.credential().with_backoff_unit(Duration::from_secs(5));
    assert_eq!(c.token().await.unwrap(), "tok-0");
    c.age_token(false);
    assert_eq!(c.token().await.unwrap(), "tok-0");
    prompt("the renewal", c.settled()).await;
    c.unauthorized("tok-0").await.unwrap();
    assert_eq!(c.token().await.unwrap(), "tok-1");
    assert!(c.unauthorized("tok-1").await.is_err(), "no third mint");
    assert_eq!(auth.seen("/oauth/token").len(), 2);
}

// #1375 F5: a token no caller used proves nothing when it reaches its renewal: the rejection count stands, and the next rejected replacement backs off two units.
#[tokio::test]
async fn an_unused_token_reaching_its_renewal_keeps_the_rejection_count() {
    let auth = Auth::start(standard, |n| issued(&format!("tok-{n}"), 3600)).await;
    let c = auth.credential().with_backoff_unit(Duration::from_secs(5));
    let backoff = |e: crate::error::AuthError| {
        e.message
            .split_once("backing off for ")
            .and_then(|(_, rest)| rest.split_once("s after"))
            .map(|(secs, _)| secs.parse::<f64>().unwrap())
            .unwrap_or_else(|| panic!("no wait in {e}"))
    };
    assert_eq!(c.token().await.unwrap(), "tok-0");
    c.unauthorized("tok-0").await.unwrap();
    assert!(c.unauthorized("tok-1").await.is_err());
    c.skip_backoff();
    // A replacement minted for a request that never retried with it: no caller uses tok-2.
    c.unauthorized("tok-1").await.unwrap();
    c.age_token(false);
    assert_eq!(c.token().await.unwrap(), "tok-2");
    prompt("the renewal", c.settled()).await;
    c.unauthorized("tok-3").await.unwrap();
    assert!(c.unauthorized("tok-4").await.is_err());
    assert!(
        backoff(c.token().await.unwrap_err()) > 5.0,
        "the second rejection in a row: two units"
    );
}

// #1375 F4 (audit F1): a transient failure of the rejection's own mint keeps the mark for the retry's token, so the server rejecting that one too mints no third token.
#[tokio::test]
async fn a_transient_mint_failure_keeps_the_rejection_mark() {
    let auth = Auth::start(standard, |n| match n {
        1 => refused(503, "temporarily_unavailable"),
        _ => issued(&format!("tok-{n}"), 3600),
    })
    .await;
    let c = auth
        .credential()
        .with_backoff_unit(Duration::from_millis(50));
    assert_eq!(c.token().await.unwrap(), "tok-0");
    c.unauthorized("tok-0").await.unwrap();
    assert_eq!(c.token().await.unwrap(), "tok-2");
    assert!(
        c.unauthorized("tok-2").await.is_err(),
        "{} mints",
        auth.seen("/oauth/token").len()
    );
    assert_eq!(auth.seen("/oauth/token").len(), 3);
}
