//! `Client` and `Session` (#929): one session owns a native and a subscriber connection.

use crate::credential::Credential;
use crate::delivery::{Control, DeliveryStream, Holds, alias_lost_meta, held_of, unbound_output};
use crate::envelope::{CallToolResult, ClientInfo, DeliveryMode};
use crate::error::Error;
use crate::transport::{
    CONNECT_TIMEOUT, Connection, Discovery, Role, Shared, Subscription, Timeouts,
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

/// A client for one hosted MCP endpoint and one credential. Cheap to clone.
#[derive(Clone)]
pub struct Client {
    shared: Arc<Shared>,
}

impl Client {
    /// `url` is the exact MCP endpoint (for example `https://bus.example.com/mcp`); requests never follow a redirect away from it.
    pub fn new(url: &str, credential: impl Credential, info: ClientInfo) -> Result<Self, Error> {
        let endpoint = reqwest::Url::parse(url)
            .map_err(|e| Error::InvalidArgument(format!("invalid endpoint {url:?}: {e}")))?;
        if !matches!(endpoint.scheme(), "https" | "http") {
            return Err(Error::InvalidArgument(format!(
                "endpoint {url:?} is not http(s)"
            )));
        }
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(CONNECT_TIMEOUT)
            .build()
            .map_err(|e| Error::InvalidResponse(format!("HTTP client: {e}")))?;
        Ok(Self {
            shared: Arc::new(Shared {
                http,
                endpoint,
                credential: Arc::new(credential),
                info,
                timeouts: Timeouts::default(),
            }),
        })
    }

    #[cfg(test)]
    pub(crate) fn with_timeouts(mut self, timeouts: Timeouts) -> Self {
        Arc::get_mut(&mut self.shared)
            .expect("set before any session")
            .timeouts = timeouts;
        self
    }

    /// A session for the raw session ID `id`. Native requests declare push delivery from `source` (`DeliveryMode::push`), so a push-mode `bind` works; nothing is sent until the first call.
    pub fn session(&self, id: impl Into<String>, delivery: DeliveryMode) -> Session {
        let id = id.into();
        let cancel = CancellationToken::new();
        let native = Arc::new(Connection::new(
            Arc::clone(&self.shared),
            Role::Native,
            id.clone(),
            Some(delivery.clone()),
            cancel.child_token(),
        ));
        let subscriber = Arc::new(Connection::new(
            Arc::clone(&self.shared),
            Role::Subscriber,
            id.clone(),
            Some(delivery),
            cancel.child_token(),
        ));
        Session {
            id,
            native,
            subscriber,
            cancel,
            stream: Mutex::new(None),
            holds: Arc::default(),
            binding: tokio::sync::Mutex::new(()),
        }
    }
}

/// One bus session: the agent tools on its native connection, and its lease, inbox and subscriber tools on its subscriber connection.
///
/// Call `end` when done. Dropping a session only cancels its in-flight requests: the server keeps the session, and any name it bound, until its idle sweep (or, with a delivery lease open, until the lease lapses 30 s later), so a replacement process that binds the same name meanwhile is refused `alias_held`.
pub struct Session {
    id: String,
    native: Arc<Connection>,
    subscriber: Arc<Connection>,
    cancel: CancellationToken,
    /// The delivery stream's task, while one runs.
    stream: Mutex<Option<StreamSlot>>,
    /// The holds the delivery stream rebinds with `create: false`, refreshed from the subscriber `whoami` after every `bind` and `unbind`.
    holds: Holds,
    /// One `bind` or `unbind` at a time, so each pauses and resumes the stream around itself only.
    binding: tokio::sync::Mutex<()>,
}

/// A delivery stream's task as its session sees it.
struct StreamSlot {
    ctl: mpsc::UnboundedSender<Control>,
    /// Gone once the caller dropped the `DeliveryStream`; its task may still be releasing the lease.
    alive: std::sync::Weak<()>,
    task: tokio::task::JoinHandle<()>,
}

/// Resumes the delivery stream when dropped: after a `bind` or `unbind` completes, is refused, fails or is cancelled.
struct Paused(Option<mpsc::UnboundedSender<Control>>);

impl Drop for Paused {
    fn drop(&mut self) {
        if let Some(tx) = self.0.take() {
            let _ = tx.send(Control::Resume);
        }
    }
}

/// `bind`'s result.
#[derive(Debug, Clone)]
pub struct Bound {
    /// The name as the session's user writes it (their own names unscoped).
    pub name: String,
    pub ownership: u64,
    /// The instruction lines the bind returned.
    pub instructions: Vec<String>,
}

/// `board_post`'s result.
#[derive(Debug, Clone)]
pub struct Posted {
    pub post_id: u64,
    /// The whole result value, for fields this crate doesn't type yet.
    pub value: Value,
    /// Text blocks after the result: server notices.
    pub notices: Vec<String>,
}

/// A `board_subscribe` mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubscribeMode {
    Push,
    Digest,
    Quiet,
    Off,
}

