import { expect, test } from "bun:test";
import { SdkError, SdkErrorCode, SdkHttpError } from "@modelcontextprotocol/client";
import { AccessExpired, accessExpiry } from "../src/model.js";
import { abortOf, ConnectRefused, LISTEN_CAPACITY, listenCapacity, subscriberError, unreachable, Wire } from "../src/wire.js";

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

// #1349: session_register's refusals keep their own code, on a tool result and on a refused connect's body;
// a code outside the set (or none) is still invalid_response.
test("subscriberError keeps session_register's refusal codes; an unknown code is invalid_response", () => {
  const codes = ["child_bound", "child_registered_elsewhere", "has_children", "root_is_child", "invalid_registration"];
  expect(codes.map(code => subscriberError({ code }, false).code)).toEqual(codes);
  expect(codes.map(code => new ConnectRefused(400, JSON.stringify({ code, message: "refused" })).code)).toEqual(codes);
  expect([{ code: "child_unknown" }, { code: 7 }, {}, undefined].map(value => subscriberError(value, false).code)).toEqual(Array(4).fill("invalid_response"));
  expect(new ConnectRefused(400, JSON.stringify({ code: "child_unknown" })).code).toBe("invalid_response");
});

// #1394: only the listen cap's own plain 429 is the swap's slot race; another 429, another status with the same body,
// or a body-driven rate_limited 429 is not. A wrapper's cause is followed.
test("listenCapacity matches only the listen cap's plain-text 429", () => {
  const http = (status: number, text: string) => new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, `Error POSTing to endpoint: ${text}`, { status, text });
  expect(listenCapacity(http(429, LISTEN_CAPACITY))).toBe(true);
  expect(listenCapacity(new Error("wrapped", { cause: http(429, LISTEN_CAPACITY) }))).toBe(true);
  expect(listenCapacity(http(429, "MCP request capacity reached"))).toBe(false);
  expect(listenCapacity(http(429, "MCP exchange capacity reached"))).toBe(false);
  expect(listenCapacity(http(429, JSON.stringify({ error: { data: { code: "rate_limited", retry_after_ms: 5 } } })))).toBe(false);
  expect(listenCapacity(http(503, LISTEN_CAPACITY))).toBe(false);
  expect(listenCapacity(new Error(LISTEN_CAPACITY))).toBe(false);
  expect(listenCapacity(undefined)).toBe(false);
});
