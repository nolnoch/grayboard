//! The one error type every call returns (#929 D2).

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

/// A credential could not produce a token, or refused to replace a rejected one.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{0}")]
pub struct AuthError(pub String);

/// Everything a request can fail with. Refusals are compared by `code`, never by text.
#[non_exhaustive]
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The server can't be reached right now: a connect error, a timeout before the request was sent, or a gateway status (502, 503, 504) on a request that is safe to repeat.
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
    /// The credential failed before a request was sent.
    #[error("credential error: {0}")]
    Auth(#[from] AuthError),
    /// The session was ended or dropped while the request was in flight.
    #[error("cancelled")]
    Cancelled,
}
