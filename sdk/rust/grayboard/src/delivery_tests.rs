//! The delivery stream's rules (#929; the table in `docs/sdk-rust.md` §2), one test per row, against a stateful scripted bus on the fake endpoint.

use crate::tests::{Fake, Reply, Req, event, fast, hint};
use crate::transport::Timeouts;
use crate::{
    Client, ClientInfo, Delivery, DeliveryMode, DeliveryStream, Error, Session, StaticBearer,
};
use futures_util::StreamExt;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;

const EMAIL: &str = "u@example.com";
const INBOX: &str = "grayboard://inbox";

fn addr(name: &str) -> String {
    format!("{EMAIL}/{name}")
}

type Script = Box<dyn FnOnce(&Req, &mut Bus) -> Reply + Send>;

/// One request as the bus saw it: `op` is `sub:<tool>`, `native:<tool>`, `read` or `listen`.
#[derive(Debug, Clone)]
struct Call {
    op: String,
    lease: Option<String>,
    args: Value,
    at: std::time::Instant,
}

/// A small model of the server's lease protocol: holds, ownership, bind generation, one lease, pending items.
#[derive(Default)]
struct Bus {
    held: Vec<String>,
    ownership: u64,
    bind_gen: u64,
    lease: Option<String>,
    opens: u32,
    pending: Vec<Value>,
    alias_lost: Vec<String>,
    /// The next N renews are refused `not_found` (a lost lease).
    renew_refusals: u32,
    /// A held-open native response: its request ID and the stream to answer it on.
    parked: Option<(Value, mpsc::UnboundedSender<Vec<u8>>)>,
    script: HashMap<String, VecDeque<Script>>,
    streams: Vec<mpsc::UnboundedSender<Vec<u8>>>,
    log: Vec<Call>,
}

fn refusal(req: &Req, code: &str) -> Reply {
    Reply::result(
        req,
        json!({"content": [{"type": "text", "text": format!("error: {code}")}], "structuredContent": {"code": code}, "isError": true}),
    )
}

fn value(req: &Req, v: Value) -> Reply {
    Reply::result(
        req,
        json!({"content": [{"type": "text", "text": v.to_string()}]}),
    )
}

impl Bus {
    fn new(held: &[&str]) -> Self {
        Self {
            held: held.iter().map(|n| addr(n)).collect(),
            ownership: 1,
            bind_gen: 1,
            ..Self::default()
        }
    }

    fn on(&mut self, op: &str, script: impl FnOnce(&Req, &mut Bus) -> Reply + Send + 'static) {
        self.script
            .entry(op.into())
            .or_default()
            .push_back(Box::new(script));
    }

    fn direct(&mut self, n: u64) {
        self.pending.push(json!({"id": format!("direct:{n}"), "actionable": true, "event": {"kind": "direct", "message": {"id": n, "body": format!("m{n}")}}}));
    }

    fn hint(&mut self) {
        self.streams.retain(|s| s.send(hint().into_bytes()).is_ok());
    }

    /// Ends every open listen stream, as a server restart or a dropped connection does.
    fn close_streams(&mut self) {
        self.streams.clear();
    }

    fn bind(&mut self, name: &str) -> bool {
        let address = if name.contains('/') {
            name.to_owned()
        } else {
            addr(name)
        };
        if self.held.contains(&address) {
            return false;
        }
        self.held.push(address);
        self.bind_gen += 1;
        self.lease = None;
        true
    }

    fn whoami(&self) -> Value {
        let mut v = json!({"id": "s-1", "principal": EMAIL, "held": self.held, "primary": self.held.first(), "ownership": self.ownership});
        if !self.alias_lost.is_empty() {
            v["alias_lost"] = json!(
                self.alias_lost
                    .iter()
                    .map(|a| json!({"alias": a, "reason": "revoked"}))
                    .collect::<Vec<_>>()
            );
        }
        if self.held.is_empty() {
            v["unbound"] = json!(true);
        }
        v
    }

    fn leased(&self, req: &Req) -> bool {
        self.lease.is_some() && req.headers.get("x-grayboard-lease") == self.lease.as_ref()
    }

