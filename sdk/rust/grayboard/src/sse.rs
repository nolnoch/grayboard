//! An incremental `text/event-stream` parser: data, event and id fields, comments ignored. The server sends nothing else (#929; `docs/sdk-rust.md` §1).

use crate::error::Error;

/// One dispatched event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SseEvent {
    pub event: Option<String>,
    pub data: String,
}

/// A line longer than this is refused rather than buffered without bound.
const MAX_LINE: usize = 4 << 20;
/// An event whose data (its `data:` lines joined) grows past this is refused: the JSON-RPC response limit.
const MAX_DATA: usize = crate::transport::MAX_RESPONSE;

#[derive(Default)]
pub(crate) struct SseParser {
    line: Vec<u8>,
    data: String,
    has_data: bool,
    event: Option<String>,
    skip_lf: bool,
    started: bool,
}

impl SseParser {
    /// Feeds one chunk; returns the events it completed, in order. A line may span chunks, and so may a CRLF pair.
    pub fn feed(&mut self, chunk: &[u8]) -> Result<Vec<SseEvent>, Error> {
        let mut out = Vec::new();
        for &b in chunk {
            if self.skip_lf {
                self.skip_lf = false;
                if b == b'\n' {
                    continue;
                }
            }
            match b {
                b'\r' => {
                    self.skip_lf = true;
                    self.end_line(&mut out)?;
                }
                b'\n' => self.end_line(&mut out)?,
                _ => {
                    if self.line.len() >= MAX_LINE {
                        return Err(Error::InvalidResponse("event-stream line too long".into()));
                    }
                    self.line.push(b);
                }
            }
        }
        Ok(out)
    }

    fn end_line(&mut self, out: &mut Vec<SseEvent>) -> Result<(), Error> {
        let raw = std::mem::take(&mut self.line);
        let mut line = std::str::from_utf8(&raw)
            .map_err(|_| Error::InvalidResponse("event-stream line is not UTF-8".into()))?;
        if !self.started {
            self.started = true;
            line = line.strip_prefix('\u{feff}').unwrap_or(line);
        }
        if line.is_empty() {
            if self.has_data {
                out.push(SseEvent {
                    event: self.event.take(),
                    data: std::mem::take(&mut self.data),
                });
            }
            self.has_data = false;
            self.event = None;
            return Ok(());
        }
        if line.starts_with(':') {
            return Ok(());
        }
        let (field, value) = match line.split_once(':') {
            Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
            None => (line, ""),
        };
        match field {
            "data" => {
                if self.data.len() + value.len() + 1 > MAX_DATA {
                    return Err(Error::InvalidResponse(
                        "event-stream event too large".into(),
                    ));
                }
                if self.has_data {
                    self.data.push('\n');
                }
                self.data.push_str(value);
                self.has_data = true;
            }
            "event" => self.event = Some(value.to_owned()),
            _ => {}
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all(chunks: &[&[u8]]) -> Vec<SseEvent> {
        let mut p = SseParser::default();
        chunks.iter().flat_map(|c| p.feed(c).unwrap()).collect()
    }
    fn ev(event: Option<&str>, data: &str) -> SseEvent {
        SseEvent {
            event: event.map(str::to_owned),
            data: data.to_owned(),
        }
    }

    #[test]
    fn one_event_with_comments_ignored() {
        assert_eq!(
            all(&[b": keepalive\n\nevent: message\ndata: {\"a\":1}\n\n"]),
            vec![ev(Some("message"), "{\"a\":1}")]
        );
    }

    #[test]
    fn lines_and_crlf_split_across_chunks() {
        assert_eq!(
            all(&[b"da", b"ta: x\r", b"\ndata:y\r\n", b"\r\n"]),
            vec![ev(None, "x\ny")]
        );
    }

    #[test]
    fn bare_cr_ends_lines() {
        assert_eq!(
            all(&[b"data: a\r\rdata: b\r\r"]),
            vec![ev(None, "a"), ev(None, "b")]
        );
    }

    #[test]
    fn utf8_split_across_chunks() {
        let s = "data: \u{e9}t\u{e9}\n\n".as_bytes();
        assert_eq!(all(&[&s[..7], &s[7..]]), vec![ev(None, "\u{e9}t\u{e9}")]);
    }

    #[test]
    fn no_data_no_event_and_bom_stripped() {
        assert_eq!(all(&[b"\xef\xbb\xbfevent: x\n\nid: 3\n\n"]), vec![]);
        assert_eq!(all(&[b"\xef\xbb\xbfdata: z\n\n"]), vec![ev(None, "z")]);
    }

    #[test]
    fn an_event_without_end_is_refused_once_past_the_data_limit() {
        let mut p = SseParser::default();
        let line = format!("data: {}\n", "x".repeat(1 << 20));
        let mut result = Ok(vec![]);
        for _ in 0..(MAX_DATA >> 20) + 2 {
            result = p.feed(line.as_bytes());
            if result.is_err() {
                break;
            }
        }
        assert!(matches!(result, Err(Error::InvalidResponse(ref t)) if t.contains("too large")));
    }

    #[test]
    fn invalid_utf8_is_refused() {
        let mut p = SseParser::default();
        assert!(matches!(
            p.feed(b"data: \xff\n"),
            Err(Error::InvalidResponse(_))
        ));
    }
}
