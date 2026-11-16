//! A client for grayboard's hosted MCP endpoint (#929).
//!
//! It speaks modern MCP (protocol `2026-07-28`) as raw JSON-RPC over HTTP: each request carries its session in `_meta`, and any response may arrive as JSON or as an event stream. This release has the transport and raw calls; the delivery stream and typed tools follow (`docs/future/rust-sdk.md`).
//!
//! ```no_run
//! # async fn run() -> Result<(), grayboard::Error> {
//! use grayboard::{Client, ClientInfo, Delivery, StaticBearer};
//! let client = Client::new("https://bus.example.com/mcp", StaticBearer::new("token"), ClientInfo::new("my-service", "1.0.0"))?;
//! let session = client.session("my-session-1", Delivery::push("my-service")?);
//! let bound = session.call_raw("bind", serde_json::json!({"name": "w-1", "create": true})).await?;
//! if let Some(refusal) = bound.refusal() { return Err(refusal); }
//! session.end().await
//! # }
//! ```

mod credential;
mod envelope;
mod error;
mod session;
mod sse;
mod transport;

pub use credential::{Credential, StaticBearer};
pub use envelope::{CallToolResult, ClientInfo, ContentBlock, Delivery, PROTOCOL_VERSION};
pub use error::{AuthError, Error, SERVER_TEXT_LIMIT, server_text};
pub use session::{Client, Session};
pub use transport::{Discovery, Notification, Subscription};

#[cfg(test)]
mod tests;
