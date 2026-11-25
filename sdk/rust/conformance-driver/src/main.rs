//! The conformance suite's Rust driver (#929; `docs/sdk-rust.md` §4): `tests/conformance/driver.ts` `rustDriver()` runs one of these per bus and speaks JSON lines with it on stdio.
//!
//! - `{"id","op":"peer","peer","url","issuer","client_id","secret","session"}` opens a session in push mode as the service whose credential that is, binds `peer` with `create: true` and opens its delivery lease; it answers `{"id","result":<the bind's CallToolResult>}`. Every peer shares one `ClientCredentials`, made from the first peer's fields, so the driver mints one run token per bus.
//! - `{"id","op":"call","peer","tool","args"}` makes a native tool call through `Session::call_raw` and answers `{"id","result":<raw CallToolResult>}`, refusals included.
//! - `{"op":"close"}` (or end of input) waits for calls in flight, ends every session and exits 0; 1 if an end failed.
//!
//! A request that fails outside the tool (transport, a refused peer bind, a malformed line) answers `{"id","error":"..."}`. Requests may be pipelined: answers come by id, in completion order; one peer's calls run one at a time.
//!
//! The lease follows the TS hosted driver (`hostedDriver()`): a successful `bind` or `unbind` whose answer's `name` isn't null reopens it with `delivery_open`. The SDK reopens a lease itself only under a delivery stream (`Session::deliveries`), which this driver doesn't open: a stream renews and reads the inbox, and its release ends the session, none of which the TS driver does.

use grayboard::{Client, ClientCredentials, ClientInfo, DeliveryMode, Error, Session};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;
use tokio::task::JoinSet;

const SOURCE: &str = "grayboard-conformance";

struct Peer {
    session: Session,
    /// One call at a time per peer, so a bind and its lease reopen are never split by another call.
    turn: tokio::sync::Mutex<()>,
}

type Peers = Arc<Mutex<HashMap<String, Arc<Peer>>>>;

/// The bus's one credential, made by the first peer: its clones share one cached token.
static CREDENTIAL: Mutex<Option<ClientCredentials>> = Mutex::new(None);

fn credential(req: &Value) -> Result<ClientCredentials, String> {
    let mut slot = CREDENTIAL.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(c) = &*slot {
        return Ok(c.clone());
    }
    let c = ClientCredentials::new(
        field(req, "url")?,
        field(req, "issuer")?,
        field(req, "client_id")?,
        field(req, "secret")?,
    )
    .map_err(|e| e.to_string())?;
    *slot = Some(c.clone());
    Ok(c)
}

fn field<'a>(req: &'a Value, name: &str) -> Result<&'a str, String> {
    req.get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing string field {name:?}"))
}

/// `delivery_open` with no lease header, then that lease's capability as the header, as `HostedSession.reopen` does.
async fn reopen(session: &Session) -> Result<(), String> {
    session.set_lease(None);
    let lease = session
        .call_subscriber("delivery_open", json!({}))
        .await
        .map_err(|e| format!("delivery_open: {e}"))?;
    let capability = lease
        .get("capability")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("delivery_open answered no capability: {lease}"))?;
    session.set_lease(Some(capability.to_owned()));
    Ok(())
}

/// A native call; after a successful `bind` or `unbind` that leaves a name, the lease reopens (the server closed it).
async fn call(peer: &Peer, tool: &str, args: Value) -> Result<Value, String> {
    let _turn = peer.turn.lock().await;
    let result = peer
        .session
        .call_raw(tool, args)
        .await
        .map_err(|e| format!("{tool}: {e}"))?;
    if (tool == "bind" || tool == "unbind") && !result.is_error {
        // As the TS driver reads it: only an explicit null (the last hold unbound) leaves no lease to reopen.
        let name = result
            .structured_content
            .as_ref()
            .and_then(|sc| sc.get("name"));
        if !matches!(name, Some(Value::Null)) {
            reopen(&peer.session).await?;
        }
    }
    serde_json::to_value(&result).map_err(|e| format!("{tool} result: {e}"))
}