    fn handle(&mut self, req: &Req) -> Reply {
        let subscriber =
            req.headers.get("x-grayboard-client").map(String::as_str) == Some("subscriber");
        let op = match req.method() {
            "tools/call" => format!(
                "{}:{}",
                if subscriber { "sub" } else { "native" },
                req.body["params"]["name"].as_str().unwrap_or("")
            ),
            "resources/read" => "read".into(),
            "subscriptions/listen" => "listen".into(),
            "notifications/cancelled" => {
                self.log.push(Call {
                    op: "cancel".into(),
                    lease: req.headers.get("x-grayboard-lease").cloned(),
                    args: Value::Null,
                    at: std::time::Instant::now(),
                });
                return Reply::status(202, "");
            }
            other => panic!("unexpected {other}"),
        };
        self.log.push(Call {
            op: op.clone(),
            lease: req.headers.get("x-grayboard-lease").cloned(),
            args: req.body["params"]["arguments"].clone(),
            at: std::time::Instant::now(),
        });
        if let Some(script) = self.script.get_mut(&op).and_then(VecDeque::pop_front) {
            return script(req, self);
        }
        let args = &req.body["params"]["arguments"];
        match op.as_str() {
            "sub:whoami" => value(req, self.whoami()),
            "native:whoami" => value(req, self.whoami()),
            "sub:bind" | "native:bind" => {
                let name = args["name"].as_str().unwrap().to_owned();
                self.bind(&name);
                Reply::result(
                    req,
                    json!({"content": [{"type": "text", "text": "bound"}], "structuredContent": {"name": name, "instructions": ["line"], "ownership": self.ownership}}),
                )
            }
            "native:unbind" => {
                let address = addr(args["name"].as_str().unwrap());
                self.held.retain(|h| *h != address);
                self.bind_gen += 1;
                self.lease = None;
                Reply::result(
                    req,
                    json!({"content": [{"type": "text", "text": "released"}], "structuredContent": {"name": self.held.first().map(|h| h.trim_start_matches(&format!("{EMAIL}/")).to_owned()), "instructions": [], "ownership": self.ownership}}),
                )
            }
            "sub:delivery_open" => {
                if self.held.is_empty() {
                    return refusal(req, "unbound");
                }
                self.opens += 1;
                let cap = format!("c{:042}", self.opens);
                self.lease = Some(cap.clone());
                self.alias_lost.clear();
                value(
                    req,
                    json!({"capability": cap, "identity": {"user_email": EMAIL, "identity_full": self.held[0], "teams": []}, "ownership": self.ownership, "bind_gen": self.bind_gen, "expiresAt": 1.0e13}),
                )
            }
            "sub:delivery_renew" => {
                if self.renew_refusals > 0 {
                    self.renew_refusals -= 1;
                    return refusal(req, "not_found");
                }
                if !self.leased(req) {
                    return refusal(req, "not_found");
                }
                value(req, json!({"ok": true}))
            }
            "sub:delivery_receipt" => {
                if !self.leased(req) {
                    return refusal(req, "not_found");
                }
                let ids: Vec<String> = args["ids"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|i| i.as_str().unwrap().to_owned())
                    .collect();
                if !ids
                    .iter()
                    .all(|id| self.pending.iter().any(|p| p["id"] == json!(id)))
                {
                    return refusal(req, "not_found");
                }
                self.pending
                    .retain(|p| !ids.iter().any(|id| p["id"] == json!(id)));
                value(req, json!({"ok": true}))
            }
            "sub:delivery_release" => {
                if !self.leased(req) {
                    return refusal(req, "not_found");
                }
                // Release ends the session; the same ID's next request starts a new ownership, unbound.
                self.lease = None;
                self.held.clear();
                self.ownership += 1;
                self.bind_gen = 0;
                self.close_streams();
                value(req, json!({"ok": true}))
            }
            "sub:session_end" => value(req, json!({"ended": true})),
            "read" => {
                if !self.leased(req) {
                    return Reply::json(
                        json!({"jsonrpc": "2.0", "id": req.id(), "error": {"code": -32602, "message": "no lease", "data": {"code": "not_found"}}}),
                    );
                }
                let items: Vec<Value> = self
                    .pending
                    .iter()
                    .take(100)
                    .map(|p| {
                        let mut p = p.clone();
                        p["ownership"] = json!(self.ownership);
                        p["bind_gen"] = json!(self.bind_gen);
                        p
                    })
                    .collect();
                let text = json!({"items": items}).to_string();
                Reply::result(
                    req,
                    json!({"contents": [{"uri": INBOX, "mimeType": "application/json", "text": text}]}),
                )
            }
            "listen" => {
                let (tx, rx) = mpsc::unbounded_channel();
                self.streams.push(tx);
                let ack = event(
                    json!({"jsonrpc": "2.0", "method": "notifications/subscriptions/acknowledged", "params": {"notifications": {"resourceSubscriptions": [INBOX]}}}),
                );
                Reply::live(vec![ack], rx)
            }
            _ => Reply::result(req, json!({"content": [{"type": "text", "text": "ok"}]})),
        }
    }
}

struct World {
    _fake: Fake,
    url: String,
    bus: Arc<Mutex<Bus>>,
    session: Option<Session>,
}

impl World {
    async fn start(bus: Bus) -> Self {
        Self::with(bus, |_| {}).await
    }

    async fn with(bus: Bus, tune: impl FnOnce(&mut Timeouts)) -> Self {
        let bus = Arc::new(Mutex::new(bus));
        let shared = Arc::clone(&bus);
        let fake = Fake::start(false, move |req, _| shared.lock().unwrap().handle(req)).await;
        let mut t = fast();
        tune(&mut t);
        let session = Client::new(
            &fake.url,
            StaticBearer::new("tok-1"),
            ClientInfo::new("rust-sdk-test", "0.0.1"),
        )
        .unwrap()
        .with_timeouts(t)
        .session("s-1", DeliveryMode::push("rust-sdk-test").unwrap());
        Self {
            url: fake.url.clone(),
            _fake: fake,
            bus,
            session: Some(session),
        }
    }

    fn s(&self) -> &Session {
        self.session.as_ref().expect("the session is open")
    }

    fn bus(&self) -> std::sync::MutexGuard<'_, Bus> {
        self.bus.lock().unwrap()
    }

    fn ops(&self) -> Vec<String> {
        self.bus().log.iter().map(|c| c.op.clone()).collect()
    }

    fn calls(&self, op: &str) -> Vec<Call> {
        self.bus()
            .log
            .iter()
            .filter(|c| c.op == op)
            .cloned()
            .collect()
    }

    fn count(&self, op: &str) -> usize {
        self.calls(op).len()
    }

    /// Polls `cond` until it holds; panics naming `what` after 5 s.
    async fn until(&self, what: &str, cond: impl Fn(&Bus) -> bool) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            if cond(&self.bus()) {
                return;
            }
            if tokio::time::Instant::now() > deadline {
                panic!("timed out waiting until {what}; ops: {:?}", self.ops());
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    }
}

fn ops_count(bus: &Bus, op: &str) -> usize {
    bus.log.iter().filter(|c| c.op == op).count()
}

async fn next(stream: &mut DeliveryStream) -> Result<Delivery, Error> {
    tokio::time::timeout(Duration::from_secs(5), stream.next())
        .await
        .expect("the stream yields within 5 s")
        .expect("the stream has not ended")
}

async fn ended(stream: &mut DeliveryStream) {
    let end = tokio::time::timeout(Duration::from_secs(5), stream.next())
        .await
        .expect("the stream ends within 5 s");
    assert!(end.is_none(), "the stream ended, not {end:?}");
}

fn stopped(r: Result<Delivery, Error>) -> (&'static str, Option<String>) {
    match r {
        Err(Error::DeliveryStopped { code, item, .. }) => (code, item),
        other => panic!("expected DeliveryStopped, got {other:?}"),
    }
}

/// The ops after the `n`-th `op`.
fn after(ops: &[String], op: &str, n: usize) -> Vec<String> {
    let at = ops
        .iter()
        .enumerate()
        .filter(|(_, o)| *o == op)
        .nth(n - 1)
        .map(|(i, _)| i)
        .unwrap_or_else(|| panic!("no {n}th {op} in {ops:?}"));
    ops[at + 1..].to_vec()
}

// Row: Open: whoami; if nothing is held, bind the remembered holds with create: false.
#[tokio::test]
async fn open_binds_the_remembered_holds_with_create_false_when_nothing_is_held() {
    let w = World::start(Bus::new(&["a", "b"])).await;
    let stream = w.s().deliveries();
    w.until("the first lease listens", |b| ops_count(b, "listen") == 1)
        .await;
    {
        let mut b = w.bus();
        // The server ended the session under the stream (an expired lease): a new ownership, nothing held.
        b.held.clear();
        b.lease = None;
        b.ownership = 2;
        b.close_streams();
    }
    w.until("the second lease listens", |b| ops_count(b, "listen") == 2)
        .await;
    let binds = w.calls("sub:bind");
    assert_eq!(
        binds.iter().map(|c| c.args.clone()).collect::<Vec<_>>(),
        vec![
            json!({"name": addr("a"), "create": false}),
            json!({"name": addr("b"), "create": false})
        ]
    );
    // The first lease's one read, then the reopen.
    let tail = after(&w.ops(), "read", 1);
    assert_eq!(
        &tail[..4],
        ["sub:whoami", "sub:bind", "sub:bind", "sub:delivery_open"]
    );
    drop(stream);
}

