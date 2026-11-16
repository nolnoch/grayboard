//! `Client` and `Session` (#929 D4): one session owns a native and a subscriber connection.

use crate::credential::Credential;
use crate::envelope::{CallToolResult, ClientInfo, Delivery};
use crate::error::Error;
use crate::transport::{
    CONNECT_TIMEOUT, Connection, Discovery, Role, Shared, Subscription, Timeouts,
};
use serde_json::{Value, json};
use std::sync::Arc;
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

    /// A session for the raw session ID `id`. Native requests declare push delivery from `source` (`Delivery::push`), so a push-mode `bind` works; nothing is sent until the first call.
    pub fn session(&self, id: impl Into<String>, delivery: Delivery) -> Session {
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
        }
    }
}

/// One bus session: the agent tools on its native connection, and its lease, inbox and subscriber tools on its subscriber connection.
///
/// Call `end` when done. Dropping a session only cancels its in-flight requests: the server keeps the session, and any name it bound, until its idle sweep, so a replacement process that binds the same name meanwhile is refused `alias_held`.
pub struct Session {
    id: String,
    native: Arc<Connection>,
    subscriber: Arc<Connection>,
    cancel: CancellationToken,
}

impl Session {
    pub fn id(&self) -> &str {
        &self.id
    }

    #[cfg(test)]
    pub(crate) fn subscriber_connection(&self) -> &Connection {
        &self.subscriber
    }

    /// Sets or clears the lease capability (`delivery_open`'s `capability`) that the subscriber connection sends as `X-Grayboard-Lease`. `read_resource("grayboard://inbox")`, `listen` and the `delivery_*` lease tools need it.
    pub fn set_lease(&self, capability: Option<String>) {
        self.subscriber.set_lease(capability);
    }

    /// The native connection's `server/discover` result: the server's instructions and capabilities.
    pub async fn discover(&self) -> Result<&Discovery, Error> {
        self.native.discover().await
    }

    /// A native tool call, its result untouched: a refusal comes back as `is_error` (see `CallToolResult::refusal`), never as `Err`. `Err` is the transport's.
    pub async fn call_raw(&self, tool: &str, arguments: Value) -> Result<CallToolResult, Error> {
        let result = self
            .native
            .request("tools/call", json!({"name": tool, "arguments": arguments}))
            .await?;
        serde_json::from_value(result)
            .map_err(|e| Error::InvalidResponse(format!("tools/call result: {e}")))
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
        let result = self
            .subscriber
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

    /// `resources/read` on the subscriber connection; returns the one text content parsed as JSON. A JSON-RPC -32602/-32603 with a domain code is `Error::Refusal`.
    pub async fn read_resource(&self, uri: &str) -> Result<Value, Error> {
        let result = match self
            .subscriber
            .request("resources/read", json!({"uri": uri}))
            .await
        {
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

    /// Opens `subscriptions/listen` on the subscriber connection for `uris`. The low-level hint stream the delivery stream builds on: hints are nonconsuming.
    pub async fn listen(&self, uris: &[&str]) -> Result<Subscription, Error> {
        self.subscriber.listen(uris).await
    }

    /// Ends the session: `session_end`, then cancels anything in flight.
    pub async fn end(self) -> Result<(), Error> {
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
