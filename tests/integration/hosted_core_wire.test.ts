// hosted-core's wire (#430) against a real in-process server, for the
// built-in pi client: the inbox listen acknowledgment on the 2026-07-28
// revision, the server's own status and body for a refusal at initialize, and
// a scope refusal classified for a new sign-in.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { ConnectRefused, DELIVERY_META, EFFORT_META, InsufficientScope, LAUNCHER_META, MODEL_META, NativeWire, Wire, type WireOptions } from "../../adapters/hosted-core/src/wire.ts";
import { GRAYBOARD_DELIVERY_META, GRAYBOARD_EFFORT_META, GRAYBOARD_LAUNCHER_META, GRAYBOARD_MODEL_META, GRAYBOARD_SESSION_META } from "../../src/shared/session_meta.ts";
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

// The wire is vendored to OpenCode V2, which can't import the repo's src/, so
// it keeps its own copy of the key the server reads (#444).
test("the wire's delivery key is the one the server reads", () => {
  expect(DELIVERY_META).toBe(GRAYBOARD_DELIVERY_META);
  expect(LAUNCHER_META).toBe(GRAYBOARD_LAUNCHER_META);
  expect(MODEL_META).toBe(GRAYBOARD_MODEL_META);
  expect(EFFORT_META).toBe(GRAYBOARD_EFFORT_META);
});

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

// OpenCode's native client starts a root's ownership with no plugin `_meta`; the plugin's subscriber wire declares
// the launcher on a later request, and that turns the ownership's flag on (#520).
test("a root's later subscriber request declares the launcher its native first request didn't", async () => {
  const token = issue();
  const native = new NativeWire(options(), { token: async () => token }, new AbortController().signal, "raw-root");
  wires.push(native);
  await native.connect();
  await native.callTool("bind", { name: "lead", create: true }, "raw-root");
  const launcher = () => (srv.app.db.query("SELECT launcher FROM ids WHERE principal = ? AND ended_at IS NULL").all("alice@example.com") as { launcher: number }[]).map(r => r.launcher);
  expect(launcher()).toEqual([0]);
  const wire = subscriber(token, { ...options(), launcher: true });
  await wire.connect();
  await wire.call("whoami");
  expect(launcher()).toEqual([1]);
});

// The facts provider is read per request for the session the request names (#364): the native wire, shared across
// sessions, sends each call's own session's facts; a change reaches the server on the next request; a provider that
// throws or answers nothing sends no keys, which never clears what the server holds.
test("each request carries its session's current model and effort, and a provider that fails sends none (#364)", async () => {
  const token = issue();
  const facts = new Map<string, { model?: string | null; effort?: string | null }>([["raw-a", { model: "anthropic/claude-opus-5-5", effort: "high" }], ["raw-b", { model: "openai/gpt-6" }]]);
  let broken = false;
  const native = new NativeWire({ ...options(), facts: id => { if (broken) throw new Error("gone"); return facts.get(id); } }, { token: async () => token }, new AbortController().signal);
  wires.push(native);
  await native.connect();
  await native.callTool("bind", { name: "a", create: true }, "raw-a");
  await native.callTool("bind", { name: "b", create: true }, "raw-b");
  // peer_list's own request carries raw-a's facts too, so the check reads them as the latest request left them.
  const row = async (name: string) => {
    const result = await native.callTool("peer_list", { include_offline: true }, "raw-a");
    const { peers } = JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as { peers: Array<{ handle: string; model?: string | null; effort?: string | null }> };
    const peer = peers.find(p => p.handle === `alice@example.com/${name}`); if (!peer) throw new Error(JSON.stringify(peers));
    return { model: peer.model ?? null, effort: peer.effort ?? null };
  };
  expect(await row("a")).toEqual({ model: "anthropic/claude-opus-5-5", effort: "high" });
  expect(await row("b")).toEqual({ model: "openai/gpt-6", effort: null });
  facts.set("raw-a", { model: "anthropic/claude-sonnet-5-5", effort: "" });
  await native.callTool("whoami", {}, "raw-a");
  expect(await row("a")).toEqual({ model: "anthropic/claude-sonnet-5-5", effort: "high" });
  broken = true;
  await native.callTool("whoami", {}, "raw-a");
  expect(await row("a")).toEqual({ model: "anthropic/claude-sonnet-5-5", effort: "high" });
  // The subscriber wire, bound to one session, sends that session's facts.
  broken = false;
  facts.set("raw-b", { model: "openai/gpt-6", effort: "low" });
  const wire = new Wire({ ...options(), facts: id => facts.get(id) }, { token: async () => token }, new AbortController().signal, "raw-b");
  wires.push(wire);
  await wire.connect();
  await wire.call("whoami");
  expect(await row("b")).toEqual({ model: "openai/gpt-6", effort: "low" });
  // A provider's null is "none": it clears the server's (#558), on either wire; absent keeps it.
  facts.set("raw-b", { model: "openai/gpt-6", effort: null });
  await wire.call("whoami");
  expect(await row("b")).toEqual({ model: "openai/gpt-6", effort: null });
  facts.set("raw-a", { model: null });
  await native.callTool("whoami", {}, "raw-a");
  expect(await row("a")).toEqual({ model: null, effort: "high" });
});