// Row: Open: … if holds differ from expected, stop.
#[tokio::test]
async fn open_stops_when_the_holds_changed_without_a_bind_through_the_session() {
    let w = World::start(Bus::new(&["a"])).await;
    let mut stream = w.s().deliveries();
    w.until("the first lease listens", |b| ops_count(b, "listen") == 1)
        .await;
    {
        let mut b = w.bus();
        b.held.push(addr("other"));
        b.close_streams();
    }
    assert_eq!(stopped(next(&mut stream).await).0, "holds_changed");
    ended(&mut stream).await;
    assert_eq!(w.count("sub:delivery_open"), 1);
}

// Row: whoami reports alias_lost: drop those holds; if none remain, stop (alias_lost).
#[tokio::test]
async fn alias_lost_drops_the_lost_holds_and_stops_when_none_remain() {
    let w = World::start(Bus::new(&["a", "b"])).await;
    let mut stream = w.s().deliveries();
    w.until("the first lease listens", |b| ops_count(b, "listen") == 1)
        .await;
    {
        let mut b = w.bus();
        b.held = vec![addr("b")];
        b.alias_lost = vec![addr("a")];
        b.close_streams();
    }
    // Reopens holding b alone, without binding a again: the lease names b.
    w.until("the second lease listens", |b| ops_count(b, "listen") == 2)
        .await;
    assert_eq!(w.count("sub:bind"), 0);
    {
        let mut b = w.bus();
        b.held.clear();
        b.alias_lost = vec![addr("b")];
        b.close_streams();
    }
    assert_eq!(stopped(next(&mut stream).await).0, "alias_lost");
    ended(&mut stream).await;
    assert_eq!(w.count("sub:bind"), 0);
}

// Row: a native result with unbound: true or the alias_lost marker: stop delivery, rebind the remembered holds, reopen.
#[tokio::test]
async fn a_native_unbound_or_alias_lost_result_restarts_delivery_and_nothing_else_does() {
    let mut w = World::start(Bus::new(&["a"])).await;
    let _stream = w.s().deliveries();
    w.until("the first lease listens", |b| ops_count(b, "listen") == 1)
        .await;
    // A plain result restarts nothing.
    w.s().call_raw("board_read", json!({})).await.unwrap();
    {
        let mut b = w.bus();
        b.held.clear();
        b.lease = None;
    }
    // The native whoami says unbound: the stream rebinds a with create: false and reopens, with its listen stream still open.
    let r = w.s().call_raw("whoami", json!({})).await.unwrap();
    assert!(r.texts().next().unwrap().contains("\"unbound\":true"));
    w.until("the rebound lease listens", |b| ops_count(b, "listen") == 2)
        .await;
    assert_eq!(
        w.calls("sub:bind")[0].args,
        json!({"name": addr("a"), "create": false})
    );
    w.bus().on("native:board_read", |req, _| {
        Reply::result(
            req,
            json!({"content": [{"type": "text", "text": "ok"}], "_meta": {"io.github.nolnoch.grayboard/alias_lost": true}}),
        )
    });
    w.s().call_raw("board_read", json!({})).await.unwrap();
    w.until("the marked result's reopen listens", |b| {
        ops_count(b, "listen") == 3
    })
    .await;
    w.session.take().unwrap().end().await.unwrap();
    // Two restarts, so three whoamis (the first open's included): the plain result added none.
    assert_eq!(w.calls("sub:whoami").len(), 3, "ops: {:?}", w.ops());
}

// Row: delivery_open's lease is validated (a lease naming another identity reopens once, then stops).
#[tokio::test]
async fn an_invalid_lease_reopens_once_then_stops() {
    let bus = Bus::new(&["a"]);
    let w = World::start(bus).await;
    for _ in 0..2 {
        w.bus().on("sub:delivery_open", |req, b| {
            value(
                req,
                json!({"capability": "short", "identity": {"user_email": EMAIL, "identity_full": b.held[0]}, "ownership": 1, "bind_gen": 1, "expiresAt": 1.0e13}),
            )
        });
    }
    let mut stream = w.s().deliveries();
    assert_eq!(stopped(next(&mut stream).await).0, "identity");
    assert_eq!(w.count("sub:delivery_open"), 2);
    assert_eq!(w.count("listen"), 0);
}

// Row: … send the capability as X-Grayboard-Lease (and only on lease operations: this connection outlives leases).
#[tokio::test]
async fn the_lease_header_rides_lease_operations_only() {
    let w = World::with(Bus::new(&["a"]), |t| t.renew = Duration::from_millis(30)).await;
    let _stream = w.s().deliveries();
    w.until("a renew lands", |b| ops_count(b, "sub:delivery_renew") >= 1)
        .await;
    w.bus().renew_refusals = 1;
    w.until("the second lease renews", |b| {
        b.opens == 2 && b.log.last().is_some_and(|c| c.op == "sub:delivery_renew")
    })
    .await;
    let log = w.bus().log.clone();
    for c in &log {
        match c.op.as_str() {
            "sub:whoami" | "sub:delivery_open" | "sub:bind" => {
                assert_eq!(c.lease, None, "{} carried a lease", c.op)
            }
            "read" | "listen" | "sub:delivery_renew" => assert!(
                c.lease
                    .as_deref()
                    .is_some_and(|l| l.starts_with('c') && l.len() == 43),
                "{} carried {:?}",
                c.op,
                c.lease
            ),
            _ => {}
        }
    }
    // After the loss, the second capability.
    assert_eq!(
        log.last().unwrap().lease.as_deref(),
        Some(format!("c{:042}", 2).as_str())
    );
}

