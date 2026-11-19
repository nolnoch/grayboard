//! A client for grayboard's hosted MCP endpoint (#929).
//!
//! It speaks modern MCP (protocol `2026-07-28`) as raw JSON-RPC over HTTP: each request carries its session in `_meta`, and any response may arrive as JSON or as an event stream. This release has the transport, raw calls, the delivery stream (`Session::deliveries`), a typed method for every native tool (`tools`) and two credentials: a fixed token (`StaticBearer`) and a service credential that mints its own (`ClientCredentials`).
//!
//! ```no_run
//! # async fn run() -> Result<(), grayboard::Error> {
//! use futures_util::StreamExt;
//! use grayboard::tools::BindArgs;
//! use grayboard::{Client, ClientInfo, DeliveryMode, StaticBearer};
//! let client = Client::new("https://bus.example.com/mcp", StaticBearer::new("token"), ClientInfo::new("my-service", "1.0.0"))?;
//! let session = client.session("my-session-1", DeliveryMode::push("my-service")?);
//! session.bind(BindArgs { create: Some(true), ..BindArgs::new("w-1") }).await?;
//! let mut deliveries = session.deliveries();
//! while let Some(delivery) = deliveries.next().await {
//!     let delivery = delivery?;
//!     // Store or queue it, deduping on `delivery.stable_id`, then:
//!     delivery.receipt().await?;
//! }
//! session.end().await
//! # }
//! ```

mod credential;
mod delivery;
mod envelope;
mod error;
mod session;
mod sse;
pub mod tools;
mod transport;

pub use credential::{ClientCredentials, Credential, StaticBearer};
pub use delivery::{Delivery, DeliveryStream};
pub use envelope::{CallToolResult, ClientInfo, ContentBlock, DeliveryMode, PROTOCOL_VERSION};
pub use error::{AuthError, Error, SERVER_TEXT_LIMIT, server_text};
pub use session::{Client, Session};
pub use tools::Reply;
pub use transport::{Discovery, Notification, Subscription};

#[cfg(test)]
mod credential_tests;
#[cfg(test)]
mod delivery_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod tools_tests;
