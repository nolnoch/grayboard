//! The request envelope the server enforces (#929 D2): body `_meta` and the mirrored headers.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

/// The only protocol this crate speaks. The server serves older versions on its legacy sessionful transport only.
pub const PROTOCOL_VERSION: &str = "2026-07-28";
pub(crate) const SESSION_META: &str = "io.github.nolnoch.grayboard/sessionID";
pub(crate) const DELIVERY_META: &str = "io.github.nolnoch.grayboard/delivery";

/// Who is calling, sent as `clientInfo` on every request.
#[derive(Debug, Clone, Serialize)]
pub struct ClientInfo {
    pub name: String,
    pub version: String,
}

impl ClientInfo {
    pub fn new(name: impl Into<String>, version: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            version: version.into(),
        }
    }
}

/// The delivery declaration native requests carry: push, with `source` naming the session's own subscriber. A push-mode `bind` depends on it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Delivery {
    mode: &'static str,
    source: String,
}

impl Delivery {
    /// `source` must match `^[a-z0-9][a-z0-9:._-]{0,63}$` (the server's rule, `src/server/hosted.ts`).
    pub fn push(source: impl Into<String>) -> Result<Self, crate::Error> {
        let source = source.into();
        let ok = (1..=64).contains(&source.len())
            && source.bytes().enumerate().all(|(i, b)| {
                b.is_ascii_lowercase()
                    || b.is_ascii_digit()
                    || (i > 0 && matches!(b, b':' | b'.' | b'_' | b'-'))
            });
        if !ok {
            return Err(crate::Error::InvalidArgument(format!(
                "invalid delivery source {source:?}"
            )));
        }
        Ok(Self {
            mode: "push",
            source,
        })
    }
}

/// The `_meta` every request carries, merged under any `_meta` the request names itself.
pub(crate) fn request_meta(
    session: &str,
    delivery: Option<&Delivery>,
    info: &ClientInfo,
) -> Map<String, Value> {
    let mut meta = Map::new();
    meta.insert(
        "io.modelcontextprotocol/protocolVersion".into(),
        json!(PROTOCOL_VERSION),
    );
    meta.insert("io.modelcontextprotocol/clientInfo".into(), json!(info));
    meta.insert(
        "io.modelcontextprotocol/clientCapabilities".into(),
        json!({}),
    );
    meta.insert(SESSION_META.into(), json!(session));
    if let Some(d) = delivery {
        meta.insert(DELIVERY_META.into(), json!(d));
    }
    meta
}

/// The `Mcp-Name` header's value for a request: `params.name` on `tools/call`, `params.uri` on `resources/read`, else none.
pub(crate) fn mcp_name<'a>(method: &str, params: &'a Value) -> Option<&'a str> {
    let key = match method {
        "tools/call" => "name",
        "resources/read" => "uri",
        _ => return None,
    };
    params.get(key).and_then(Value::as_str)
}

const SENTINEL_PREFIX: &str = "=?base64?";
const SENTINEL_SUFFIX: &str = "?=";

/// An HTTP field value per the spec's encoding rule: a safe plain-ASCII value passes through; anything else (empty, surrounding whitespace, non-printable or non-ASCII, or already sentinel-shaped) is `=?base64?<base64 of UTF-8>?=`. Matches the TS client's `encodeMcpParamValue`.
pub(crate) fn encode_header_value(value: &str) -> String {
    let needs = value.is_empty()
        || (value.starts_with(SENTINEL_PREFIX) && value.ends_with(SENTINEL_SUFFIX))
        || value != value.trim()
        || value
            .chars()
            .any(|c| !(c == '\t' || (' '..='~').contains(&c)));
    if needs {
        format!(
            "{SENTINEL_PREFIX}{}{SENTINEL_SUFFIX}",
            base64(value.as_bytes())
        )
    } else {
        value.to_owned()
    }
}

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// One content block of a tool result. Text blocks carry `text`; other kinds keep their fields in `rest`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ContentBlock {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

/// A `tools/call` result as the server sent it: refusals included (`is_error`), nothing interpreted.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallToolResult {
    #[serde(default)]
    pub content: Vec<ContentBlock>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub structured_content: Option<Value>,
    #[serde(default)]
    pub is_error: bool,
    #[serde(rename = "_meta", default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
}

impl CallToolResult {
    /// The text blocks, in order.
    pub fn texts(&self) -> impl Iterator<Item = &str> {
        self.content
            .iter()
            .filter(|b| b.kind == "text")
            .filter_map(|b| b.text.as_deref())
    }

    /// The refusal this result carries, when `is_error` is set: the code from `structuredContent.code` (`invalid_response` when absent), compared by callers, never the text.
    pub fn refusal(&self) -> Option<crate::Error> {
        if !self.is_error {
            return None;
        }
        let sc = self.structured_content.as_ref();
        let code = sc
            .and_then(|v| v.get("code"))
            .and_then(Value::as_str)
            .unwrap_or("invalid_response")
            .to_owned();
        let known = sc
            .and_then(|v| v.get("known"))
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .take(256)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        let holder = sc
            .and_then(|v| v.get("holder"))
            .and_then(Value::as_str)
            .map(crate::error::server_text);
        let text = crate::error::server_text(&self.texts().collect::<Vec<_>>().join("\n"));
        Some(crate::Error::Refusal {
            code,
            known,
            holder,
            text,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_values() {
        assert_eq!(encode_header_value("board_post"), "board_post");
        assert_eq!(
            encode_header_value("grayboard://inbox"),
            "grayboard://inbox"
        );
        assert_eq!(encode_header_value("a\tb"), "a\tb");
        assert_eq!(encode_header_value(""), "=?base64??=");
        assert_eq!(encode_header_value(" x"), "=?base64?IHg=?=");
        assert_eq!(encode_header_value("caf\u{e9}"), "=?base64?Y2Fmw6k=?=");
        assert_eq!(
            encode_header_value("=?base64?x?="),
            "=?base64?PT9iYXNlNjQ/eD89?="
        );
    }

    #[test]
    fn base64_padding() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
    }

    #[test]
    fn delivery_source_rule() {
        assert!(Delivery::push("rust-sdk:s1").is_ok());
        assert!(Delivery::push("").is_err());
        assert!(Delivery::push("-x").is_err());
        assert!(Delivery::push("Upper").is_err());
        assert!(Delivery::push("a".repeat(65)).is_err());
    }

    #[test]
    fn refusal_reads_code_never_text() {
        let r: CallToolResult = serde_json::from_value(json!({
            "content": [{"type": "text", "text": "Name held"}],
            "structuredContent": {"code": "alias_held", "holder": "someone"},
            "isError": true
        }))
        .unwrap();
        match r.refusal() {
            Some(crate::Error::Refusal {
                code, holder, text, ..
            }) => {
                assert_eq!(code, "alias_held");
                assert_eq!(holder.as_deref(), Some("someone"));
                assert_eq!(text, "Name held");
            }
            other => panic!("{other:?}"),
        }
        let ok: CallToolResult =
            serde_json::from_value(json!({"content": [{"type": "text", "text": "ok"}]})).unwrap();
        assert!(ok.refusal().is_none());
        assert_eq!(ok.texts().collect::<Vec<_>>(), vec!["ok"]);
    }
}