// Rows: a hint only marks the inbox dirty; the first read is unconditional; 100 items means read again. No client cursor.
#[tokio::test]
async fn hints_mark_the_inbox_dirty_and_a_full_page_reads_again() {
    let mut bus = Bus::new(&["a"]);
    for n in 1..=101 {
        bus.direct(n);
    }
    let w = World::start(bus).await;
    let mut stream = w.s().deliveries();
    let mut got = Vec::new();
    for _ in 0..101 {
        let d = next(&mut stream).await.unwrap();
        got.push(d.id.clone());
        d.receipt().await.unwrap();
    }
    assert_eq!(got.last().unwrap(), "direct:101");
    // One read for the first page, one because it was full; no hint, no renew.
    assert_eq!(w.count("read"), 2);
    let reads: Vec<Value> = w
        ._fake
        .requests()
        .into_iter()
        .filter(|r| r.method() == "resources/read")
        .map(|r| r.body["params"].clone())
        .collect();
    for params in &reads {
        let mut keys: Vec<&String> = params.as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(keys, ["_meta", "uri"], "the read names no cursor");
    }
    // Now idle: a hint reads again; nothing else does.
    w.bus().hint();
    w.until("the hint's read", |b| ops_count(b, "read") == 3)
        .await;
    w.bus().direct(200);
    w.bus().hint();
    assert_eq!(next(&mut stream).await.unwrap().id, "direct:200");
}

// Row: per item, in order: check ownership/bind_gen/address, delivery_renew, hand over, renew in the background until receipt(), then delivery_receipt({ ids: [id] }).
#[tokio::test]
async fn each_item_is_renewed_before_hand_over_and_receipted_by_id() {
    let mut bus = Bus::new(&["a"]);
    bus.direct(1);
    // A renew interval far beyond the test, so the only renew is the one before the hand-over.
    let w = World::with(bus, |t| t.renew = Duration::from_secs(60)).await;
    let mut stream = w.s().deliveries();
    let d = next(&mut stream).await.unwrap();
    let ops = w.ops();
    let read = ops.iter().position(|o| o == "read").unwrap();
    assert_eq!(
        ops[read + 1..],
        ["sub:delivery_renew"],
        "renewed, then handed over"
    );
    assert_eq!(d.id, "direct:1");
    d.receipt().await.unwrap();
    let receipts = w.calls("sub:delivery_receipt");
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0].args, json!({"ids": ["direct:1"]}));
}

#[tokio::test]
async fn an_item_out_is_renewed_in_the_background_without_reading_the_inbox() {
    let mut bus = Bus::new(&["a"]);
    bus.direct(1);
    let w = World::with(bus, |t| t.renew = Duration::from_millis(25)).await;
    let mut stream = w.s().deliveries();
    let d = next(&mut stream).await.unwrap();
    w.until("three renews while out", |b| {
        ops_count(b, "sub:delivery_renew") >= 4
    })
    .await;
    assert_eq!(w.count("read"), 1);
    d.receipt().await.unwrap();
}

#[tokio::test]
async fn an_item_under_another_ownership_or_an_unheld_address_stops_the_stream() {
    for wrong in ["ownership", "address"] {
        let mut bus = Bus::new(&["a"]);
        bus.direct(1);
        let w = World::start(bus).await;
        w.bus().on("read", move |req, b| {
            let mut item = b.pending[0].clone();
            item["ownership"] = json!(if wrong == "ownership" { 9 } else { b.ownership });
            item["bind_gen"] = json!(b.bind_gen);
            if wrong == "address" {
                item["address"] = json!(addr("not-mine"));
            }
            let text = json!({"items": [item]}).to_string();
            Reply::result(req, json!({"contents": [{"uri": INBOX, "text": text}]}))
        });
        let mut stream = w.s().deliveries();
        assert_eq!(
            stopped(next(&mut stream).await),
            ("identity", Some("direct:1".into())),
            "{wrong}"
        );
        assert_eq!(
            w.count("sub:delivery_renew"),
            0,
            "{wrong}: checked before the renew"
        );
    }
}

// Row: dedup: an item accepted but not receipted survives a reconnect in-process; the retry goes straight to the receipt.
#[tokio::test]
async fn an_accepted_item_whose_receipt_was_lost_goes_straight_to_the_receipt() {
    let mut bus = Bus::new(&["a"]);
    bus.direct(1);
    bus.on("sub:delivery_receipt", |_, b| {
        b.close_streams();
        Reply::status(503, "gateway")
    });
    let w = World::start(bus).await;
    let mut stream = w.s().deliveries();
    let d = next(&mut stream).await.unwrap();
    // Resolves only once the retried receipt lands: a second hand-over would wait for a receipt nobody sends.
    tokio::time::timeout(Duration::from_secs(5), d.receipt())
        .await
        .expect("the receipt resolves")
        .unwrap();
    assert_eq!(w.count("sub:delivery_receipt"), 2);
    assert_eq!(w.count("sub:delivery_open"), 2);
    let receipts = w.calls("sub:delivery_receipt");
    assert_eq!(
        receipts[1].lease.as_deref(),
        Some(format!("c{:042}", 2).as_str())
    );
    assert!(w.bus().pending.is_empty());
}

// Row: durable dedup is the consumer's: stable_id hashes principal, resource, address, item ID and session ID (no issuer).
#[tokio::test]
async fn stable_id_hashes_principal_resource_address_item_and_session() {
    let mut bus = Bus::new(&["a"]);
    bus.pending.push(json!({"id": "direct:7", "actionable": true, "address": addr("a"), "event": {"kind": "direct", "message": {"id": 7}}}));
    bus.direct(8);
    let w = World::start(bus).await;
    let mut stream = w.s().deliveries();
    let sha = |s: String| {
        let digest = Sha256::digest(s.as_bytes());
        format!(
            "msg_{}",
            digest
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        )
    };
    let d = next(&mut stream).await.unwrap();
    assert_eq!(
        d.stable_id,
        sha(format!(
            r#"[1,"{EMAIL}","{}","{}","direct:7","s-1"]"#,
            w.url,
            addr("a")
        ))
    );
    d.receipt().await.unwrap();
    let d = next(&mut stream).await.unwrap();
    assert_eq!(
        d.stable_id,
        sha(format!(
            r#"[1,"{EMAIL}","{}",null,"direct:8","s-1"]"#,
            w.url
        ))
    );
}

// Row: renew every interval while idle (and holding: above); a renew re-reads the inbox.
#[tokio::test]
async fn the_lease_renews_on_its_interval_and_each_idle_renew_reads_the_inbox() {
    let w = World::with(Bus::new(&["a"]), |t| t.renew = Duration::from_millis(20)).await;
    let _stream = w.s().deliveries();
    w.until("three idle renews", |b| {
        ops_count(b, "sub:delivery_renew") >= 3
    })
    .await;
    let ops = w.ops();
    let tail = after(&ops, "listen", 1);
    // Each renew is followed by its read.
    for (i, op) in tail.iter().enumerate() {
        if op == "sub:delivery_renew" && i + 1 < tail.len() {
            assert_eq!(tail[i + 1], "read", "{tail:?}");
        }
    }
}

