// The serialized-origin policy every hosted HTTP surface applies to a browser's Origin header (#387 item 4).
// The MCP SDK has the same policy, but its validator is private to its router.

/** True when `value` is exactly the serialized form of `trusted`'s origin: no path, userinfo, default port or other spelling. */
export function isTrustedOrigin(value: string, trusted: string): boolean {
  if (!/^https?:\/\/[^\s/@?#,\\]+$/.test(value)) return false;
  try {
    const parsed = new URL(value);
    const serialized = value.replace(parsed.protocol === "https:" ? /:443$/ : /:80$/, "");
    return serialized === parsed.origin && parsed.origin === trusted;
  } catch { return false; }
}

/** A request with no Origin header passes (non-browser clients send none); one with a header must match. */
export function permitsOrigin(value: string | null, trusted: string): boolean {
  return value === null || isTrustedOrigin(value, trusted);
}