impl SubscribeMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Push => "push",
            Self::Digest => "digest",
            Self::Quiet => "quiet",
            Self::Off => "off",
        }
    }
}

impl Session {
    pub fn id(&self) -> &str {
        &self.id
    }

    #[cfg(test)]
    pub(crate) fn subscriber_connection(&self) -> &Connection {
        &self.subscriber
    }

    /// Sets or clears the lease capability (`delivery_open`'s `capability`) that the subscriber connection sends as `X-Grayboard-Lease`. `read_resource("grayboard://inbox")`, `listen` and the `delivery_*` lease tools need it. Not for use while a delivery stream is open: the stream owns the header.
    pub fn set_lease(&self, capability: Option<String>) {
        self.subscriber.set_lease(capability);
    }

    /// The native connection's `server/discover` result: the server's instructions and capabilities.
    pub async fn discover(&self) -> Result<&Discovery, Error> {
        self.native.discover().await
    }

    /// A native tool call, its result untouched: a refusal comes back as `is_error` (see `CallToolResult::refusal`), never as `Err`. `Err` is the transport's.
    ///
    /// The bind rule lives here (`docs/sdk-rust.md` §2): `bind` and `unbind` pause the delivery stream, run, refresh the holds it rebinds from the subscriber `whoami`, then resume it under them; any other result that reports the session `unbound: true` or carries the alias-lost marker restarts it, so it rebinds the remembered holds or drops the lost ones.
    pub async fn call_raw(&self, tool: &str, arguments: Value) -> Result<CallToolResult, Error> {
        if tool == "bind" || tool == "unbind" {
            let _one = self.binding.lock().await;
            let paused = self.pause().await;
            let result = self.native_call(tool, arguments).await;
            // After every bind and unbind, stream or not: a later `deliveries()` rebinds these, so they must be what the session holds now, not what a stopped or dropped stream last saw. A failed read keeps them as they were: the next open's whoami then stops on a change it can't explain.
            if let Ok(value) = call_subscriber(&self.subscriber, "whoami", json!({})).await
                && let Ok(held) = held_of(&value)
            {
                *self.holds.lock().unwrap_or_else(|e| e.into_inner()) = held;
            }
            drop(paused);
            return result;
        }
        let result = self.native_call(tool, arguments).await?;
        if (unbound_output(&result) || alias_lost_meta(&result))
            && let Some(tx) = self.live_stream()
        {
            let _ = tx.send(Control::Restart);
        }
        Ok(result)
    }

    pub(crate) async fn native_call(
        &self,
        tool: &str,
        arguments: Value,
    ) -> Result<CallToolResult, Error> {
        let result = self
            .native
            .request("tools/call", json!({"name": tool, "arguments": arguments}))
            .await?;
        serde_json::from_value(result)
            .map_err(|e| Error::InvalidResponse(format!("tools/call result: {e}")))
    }