// Row: stream closed or unreachable: reopen from whoami, backoff, no limit.
#[tokio::test]
async fn closed_streams_reopen_without_limit() {
    let w = World::start(Bus::new(&["a"])).await;
    let mut stream = w.s().deliveries();
    for n in 1..=12 {
        w.until("the lease listens", |b| ops_count(b, "listen") == n)
            .await;
        w.bus().close_streams();
    }
    // Twelve outages, more than the failure limit, and the stream still delivers.
    w.until("the 13th lease listens", |b| ops_count(b, "listen") == 13)
        .await;
    assert_eq!(w.count("sub:whoami"), 13);
    w.bus().direct(1);
    w.bus().hint();
    assert_eq!(next(&mut stream).await.unwrap().id, "direct:1");
}

// Row: lease lost (not_found/unbound on a delivery_* call): reopen; more than 3 losses outside an item stops.
#[tokio::test]
async fn a_fourth_lease_loss_outside_an_item_stops() {
    let w = World::with(Bus::new(&["a"]), |t| t.renew = Duration::from_millis(10)).await;
    w.bus().renew_refusals = 100;
    let mut stream = w.s().deliveries();
    assert_eq!(stopped(next(&mut stream).await).0, "lease_lost");
    assert_eq!(w.count("sub:delivery_open"), 4);
    assert_eq!(w.count("sub:delivery_renew"), 4);
}

// Decision: a lease lost while the caller holds an item reopens; the same ownership:bind_gen:id key keeps the handle, which receipts under the new capability, and spends no recovery.
#[tokio::test]
async fn a_lease_lost_while_an_item_is_out_keeps_its_handle_under_the_same_key() {
    let mut bus = Bus::new(&["a"]);
    bus.direct(1);
    let w = World::with(bus, |t| t.renew = Duration::from_millis(10)).await;
    let mut stream = w.s().deliveries();
    let d = next(&mut stream).await.unwrap();
    // Three losses while out, the most a reopen tolerates without a healthy renew.
    w.bus().renew_refusals = 3;
    w.until("three losses and a healthy lease", |b| {
        b.renew_refusals == 0
            && b.opens >= 4
            && b.log.last().is_some_and(|c| c.op == "sub:delivery_renew")
    })
    .await;
    d.receipt().await.unwrap();
    let opens = w.bus().opens;
    let receipt = w.calls("sub:delivery_receipt");
    assert_eq!(receipt.len(), 1);
    assert_eq!(
        receipt[0].lease.as_deref(),
        Some(format!("c{opens:042}").as_str())
    );
}

#[tokio::test]
async fn a_reopen_under_another_bind_generation_loses_the_handle_and_shows_the_item_again() {
    let mut bus = Bus::new(&["a"]);
    bus.direct(1);
    let w = World::start(bus).await;
    let mut stream = w.s().deliveries();
    let first = next(&mut stream).await.unwrap();
    {
        let mut b = w.bus();
        b.bind_gen += 1;
        b.close_streams();
    }
    let again = next(&mut stream).await.unwrap();
    assert_eq!(again.id, "direct:1");
    assert_eq!(again.stable_id, first.stable_id);
    match first.receipt().await {
        Err(Error::DeliveryLost(why)) => assert!(
            why.contains("another ownership or bind generation"),
            "{why}"
        ),
        other => panic!("{other:?}"),
    }
    again.receipt().await.unwrap();
    assert_eq!(w.count("sub:delivery_receipt"), 1);
}

// Row: an item attempted more than 8 times stops the stream and names the item.
#[tokio::test]
async fn an_item_dropped_eight_times_stops_the_stream_naming_it() {
    let mut bus = Bus::new(&["a"]);
    bus.direct(1);
    let w = World::start(bus).await;
    let mut stream = w.s().deliveries();
    for _ in 0..8 {
        drop(next(&mut stream).await.unwrap());
    }
    assert_eq!(
        stopped(next(&mut stream).await),
        ("retry_exhausted", Some("direct:1".into()))
    );
    ended(&mut stream).await;
    assert_eq!(w.count("sub:delivery_receipt"), 0);
}

// Row: the attempt count is per item, not per failure: an item out across nine reopens (outages, which spend no failure) stops on its ninth showing.
#[tokio::test]
async fn an_item_shown_a_ninth_time_stops_the_stream_even_without_failures() {
    let mut bus = Bus::new(&["a"]);
    bus.direct(1);
    let w = World::start(bus).await;
    let mut stream = w.s().deliveries();
    let held = next(&mut stream).await.unwrap();
    for n in 1..=8 {
        w.until("the item is shown again", |b| {
            ops_count(b, "sub:delivery_renew") == n
        })
        .await;
        w.bus().close_streams();
    }
    assert_eq!(
        stopped(next(&mut stream).await),
        ("retry_exhausted", Some("direct:1".into()))
    );
    assert!(matches!(held.receipt().await, Err(Error::DeliveryLost(_))));
    assert_eq!(w.count("sub:delivery_open"), 9);
}

// Row: … or 8 other failures in a row.
#[tokio::test]
async fn eight_failures_in_a_row_stop_the_stream() {
    let w = World::start(Bus::new(&["a"])).await;
    for _ in 0..20 {
        w.bus().on("read", |req, _| {
            Reply::result(
                req,
                json!({"contents": [{"uri": INBOX, "text": "{\"items\": 7}"}]}),
            )
        });
    }
    let mut stream = w.s().deliveries();
    assert_eq!(stopped(next(&mut stream).await).0, "retry_exhausted");
    assert_eq!(w.count("read"), 8);
}

// Row: alias_held, identity_unknown: stop at once.
#[tokio::test]
async fn alias_held_or_identity_unknown_stops_at_once() {
    for code in ["alias_held", "identity_unknown"] {
        let w = World::start(Bus::new(&["a"])).await;
        let mut stream = w.s().deliveries();
        w.until("the first lease listens", |b| ops_count(b, "listen") == 1)
            .await;
        {
            let mut b = w.bus();
            b.on("sub:bind", move |req, _| refusal(req, code));
            b.held.clear();
            b.lease = None;
            b.close_streams();
        }
        match next(&mut stream).await {
            Err(Error::Refusal { code: c, .. }) => assert_eq!(c, code),
            other => panic!("{code}: {other:?}"),
        }
        ended(&mut stream).await;
        assert_eq!(w.count("sub:bind"), 1, "{code}: not retried");
    }
}

