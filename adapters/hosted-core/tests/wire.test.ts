import { expect, test } from "bun:test";
import { SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import { AccessExpired, accessExpiry } from "../src/model.js";
import { abortOf, unreachable, Wire } from "../src/wire.js";

// #424 item 5: a host's token() that finds its access token expired (OpenCode's native grant) throws inside the
// MCP SDK's connect. The SDK pinned now rethrows it as is (it wraps fetch failures, not this); the Controller's
// classification walks the cause chain either way: the expiry is found, and nothing reads it as an outage. No
// request leaves: the port is closed, so a fetch would have been refused (an outage) instead.
test("a real connect whose token() throws an access expiry surfaces that expiry through the SDK, before any request (#424)", async () => {
  const expired = new AccessExpired("OpenCode", "sign in again", "expired");
  let tokens = 0;
  const wire = new Wire({ url: "http://127.0.0.1:9/mcp", sessionKey: "ses_test", client: { name: "grayboard-test", version: "1.0.0" } },
    { token: async () => { tokens++; throw expired; } }, new AbortController().signal, "ses_test");
  const caught = await wire.connect().then(() => undefined, (error: unknown) => error);
  try {
    // Fails if an SDK bump starts wrapping: update the comment above, not the code (the cause walk still finds it).
    expect(caught).toBe(expired);
    expect(tokens).toBeGreaterThan(0);
    expect(accessExpiry(caught)).toBe(expired);
    expect(unreachable(caught)).toBe(false);
  } finally { await wire.close().catch(() => {}); }
});

// #1309: a start's stop is its signal's abort by cause: the reason itself, nested as a cause, or the SDK's
// RequestTimeout restating it; an unaborted signal, another error, or another abort's restatement is not.
test("abortOf matches only the signal's own abort", () => {
  const stop = new AbortController(), other = new AbortController();
  const refusal = new AccessExpired("pi", "run /grayboard login", "login_required");
  expect(abortOf(refusal, stop.signal)).toBe(false);
  stop.abort(); other.abort(new Error("elsewhere"));
  const reason = stop.signal.reason;
  expect(abortOf(reason, stop.signal)).toBe(true);
  expect(abortOf(new Error("Version negotiation probe failed", { cause: reason }), stop.signal)).toBe(true);
  expect(abortOf(new SdkError(SdkErrorCode.RequestTimeout, String(reason)), stop.signal)).toBe(true);
  expect(abortOf(refusal, stop.signal)).toBe(false);
  expect(abortOf(new SdkError(SdkErrorCode.RequestTimeout, "Request timed out"), stop.signal)).toBe(false);
  expect(abortOf(other.signal.reason, stop.signal)).toBe(false);
  expect(abortOf(new SdkError(SdkErrorCode.RequestTimeout, String(other.signal.reason)), stop.signal)).toBe(false);
});