async fn open_peer(peers: &Peers, req: &Value) -> Result<Value, String> {
    let name = field(req, "peer")?;
    if peers
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains_key(name)
    {
        return Err(format!("peer {name:?} is already open"));
    }
    let client = Client::new(
        field(req, "url")?,
        credential(req)?,
        ClientInfo::new(SOURCE, env!("CARGO_PKG_VERSION")),
    )
    .map_err(|e| e.to_string())?;
    let mode = DeliveryMode::push(SOURCE).map_err(|e| e.to_string())?;
    let peer = Arc::new(Peer {
        session: client.session(field(req, "session")?, mode),
        turn: tokio::sync::Mutex::new(()),
    });
    let bound = call(&peer, "bind", json!({"name": name, "create": true})).await?;
    if bound.get("isError") == Some(&Value::Bool(true)) {
        return Err(format!("bind {name}: refused: {bound}"));
    }
    peers
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(name.to_owned(), peer);
    Ok(bound)
}

async fn handle(peers: Peers, req: Value) -> Result<Value, String> {
    match field(&req, "op")? {
        "peer" => open_peer(&peers, &req).await,
        "call" => {
            let name = field(&req, "peer")?;
            let peer = peers
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(name)
                .cloned()
                .ok_or_else(|| format!("no peer {name:?}"))?;
            let args = req.get("args").cloned().unwrap_or_else(|| json!({}));
            call(&peer, field(&req, "tool")?, args).await
        }
        op => Err(format!("unknown op {op:?}")),
    }
}

/// Ends every session; the first failure, if any.
async fn end_all(peers: &Peers) -> Result<(), Error> {
    let all: Vec<(String, Arc<Peer>)> = peers
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .drain()
        .collect();
    let mut first = Ok(());
    for (name, peer) in all {
        // Every call has finished, so this is the last reference.
        let Ok(peer) = Arc::try_unwrap(peer) else {
            eprintln!("conformance-driver: peer {name} still in use at close");
            continue;
        };
        if let Err(e) = peer.session.end().await {
            eprintln!("conformance-driver: ending {name}: {e}");
            if first.is_ok() {
                first = Err(e);
            }
        }
    }
    first
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let (out, mut lines) = mpsc::unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(line) = lines.recv().await {
            if stdout.write_all(line.as_bytes()).await.is_err()
                || stdout.write_all(b"\n").await.is_err()
                || stdout.flush().await.is_err()
            {
                break;
            }
        }
    });

    let peers: Peers = Arc::default();
    let mut calls = JoinSet::new();
    let mut input = BufReader::new(tokio::io::stdin()).lines();
    loop {
        let line = match input.next_line().await {
            Ok(Some(line)) => line,
            Ok(None) => break,
            Err(e) => {
                eprintln!("conformance-driver: reading stdin: {e}");
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let req: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                let _ =
                    out.send(json!({"id": null, "error": format!("not JSON: {e}")}).to_string());
                continue;
            }
        };
        if req.get("op").and_then(Value::as_str) == Some("close") {
            break;
        }
        let (peers, out) = (Arc::clone(&peers), out.clone());
        calls.spawn(async move {
            let id = req.get("id").cloned().unwrap_or(Value::Null);
            // An inner task, so a panic still answers its id instead of leaving the TS side waiting.
            let answer = match tokio::spawn(handle(peers, req)).await {
                Ok(Ok(result)) => json!({"id": id, "result": result}),
                Ok(Err(error)) => json!({"id": id, "error": error}),
                Err(e) => json!({"id": id, "error": format!("driver task panicked: {e}")}),
            };
            let _ = out.send(answer.to_string());
        });
    }
    while let Some(joined) = calls.join_next().await {
        if let Err(e) = joined {
            eprintln!("conformance-driver: a call task failed: {e}");
        }
    }
    let ended = end_all(&peers).await;
    drop(out);
    let _ = writer.await;
    std::process::exit(if ended.is_ok() { 0 } else { 1 });
}