// Row: receipt_capacity: delivery_release, then reopen. Release ends the session, so the reopen rebinds with create: false.
#[tokio::test]
async fn receipt_capacity_releases_then_rebinds_and_reopens() {
    let w = World::start(Bus::new(&["a"])).await;
    w.bus().on("read", |req, _| {
        Reply::json(
            json!({"jsonrpc": "2.0", "id": req.id(), "error": {"code": -32602, "message": "capacity", "data": {"code": "receipt_capacity"}}}),
        )
    });
    let _stream = w.s().deliveries();
    w.until("the second lease listens", |b| ops_count(b, "listen") == 2)
        .await;
    let tail = after(&w.ops(), "read", 1);
    assert_eq!(
        &tail[..5],
        [
            "cancel",
            "sub:delivery_release",
            "sub:whoami",
            "sub:bind",
            "sub:delivery_open"
        ]
    );
    let release = &w.calls("sub:delivery_release")[0];
    assert_eq!(
        release.lease.as_deref(),
        Some(format!("c{:042}", 1).as_str())
    );
    assert_eq!(
        w.calls("sub:bind")[0].args,
        json!({"name": addr("a"), "create": false})
    );
}

// Row: admission-throttled reopen: wait, 8 tries (each the transport's 8 attempts), then stop with the transport's RateLimited.
#[tokio::test]
async fn admission_throttling_stops_after_eight_reopens() {
    let w = World::start(Bus::new(&["a"])).await;
    for _ in 0..100 {
        w.bus().on("sub:delivery_open", |req, _| throttled(req));
    }
    let mut stream = w.s().deliveries();
    assert!(matches!(
        next(&mut stream).await,
        Err(Error::RateLimited { .. })
    ));
    ended(&mut stream).await;
    assert_eq!(w.count("sub:delivery_open"), 64);
}

fn throttled(req: &Req) -> Reply {
    Reply::json(
        json!({"jsonrpc": "2.0", "id": req.id(), "error": {"code": -32000, "message": "slow down", "data": {"code": "rate_limited", "retry_after_ms": 1}}}),
    )
    .with_status(429)
}

// Row: close or cancel: delivery_release, then session_end.
#[tokio::test]
async fn end_releases_the_lease_then_ends_the_session() {
    let mut w = World::start(Bus::new(&["a"])).await;
    let mut stream = w.s().deliveries();
    w.until("the first read (the listen acknowledged)", |b| {
        ops_count(b, "read") == 1
    })
    .await;
    w.session.take().unwrap().end().await.unwrap();
    let tail = after(&w.ops(), "listen", 1);
    let release = tail
        .iter()
        .position(|o| o == "sub:delivery_release")
        .expect("released");
    let end = tail
        .iter()
        .position(|o| o == "sub:session_end")
        .expect("ended");
    assert!(release < end, "{tail:?}");
    // The listen stream's cancel went out before the release: nothing follows session_end, which would start a new session under the ID.
    let cancel = tail
        .iter()
        .position(|o| o == "cancel")
        .expect("the listen stream was cancelled");
    assert!(cancel < release, "{tail:?}");
    assert_eq!(
        tail.last().map(String::as_str),
        Some("sub:session_end"),
        "{tail:?}"
    );
    assert_eq!(
        w.calls("sub:delivery_release")[0].lease.as_deref(),
        Some(format!("c{:042}", 1).as_str())
    );
    ended(&mut stream).await;
}

#[tokio::test]
async fn dropping_the_stream_releases_the_lease() {
    let w = World::start(Bus::new(&["a"])).await;
    let stream = w.s().deliveries();
    w.until("the lease listens", |b| ops_count(b, "listen") == 1)
        .await;
    drop(stream);
    w.until("the lease is released", |b| {
        ops_count(b, "sub:delivery_release") == 1
    })
    .await;
    // A second stream on the same session opens again (the release ended the session; the holds come back with create: false).
    let _again = w.s().deliveries();
    w.until("the new stream listens", |b| ops_count(b, "listen") == 2)
        .await;
    assert_eq!(
        w.calls("sub:bind")[0].args,
        json!({"name": addr("a"), "create": false})
    );
}

#[tokio::test]
async fn a_second_stream_while_one_is_open_fails() {
    let w = World::start(Bus::new(&["a"])).await;
    let _first = w.s().deliveries();
    let mut second = w.s().deliveries();
    assert_eq!(stopped(next(&mut second).await).0, "already_open");
    ended(&mut second).await;
}

// Decision: bind or unbind while an item is out: delivery pauses, the handle is lost (a new bind generation), and the item is shown again under the new lease.
#[tokio::test]
async fn bind_while_an_item_is_out_loses_its_handle_and_shows_it_again() {
    let mut bus = Bus::new(&["a"]);
    bus.direct(1);
    let w = World::start(bus).await;
    let mut stream = w.s().deliveries();
    let first = next(&mut stream).await.unwrap();
    let bound = w.s().bind("b", true).await.unwrap();
    assert_eq!(bound.name, "b");
    let again = next(&mut stream).await.unwrap();
    assert_eq!(again.id, "direct:1");
    assert!(matches!(first.receipt().await, Err(Error::DeliveryLost(_))));
    again.receipt().await.unwrap();
    // The stream's remembered holds took b from the subscriber whoami: the next reopen expects both.
    let opens = w.calls("sub:delivery_open");
    assert_eq!(opens.len(), 2);
    assert!(w.ops().contains(&"native:bind".to_string()));
}

// Row: trust marks are typed fields, read from a direct item's message and a board push's post.
#[tokio::test]
async fn trust_marks_come_from_the_message_or_the_post() {
    let mut bus = Bus::new(&["a"]);
    bus.pending.push(json!({"id": "direct:1", "actionable": true, "event": {"kind": "direct", "message": {"id": 1, "other_user": true, "delegated": true}}}));
    bus.pending.push(json!({"id": "push:2", "actionable": false, "event": {"kind": "board", "item": {"kind": "push", "post": {"id": 2, "other_user": true, "ungranted": true}}}}));
    bus.pending.push(json!({"id": "push:3", "actionable": true, "event": {"kind": "board", "item": {"kind": "push", "post": {"id": 3}}}}));
    let w = World::start(bus).await;
    let mut stream = w.s().deliveries();
    let marks = |d: &Delivery| (d.other_user, d.ungranted, d.delegated, d.actionable);
    let d = next(&mut stream).await.unwrap();
    assert_eq!(marks(&d), (true, false, true, true));
    d.receipt().await.unwrap();
    let d = next(&mut stream).await.unwrap();
    assert_eq!(marks(&d), (true, true, false, false));
    d.receipt().await.unwrap();
    let d = next(&mut stream).await.unwrap();
    assert_eq!(marks(&d), (false, false, false, true));
}

