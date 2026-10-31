// hosted-core's wire (#430) against a real in-process server, for the
// built-in pi client: the inbox listen acknowledgment on the 2026-07-28
// revision, the server's own status and body for a refusal at initialize, and
// a scope refusal classified for a new sign-in.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { ConnectRefused, InsufficientScope, NativeWire, Wire, type WireOptions } from "../../adapters/hosted-core/src/wire.ts";
import { GRAYBOARD_SESSION_META } from "../../src/server/oauth-config.ts";
import { issueOAuth } from "../helpers/oauth.ts";
import { TestServer } from "../support/server.ts";

const CLIENT = "grayboard-pi";
let srv: TestServer;
const wires: { close(): Promise<void> }[] = [];
beforeEach(() => { srv = new TestServer({ hostedRequestLimit: { burst: 10_000, perSec: 10_000 } }); });
afterEach(async () => {
  await Promise.all(wires.splice(0).map(w => w.close().catch(() => {})));
  await srv.stop();
});
const options = (delivery: unknown = { mode: "push", source: "grayboard-pi" }): WireOptions =>
  ({ url: `${srv.base}/mcp`, sessionKey: GRAYBOARD_SESSION_META, client: { name: "grayboard-pi", version: "1.0.0" }, delivery: delivery as WireOptions["delivery"] });
const issue = (scopes = ["grayboard:tools", "grayboard:delivery"]) => issueOAuth(srv.app.repo, srv.app.oauth.resource, "alice@example.com", scopes, Date.now(), CLIENT).token;
function subscriber(token: string, wireOptions = options()) {
  const wire = new Wire(wireOptions, { token: async () => token }, new AbortController().signal, "raw-root");
  wires.push(wire);
  return wire;
}

// Pins that the 2026-07-28 stream isn't held back like the legacy GET (#431).
test("subscriptions/listen acknowledges the leased inbox within 1 s", async () => {
  const wire = subscriber(issue());
  await wire.connect();
  await wire.call("bind", { name: "be", create: true });
  wire.capability = (await wire.call("delivery_open") as { capability: string }).capability;
  const started = performance.now();
  const subscription = await wire.listen();
  const elapsed = performance.now() - started;
  await subscription.close();
  expect(elapsed).toBeLessThan(1000);
});

// The SDK reports a 400 at initialize only as "Version negotiation failed".
// The server checks the declaration on the native role only.
test("a refusal at initialize surfaces the server's HTTP status and body", async () => {
  const token = issue();
  const wire = new NativeWire(options({ mode: "shout", source: "grayboard-pi" }), { token: async () => token }, new AbortController().signal, "raw-root");
  wires.push(wire);
  const error = await wire.connect().then(() => undefined, e => e);
  expect(error).toBeInstanceOf(ConnectRefused);
  expect(error.status).toBe(400);
  expect(error.code).toBe("bad_request");
  expect(error.body).toContain("bad_request");
  expect(error.message).toBe(`Server refused the connection (HTTP 400): ${error.body}`);
});

test("a token without the tools scope is a scope refusal, never a refresh", async () => {
  let refreshes = 0;
  const wire = new NativeWire(options(), { token: async () => issue(["grayboard:delivery"]), onUnauthorized: async () => { refreshes++; } }, new AbortController().signal, "raw-root");
  wires.push(wire);
  const error = await wire.connect().then(() => wire.callTool("whoami", {}, "raw-root")).then(() => undefined, e => e);
  expect(error).toBeInstanceOf(InsufficientScope);
  expect(refreshes).toBe(0);
});
