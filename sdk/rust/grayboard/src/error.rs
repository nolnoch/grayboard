//! The one error type every call returns (#929; `docs/sdk-rust.md` §1).

use std::time::Duration;

/// Server-supplied text a caller sees is capped at this many characters (`wire.ts` `SERVER_TEXT_LIMIT`, #276).
pub const SERVER_TEXT_LIMIT: usize = 512;

/// Caps server-supplied text, saying how much was cut, so a misbehaving server or a proxy's HTML page can't flood a log or an agent's context.
pub fn server_text(text: &str) -> String {
    let total = text.chars().count();
    if total <= SERVER_TEXT_LIMIT {
        return text.to_owned();
    }
    let kept: String = text.chars().take(SERVER_TEXT_LIMIT).collect();
    format!(
        "{kept}… ({} more characters cut)",
        total - SERVER_TEXT_LIMIT
    )
}

/// Whether `code` has a domain code's shape (`not_found`, `alias_held`): server text that becomes `Refusal.code` or `Protocol.data_code` and that callers compare. Anything else is replaced, so a broken server or proxy can't put arbitrary text there.
pub(crate) fn domain_code(code: &str) -> bool {
    (1..=64).contains(&code.len())
        && code
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// Server free text shown whole, such as an `alias_held` holder (`wire.ts` `shownText`): non-empty, at most 2048 UTF-16 units, and no control or bidi characters.
pub(crate) fn shown_text(text: &str) -> bool {
    !text.is_empty()
        && text.encode_utf16().count() <= 2048
        && !text.chars().any(|c| {
            c.is_control()
                || ('\u{202a}'..='\u{202e}').contains(&c)
                || ('\u{2066}'..='\u{2069}').contains(&c)
        })
}

/// A credential could not produce a token, or refused to replace a rejected one.
///
/// `retryable` says whether trying again later can help: a transient failure (the authorization server unreachable, a 5xx, a `slow_down`, a backoff in force) surfaces from a request as `Error::Unreachable`, which the delivery stream rides out as it does a server outage; a terminal one (a refused credential, an issuer mismatch) surfaces as `Error::Auth`, which stops it.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct AuthError {
    pub message: String,
    pub retryable: bool,
}

impl AuthError {
    /// Retrying can't help.
    pub fn terminal(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: false,
        }
    }

    /// Worth retrying later.
    pub fn transient(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: true,
        }
    }
}

/// Everything a request can fail with. Refusals are compared by `code`, never by text.
#[non_exhaustive]
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The server can't be reached right now: a connect error, a timeout before the request was sent, a gateway status (502, 503, 504) on a request that is safe to repeat, or a transient credential failure before anything was sent (`AuthError::retryable`, or the credential giving no token within the request timeout).
    #[error("server unreachable: {0}")]
    Unreachable(String),
    /// A `tools/call` timed out or lost its connection after it was sent: the call may or may not have taken effect, and it is never retried (a repeated `board_post` would post twice).
    #[error("outcome unknown: {0}")]
    OutcomeUnknown(String),
    /// The server rejected the credential's token and the credential could not replace it.
    #[error("unauthorized: {0}")]
    Unauthorized(String),
    /// The token lacks a required scope (HTTP 403). Terminal: only a new grant with both scopes restores access.
    #[error("access lacks a required scope")]
    InsufficientScope,
    /// The server refused the connection's first request (`server/discover`); `status` and `body` are its own (`body` capped), so a bad declaration or session key is diagnosable.
    #[error("server refused the connection (HTTP {status}): {body}")]
    ConnectRefused { status: u16, body: String },
    /// The server does not offer this crate's protocol version.
    #[error("server does not speak protocol {expected} (it offers {offered:?})")]
    Incompatible {
        expected: &'static str,
        offered: Vec<String>,
    },
    /// Admission refused the request eight times in a row; `retry_after` is the server's last hint.
    #[error("rate limited; retry after {retry_after:?}")]
    RateLimited { retry_after: Duration },
    /// The server is at request, exchange or listen capacity (a plain-text 429). Not retried.
    #[error("server at capacity: {0}")]
    Capacity(String),
    /// A JSON-RPC error. `data_code` is the server's domain code (`error.data.code`), when it sent one.
    #[error("protocol error {code}: {message}")]
    Protocol {
        code: i64,
        message: String,
        data_code: Option<String>,
    },
    /// The server found a request header that disagrees with the body (JSON-RPC -32020): a bug in this crate.
    #[error("request header mismatch: {0}")]
    HeaderMismatch(String),
    /// A tool refused the call (`isError`). `code` is the server's domain code; `known` lists suggested names for `identity_unknown`; `holder` names who holds an `alias_held` name.
    #[error("refused ({code}): {text}")]
    Refusal {
        code: String,
        known: Vec<String>,
        holder: Option<String>,
        text: String,
    },
    /// The response broke the protocol: unparsable, the wrong shape, or a status the protocol doesn't use.
    #[error("invalid response: {0}")]
    InvalidResponse(String),
    /// A caller-supplied value the crate refuses before sending anything (an endpoint, a delivery source).
    #[error("invalid argument: {0}")]
    InvalidArgument(String),
    /// The credential failed terminally before a request was sent (a transient failure is `Unreachable`).
    #[error("credential error: {0}")]
    Auth(#[from] AuthError),
    /// The session was ended or dropped while the request was in flight.
    #[error("cancelled")]
    Cancelled,
    /// The delivery stream stopped on a rule of its own; it yields this once, then ends. `code` is one of `alias_lost` (the server took every hold), `holds_changed` (the holds changed without a `bind` or `unbind` through this session), `identity` (a lease or an item that doesn't match the holds), `lease_lost` (a fourth lease loss without a healthy renew; `item` names an item out), `retry_exhausted` (an item attempted 8 times, or 8 failures in a row; `item` names the item) and `already_open` (the session already has a stream). A stop the server caused (`alias_held`, `identity_unknown`, a credential or scope refusal, eight admission-throttled reopens, an invalid `whoami` such as a child session's) is yielded as that error instead.
    #[error("delivery stopped ({code}): {message}")]
    DeliveryStopped {
        code: &'static str,
        item: Option<String>,
        message: String,
    },
    /// `Delivery::receipt` can no longer reach the server under this handle; the text says why: the stream stopped or was dropped, a reopen gave a lease under another ownership or bind generation, a `bind` or `unbind` ran, the last hold was unbound, or a re-read couldn't confirm the item. When the stream goes on and the server still has the item issued, it is shown again with the same `stable_id`.
    #[error("delivery lost: {0}")]
    DeliveryLost(String),
}