fn lost_reason(r: Result<(), Error>) -> String {
    match r {
        Err(Error::DeliveryLost(why)) => why,
        other => panic!("expected DeliveryLost, got {other:?}"),
    }
}

fn unbound_result(req: &Req) -> Reply {
    Reply::result(
        req,
        json!({"content": [{"type": "text", "text": "{\"unbound\":true}"}]}),
    )
}

fn bad_leases(w: &World, n: usize) {
    for _ in 0..n {
        w.bus().on("sub:delivery_open", |req, b| {
            value(
                req,
                json!({"capability": "short", "identity": {"user_email": EMAIL, "identity_full": b.held[0]}, "ownership": 1, "bind_gen": 1, "expiresAt": 1.0e13}),
            )
        });
    }
}

// Audit A: a bind with no stream running (this one stopped, and the server since ended the session) is what the next stream holds.
#[tokio::test]
async fn a_bind_between_streams_is_what_the_next_stream_holds() {
    let w = World::start(Bus::new(&["a"])).await;
    bad_leases(&w, 2);
    let mut stream = w.s().deliveries();
    assert_eq!(stopped(next(&mut stream).await).0, "identity");
    // The task is gone once the stream ends: nothing pauses, so only the bind rule itself can refresh the holds.
    ended(&mut stream).await;
    {
        let mut b = w.bus();
        b.held.clear();
        b.ownership += 1;
    }
    w.s().bind("b", true).await.unwrap();
    let _again = w.s().deliveries();
    w.until("the second stream listens", |b| ops_count(b, "listen") == 1)
        .await;
    // Opened holding b alone, with nothing rebound.
    assert_eq!(w.count("sub:bind"), 0);
    assert_eq!(w.bus().held, vec![addr("b")]);
}

// Audit A: an unbind after a terminal stop isn't undone by the next stream, which idles with nothing held until a bind.
#[tokio::test]
async fn an_unbind_between_streams_is_not_undone_and_the_next_stream_idles_until_a_bind() {
    let w = World::start(Bus::new(&["a"])).await;
    for _ in 0..2 {
        w.bus().on("sub:delivery_open", |req, b| {
            value(
                req,
                json!({"capability": "short", "identity": {"user_email": EMAIL, "identity_full": b.held[0]}, "ownership": 1, "bind_gen": 1, "expiresAt": 1.0e13}),
            )
        });
    }
    let mut stream = w.s().deliveries();
    assert_eq!(stopped(next(&mut stream).await).0, "identity");
    w.s()
        .call_raw("unbind", json!({"name": "a"}))
        .await
        .unwrap();
    let whoamis = w.count("sub:whoami");
    let _idle = w.s().deliveries();
    w.until("the idle stream's whoami", |b| {
        ops_count(b, "sub:whoami") == whoamis + 1
    })
    .await;
    // Room for a wrong rebind of a to show up before the bind of c pauses the stream; nothing observable marks the task idle.
    tokio::time::sleep(Duration::from_millis(100)).await;
    w.s().bind("c", true).await.unwrap();
    w.until("the stream opens after the bind", |b| {
        ops_count(b, "listen") == 1
    })
    .await;
    // Never rebinds the released a; the bind of c came through the session.
    assert_eq!(w.count("sub:bind"), 0);
    assert_eq!(w.bus().held, vec![addr("c")]);
}

// Audit B(1): unbinding the last hold with an item out gives the handle up with that reason; a bind shows the item again.
#[tokio::test]
async fn unbinding_the_last_hold_with_an_item_out_loses_its_handle() {
    let mut bus = Bus::new(&["a"]);
    bus.direct(1);
    let w = World::start(bus).await;
    let mut stream = w.s().deliveries();
    let d = next(&mut stream).await.unwrap();
    w.s()
        .call_raw("unbind", json!({"name": "a"}))
        .await
        .unwrap();
    let why = tokio::time::timeout(Duration::from_secs(5), d.receipt())
        .await
        .expect("receipt() resolves while idle");
    assert!(lost_reason(why).contains("unbound"));
    w.s().bind("a", false).await.unwrap();
    assert_eq!(next(&mut stream).await.unwrap().id, "direct:1");
}

// Audit B(2): a dropped Session ends a stream idling with nothing held.
#[tokio::test]
async fn dropping_the_session_ends_an_idle_stream() {
    let mut w = World::start(Bus::new(&[])).await;
    let mut stream = w.s().deliveries();
    w.until("the idle stream's whoami", |b| {
        ops_count(b, "sub:whoami") == 1
    })
    .await;
    drop(w.session.take());
    ended(&mut stream).await;
}

// Audit C: an unbound result on a concurrent native call during a bind waits for the bind's resume, instead of reopening on holds the session hasn't refreshed yet.
#[tokio::test]
async fn a_restart_during_a_bind_waits_for_the_resume() {
    let w = World::start(Bus::new(&["a"])).await;
    let _stream = w.s().deliveries();
    w.until("the first read", |b| ops_count(b, "read") == 1)
        .await;
    w.bus().on("native:bind", |req, b| {
        let name = req.body["params"]["arguments"]["name"]
            .as_str()
            .unwrap()
            .to_owned();
        b.bind(&name);
        let (tx, rx) = mpsc::unbounded_channel();
        b.parked = Some((req.id(), tx));
        Reply::live(vec![], rx)
    });
    w.bus()
        .on("native:board_read", |req, _| unbound_result(req));
    let poke = async {
        w.until("the bind is held open", |b| b.parked.is_some())
            .await;
        w.s().call_raw("board_read", json!({})).await.unwrap();
        let (id, tx) = w.bus().parked.take().unwrap();
        tx.send(
            event(json!({"jsonrpc": "2.0", "id": id, "result": {"content": [{"type": "text", "text": "bound"}], "structuredContent": {"name": "b", "instructions": [], "ownership": 1}}}))
                .into_bytes(),
        )
        .unwrap();
    };
    let (bound, ()) = tokio::join!(w.s().bind("b", true), poke);
    bound.unwrap();
    w.until("the stream reopens under a and b", |b| {
        ops_count(b, "listen") == 2
    })
    .await;
    assert_eq!(w.bus().held, vec![addr("a"), addr("b")]);
}

// Audit D: lease losses with an item out are bounded too; the stream stops naming the item and the handle is lost.
#[tokio::test]
async fn lease_losses_with_an_item_out_stop_the_stream() {
    let mut bus = Bus::new(&["a"]);
    bus.direct(1);
    let w = World::with(bus, |t| t.renew = Duration::from_millis(10)).await;
    let mut stream = w.s().deliveries();
    let d = next(&mut stream).await.unwrap();
    w.bus().renew_refusals = 1000;
    assert_eq!(
        stopped(next(&mut stream).await),
        ("lease_lost", Some("direct:1".into()))
    );
    assert!(lost_reason(d.receipt().await).contains("stopped"));
}