    fn live_stream(&self) -> Option<mpsc::UnboundedSender<Control>> {
        self.stream
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|slot| slot.ctl.clone())
            .filter(|tx| !tx.is_closed())
    }

    /// Stops the delivery stream, if one runs, until the returned guard drops. The guard exists before the wait, so a cancelled caller still resumes it.
    async fn pause(&self) -> Paused {
        let tx = self.live_stream();
        let paused = Paused(tx.clone());
        if let Some(tx) = tx {
            let (ack, done) = oneshot::channel();
            if tx.send(Control::Pause(ack)).is_ok() {
                let _ = done.await;
            }
        }
        paused
    }

    /// `bind` a name (`create: true` creates it when nobody has it yet). A refusal is `Error::Refusal` with the server's code (`alias_held`, `identity_unknown`, `forbidden`, `bad_request`).
    pub async fn bind(&self, name: &str, create: bool) -> Result<Bound, Error> {
        let result = self
            .call_raw("bind", json!({"name": name, "create": create}))
            .await?;
        let (value, _) = read_result(&result)?;
        let value =
            value.ok_or_else(|| Error::InvalidResponse("bind result has no value".into()))?;
        let name = value
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| Error::InvalidResponse("bind result has no name".into()))?
            .to_owned();
        let ownership = value
            .get("ownership")
            .and_then(Value::as_u64)
            .ok_or_else(|| Error::InvalidResponse("bind result has no ownership".into()))?;
        let instructions = value
            .get("instructions")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        Ok(Bound {
            name,
            ownership,
            instructions,
        })
    }

    /// `board_subscribe` the session's primary to `board`. A queue board routes work only to `Push` subscribers. Returns the server's notices.
    pub async fn board_subscribe(
        &self,
        board: &str,
        mode: SubscribeMode,
    ) -> Result<Vec<String>, Error> {
        let result = self
            .call_raw(
                "board_subscribe",
                json!({"board": board, "mode": mode.as_str()}),
            )
            .await?;
        read_result(&result).map(|(_, notices)| notices)
    }

    /// `board_post` to `board`, as a reply in `parent`'s thread when given (a reply to a queue board's work item completes it).
    pub async fn board_post(
        &self,
        board: &str,
        body: &str,
        parent: Option<u64>,
    ) -> Result<Posted, Error> {
        let mut arguments = json!({"board": board, "body": body});
        if let Some(parent) = parent {
            arguments["parent_id"] = json!(parent);
        }
        let result = self.call_raw("board_post", arguments).await?;
        let (value, notices) = read_result(&result)?;
        let value =
            value.ok_or_else(|| Error::InvalidResponse("board_post result has no value".into()))?;
        let post_id = value
            .get("post_id")
            .and_then(Value::as_u64)
            .ok_or_else(|| Error::InvalidResponse("board_post result has no post_id".into()))?;
        Ok(Posted {
            post_id,
            value,
            notices,
        })
    }

    /// The session's deliveries, one at a time (`docs/sdk-rust.md` §2): a background task opens and renews the lease, listens for inbox hints and hands over each item; the next comes only after this one's `receipt()`. Delivery is at-least-once: dedupe on `Delivery::stable_id`. A terminal stop is one `Err`, then the stream ends. A session has one stream at a time; dropping it releases the lease, which ends the session on the server.
    pub fn deliveries(&self) -> DeliveryStream {
        let mut slot = self.stream.lock().unwrap_or_else(|e| e.into_inner());
        if slot
            .as_ref()
            .is_some_and(|s| !s.ctl.is_closed() && s.alive.strong_count() > 0)
        {
            return DeliveryStream::failed(Error::DeliveryStopped {
                code: "already_open",
                item: None,
                message: "this session already has a delivery stream".into(),
            });
        }
        // A dropped stream's task may still be releasing its lease: the new one starts after it.
        let after = slot.take().map(|s| s.task);
        let (stream, ctl, alive, task) = DeliveryStream::spawn(
            Arc::clone(&self.subscriber),
            self.id.clone(),
            Arc::clone(&self.holds),
            after,
        );
        *slot = Some(StreamSlot { ctl, alive, task });
        stream
    }

    /// Every native tool the server lists for this session, following pagination.
    pub async fn list_tools(&self) -> Result<Vec<Value>, Error> {
        list_tools(&self.native).await
    }

    /// Every subscriber tool, following pagination.
    pub async fn list_subscriber_tools(&self) -> Result<Vec<Value>, Error> {
        list_tools(&self.subscriber).await
    }

    /// A subscriber tool call (`whoami`, `delivery_open`, …), read as `wire.ts` `Wire.call` does: a refusal is `Error::Refusal`, the value is `structuredContent` or the single text block parsed as JSON.
    pub async fn call_subscriber(&self, tool: &str, arguments: Value) -> Result<Value, Error> {
        call_subscriber(&self.subscriber, tool, arguments).await
    }

    /// `resources/read` on the subscriber connection; returns the one text content parsed as JSON. A JSON-RPC -32602/-32603 with a domain code is `Error::Refusal`.
    pub async fn read_resource(&self, uri: &str) -> Result<Value, Error> {
        read_resource(&self.subscriber, uri).await
    }

    /// Opens `subscriptions/listen` on the subscriber connection for `uris`. The low-level hint stream the delivery stream builds on: hints are nonconsuming.
    pub async fn listen(&self, uris: &[&str]) -> Result<Subscription, Error> {
        self.subscriber.listen(uris).await
    }

    /// Ends the session: stops the delivery stream, releasing its lease, then `session_end`, then cancels anything in flight. A release that fails is not an error here (the lease then lapses within its 30 s TTL), as `controller.ts` `release` treats it.
    pub async fn end(self) -> Result<(), Error> {
        if let Some(tx) = self.live_stream() {
            let (ack, done) = oneshot::channel();
            if tx.send(Control::Stop(Some(ack))).is_ok() {
                let _ = done.await;
            }
        }
        let result = self
            .call_subscriber("session_end", json!({}))
            .await
            .map(|_| ());
        self.cancel.cancel();
        result
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

async fn list_tools(conn: &Connection) -> Result<Vec<Value>, Error> {
    let mut tools = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let params = match &cursor {
            Some(c) => json!({"cursor": c}),
            None => json!({}),
        };
        let mut page = conn.request("tools/list", params).await?;
        match page.get_mut("tools").map(Value::take) {
            Some(Value::Array(list)) => tools.extend(list),
            _ => {
                return Err(Error::InvalidResponse(
                    "tools/list result has no tools".into(),
                ));
            }
        }
        cursor = page
            .get("nextCursor")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if cursor.is_none() {
            return Ok(tools);
        }
    }
}

