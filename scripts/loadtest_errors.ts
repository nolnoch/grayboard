// A load-test client error's class, for the driver's error counts (#1532). The MCP SDK wraps a failed connect
// (SdkError {cause}) and hosted-core's wire wraps an outage (ServerUnreachable {cause}), so the outer class alone
// ("connect/SdkError") hides what failed: a request timeout, a capacity 429, a reset. This walks the cause chain and
// names each link: its class, an SdkError's code, an HTTP status and, for a plain-text 429 or 503, the server's body
// ("MCP listen capacity reached"). The request and exchange caps answer `rate_limited` JSON (#1536): a connect that
// exhausts the wire's retries on one is a ServerBusy, and any other request's shows as a bare http_429.
import { SdkError, SdkHttpError } from "@modelcontextprotocol/client";
import { HostedToolError } from "../tests/support/hosted_session.ts";

const CAUSE_DEPTH = 6;

function link(e: unknown): string {
  if (!(e instanceof Error)) return typeof e;
  if (e instanceof SdkHttpError) {
    const text = typeof e.data?.text === "string" ? e.data.text.trim() : "";
    return `http_${e.status}${(e.status === 429 || e.status === 503) && text && text.length <= 60 && !text.startsWith("{") ? `(${text})` : ""}`;
  }
  // A subclass that keeps Error's name (hosted-core's ServerUnreachable) by its constructor's.
  const name = e.name !== "Error" ? e.name : e.constructor?.name || "Error";
  if (e instanceof SdkError) return `${name}(${e.code})`;
  const code = (e as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Za-z_]{2,40}$/.test(code) ? `${name}(${code})` : name;
}

// "<op>/<class>[<cause>…]": a tool refusal by its tool and code; anything else by its cause chain, outermost first.
export function errorClass(e: unknown): string {
  if (e instanceof HostedToolError) return `${e.tool}:${e.code ?? "refused"}`;
  const chain: string[] = [];
  for (let c: unknown = e, depth = 0; c !== undefined && c !== null && depth < CAUSE_DEPTH; c = (c as { cause?: unknown }).cause, depth++) {
    chain.push(link(c));
    if (!(c instanceof Error)) break;
  }
  return chain.join("<");
}