// Audit E: not_found on delivery_open is a lost lease (recoveries, 3), not a failure (8).
#[tokio::test]
async fn a_lease_refusal_on_delivery_open_spends_recoveries() {
    let w = World::start(Bus::new(&["a"])).await;
    for _ in 0..20 {
        w.bus()
            .on("sub:delivery_open", |req, _| refusal(req, "not_found"));
    }
    let mut stream = w.s().deliveries();
    assert_eq!(stopped(next(&mut stream).await).0, "lease_lost");
    assert_eq!(w.count("sub:delivery_open"), 4);
}

// Audit F: an invalid whoami (a child session) stops at once.
#[tokio::test]
async fn a_child_session_whoami_stops_at_once() {
    let w = World::start(Bus::new(&["a"])).await;
    for _ in 0..20 {
        w.bus().on("sub:whoami", |req, b| {
            let mut v = b.whoami();
            v["child"] = json!(true);
            value(req, v)
        });
    }
    let mut stream = w.s().deliveries();
    assert!(matches!(
        next(&mut stream).await,
        Err(Error::InvalidResponse(_))
    ));
    ended(&mut stream).await;
    assert_eq!(w.count("sub:whoami"), 1);
}

// Audit G: a re-read whose full page doesn't show the accepted item can't conclude its receipt landed: the handle goes, no receipt is claimed, and the page's items are kept.
#[tokio::test]
async fn a_full_page_without_the_item_does_not_claim_its_receipt() {
    let mut bus = Bus::new(&["a"]);
    bus.direct(1);
    bus.on("sub:delivery_receipt", |_, b| {
        b.close_streams();
        Reply::status(503, "gateway")
    });
    let w = World::start(bus).await;
    let mut stream = w.s().deliveries();
    let d = next(&mut stream).await.unwrap();
    w.bus().on("read", |req, b| {
        let items: Vec<Value> = (1000..1100)
            .map(|n| json!({"id": format!("push:{n}"), "actionable": true, "event": {"kind": "board", "item": {"kind": "push", "post": {"id": n}}}, "ownership": b.ownership, "bind_gen": b.bind_gen}))
            .collect();
        let text = json!({"items": items}).to_string();
        Reply::result(req, json!({"contents": [{"uri": INBOX, "text": text}]}))
    });
    let why = tokio::time::timeout(Duration::from_secs(5), d.receipt())
        .await
        .expect("receipt() resolves");
    assert!(lost_reason(why).contains("could not confirm"));
    assert_eq!(w.count("sub:delivery_receipt"), 1);
    assert_eq!(next(&mut stream).await.unwrap().id, "push:1000");
}

// Audit H: the terminal error survives control messages that arrive while the one-slot channel is full.
#[tokio::test]
async fn the_terminal_error_survives_restarts_while_the_channel_is_full() {
    let mut bus = Bus::new(&["a"]);
    bus.direct(1);
    let w = World::start(bus).await;
    let mut stream = w.s().deliveries();
    // Handed over into the slot, not taken.
    w.until("the hand-over renew", |b| {
        ops_count(b, "sub:delivery_renew") == 1
    })
    .await;
    {
        let mut b = w.bus();
        b.held.push(addr("other"));
        b.close_streams();
        for _ in 0..40 {
            b.on("native:board_read", |req, _| unbound_result(req));
        }
    }
    w.until("the reopen's whoami", |b| ops_count(b, "sub:whoami") == 2)
        .await;
    for _ in 0..40 {
        w.s().call_raw("board_read", json!({})).await.unwrap();
    }
    assert_eq!(next(&mut stream).await.unwrap().id, "direct:1");
    assert_eq!(stopped(next(&mut stream).await).0, "holds_changed");
    ended(&mut stream).await;
}

// A healthy renew resets the lease-loss count: two runs of three losses each, a healthy renew between, don't stop.
#[tokio::test]
async fn a_healthy_renew_resets_the_lease_loss_count() {
    let w = World::with(Bus::new(&["a"]), |t| t.renew = Duration::from_millis(10)).await;
    let mut stream = w.s().deliveries();
    for opens in [4, 7] {
        w.bus().renew_refusals = 3;
        w.until("three losses, then a healthy renew", |b| {
            b.renew_refusals == 0
                && b.opens == opens
                && b.log.last().is_some_and(|c| c.op == "sub:delivery_renew")
        })
        .await;
    }
    w.bus().direct(1);
    w.bus().hint();
    assert_eq!(next(&mut stream).await.unwrap().id, "direct:1");
}

// Row: the throttled wait is max(retry_after, min(8 s, unit * 2^n)): a retry_after above the floor holds the reopen back.
#[tokio::test]
async fn a_throttled_reopen_waits_at_least_retry_after() {
    let w = World::start(Bus::new(&["a"])).await;
    for _ in 0..8 {
        w.bus().on("sub:delivery_open", |req, _| {
            Reply::json(
                json!({"jsonrpc": "2.0", "id": req.id(), "error": {"code": -32000, "message": "slow down", "data": {"code": "rate_limited", "retry_after_ms": 60}}}),
            )
            .with_status(429)
        });
    }
    let _stream = w.s().deliveries();
    w.until("the ninth open listens", |b| ops_count(b, "listen") == 1)
        .await;
    let opens = w.calls("sub:delivery_open");
    assert_eq!(opens.len(), 9);
    // The transport's own 8 attempts, then the stream's wait: 60 ms, not the 10 ms floor.
    let gap = opens[8].at - opens[7].at;
    assert!(gap >= Duration::from_millis(60), "{gap:?}");
}

// Row: a lease naming another identity reopens once, and the second lease serves.
#[tokio::test]
async fn a_lease_naming_another_identity_once_reopens_and_serves() {
    let mut bus = Bus::new(&["a"]);
    bus.direct(1);
    bus.on("sub:delivery_open", |req, _| {
        value(
            req,
            json!({"capability": format!("c{:042}", 99), "identity": {"user_email": EMAIL, "identity_full": addr("someone-else")}, "ownership": 1, "bind_gen": 1, "expiresAt": 1.0e13}),
        )
    });
    let w = World::start(bus).await;
    let mut stream = w.s().deliveries();
    assert_eq!(next(&mut stream).await.unwrap().id, "direct:1");
    assert_eq!(w.count("sub:delivery_open"), 2);
    assert_eq!(w.count("sub:whoami"), 2);
}