/// A subscriber tool call: a refusal is `Error::Refusal`; the value is `structuredContent` or the one text block parsed as JSON.
pub(crate) async fn call_subscriber(
    conn: &Connection,
    tool: &str,
    arguments: Value,
) -> Result<Value, Error> {
    let result = conn
        .request("tools/call", json!({"name": tool, "arguments": arguments}))
        .await?;
    let result: CallToolResult = serde_json::from_value(result)
        .map_err(|e| Error::InvalidResponse(format!("tools/call result: {e}")))?;
    if let Some(refusal) = result.refusal() {
        return Err(refusal);
    }
    if let Some(value) = result.structured_content {
        return Ok(value);
    }
    match result.content.as_slice() {
        [block] if block.kind == "text" => {
            serde_json::from_str(block.text.as_deref().unwrap_or(""))
                .map_err(|e| Error::InvalidResponse(format!("subscriber result: {e}")))
        }
        _ => Err(Error::InvalidResponse(
            "subscriber result is not one text block".into(),
        )),
    }
}

/// `resources/read`: the one text content parsed as JSON; a JSON-RPC -32602/-32603 with a domain code is `Error::Refusal`.
pub(crate) async fn read_resource(conn: &Connection, uri: &str) -> Result<Value, Error> {
    let result = match conn.request("resources/read", json!({"uri": uri})).await {
        Err(Error::Protocol {
            code: -32602 | -32603,
            message,
            data_code,
        }) => {
            return Err(Error::Refusal {
                code: data_code.unwrap_or_else(|| "invalid_response".into()),
                known: Vec::new(),
                holder: None,
                text: message,
            });
        }
        r => r?,
    };
    match result
        .get("contents")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
    {
        Some([content]) => match content.get("text").and_then(Value::as_str) {
            Some(text) => serde_json::from_str(text)
                .map_err(|e| Error::InvalidResponse(format!("resource text: {e}"))),
            None => Err(Error::InvalidResponse(
                "resource content has no text".into(),
            )),
        },
        _ => Err(Error::InvalidResponse(
            "resource read is not one content".into(),
        )),
    }
}

/// A native result read as typed methods read it: a refusal is `Err`; the value is `structuredContent`, else the first text block parsed as JSON (`"ok"` or `"ok: …"` is unit success, `None`); the text blocks after it are notices.
pub(crate) fn read_result(result: &CallToolResult) -> Result<(Option<Value>, Vec<String>), Error> {
    if let Some(refusal) = result.refusal() {
        return Err(refusal);
    }
    let texts: Vec<&str> = result.texts().collect();
    let notices = texts.iter().skip(1).map(|t| (*t).to_owned()).collect();
    if let Some(value) = &result.structured_content {
        return Ok((Some(value.clone()), notices));
    }
    match texts.first() {
        None => Ok((None, notices)),
        Some(t) if *t == "ok" || t.starts_with("ok:") => Ok((None, notices)),
        Some(t) => serde_json::from_str(t)
            .map(|v| (Some(v), notices))
            .map_err(|e| Error::InvalidResponse(format!("tool result: {e}"))),
    }
}
