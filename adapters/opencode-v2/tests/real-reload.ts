import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { OpenCode } from "@opencode/sdk";
import { Plugin, Provider, Model } from "@opencode/plugin";
import type { Context } from "@opencode/plugin/promise/plugin";
import { assertStable, barrier, bounded, drainSessions } from "./reload-state.ts";

const root = process.env.GRAYBOARD_GIT_TEST_ROOT!, port = process.env.GRAYBOARD_REAL_BACKEND_PORT!;
assert(root && port); assert.equal(Bun.version, "1.4.4");
assert.equal((await Bun.file(join(root, "node_modules/@opencode/sdk/package.json")).json()).version, "2.1.4");
const mode = process.env.GRAYBOARD_REAL_WORKER_MODE ?? "replay";
const suspendedResume = mode === "suspended-resume";
const saved = await Bun.file(join(root, suspendedResume ? "real-suspended.json" : "real-reload.json")).json();
assert.notEqual(process.pid, saved.pid, "Reload must cross an OS-process boundary");
const installed = (await Bun.file(join(root, "installed.txt")).text()).trim();
const { default: plugin } = await import(pathToFileURL(join(installed, "src/index.ts")).href) as typeof import("../src/index.js");
const inputs: Parameters<Context["session"]["synthetic"]>[0][] = [], models: string[] = [];
const replayEntered = barrier(), replayReleased = barrier(), replayReturned = barrier(), modelEntered = barrier(), modelReleased = barrier();
let replayForwarded = false;
let ready = false;
const hold = async () => { ready = true; await Bun.sleep(1_800_000); throw new Error("Crash worker was not killed within its bounded lifetime"); };
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input, init), u = new URL(req.url);
  if (u.origin === "https://grayboard.example.com") {
    assert(!u.pathname.endsWith("/oauth/token"), "Reload must reuse current native access, not exchange or refresh");
    return originalFetch(new Request(`http://127.0.0.1:${port}` + u.pathname + u.search, req));
  }
  assert.equal(u.origin, "https://model.example.com");
  return new Response('data: {"id":"reload","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Reload fixture"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } });
}) as typeof fetch;
const fixture = Plugin.define({ id: "grayboard.real.fixture", async setup(c) {
  await c.mcp.transform(e => e.set("grayboard", { type: "remote", url: "https://grayboard.example.com/hosted/mcp", codemode: false }));
  const p = Provider.ID.make("fixture");
  await c.provider.transform(e => e.add({ info: { ...Provider.Info.empty(p), name: "Fixture", activation: "enabled", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: "https://model.example.com/v1" } }, models: [{ ...Model.Info.default(p, Model.ID.make("fixture")), name: "Fixture" }] }));
  await c.session.hook("title", e => { e.result = "Fixture"; });
  await c.session.hook("http.request", async e => {
    if (e.kind !== "primary") return;
    models.push(e.sessionID);
    if (suspendedResume && e.sessionID === saved.input.sessionID) {
      assert.equal(replayForwarded, false, "Resumed primary must enter before duplicate forwarding");
      modelEntered.release(); await modelReleased.promise;
    }
  });
} });
const instrumented = Plugin.define({ ...plugin, setup(c) { return plugin.setup({ ...c, session: new Proxy(c.session, { get(s, k) {
  if (k === "synthetic") return async (input: Parameters<Context["session"]["synthetic"]>[0]) => {
    inputs.push(structuredClone(input));
    if (mode === "hold-before") await hold();
    if (suspendedResume && input.id === saved.input.id) {
      replayEntered.release(); await replayReleased.promise; replayForwarded = true;
    }
    const value = await s.synthetic(input);
    if (suspendedResume && input.id === saved.input.id) replayReturned.release();
    if (mode === "hold-after") await hold();
    return value;
  };
  return Reflect.get(s, k);
} }) }); } });
const host = await OpenCode.create({ plugins: [fixture, instrumented], database: { path: join(root, "host.sqlite") }, models: { fetch: false }, config: { directory: join(root, "real-home/config"), project: false, claude: false }, fs: { filewatcher: false } });
try {
  await host.agent.list({ location: saved.location });
  if (mode.startsWith("hold-")) {
    await Bun.write(join(root, "real-worker-ready.json"), JSON.stringify({ pid: process.pid }));
    for (let n = 0; n < 300 && !ready; n++) await Bun.sleep(50);
    assert(ready, "Installed plugin reached real admission crash boundary");
    if (mode === "hold-after") await host.session.wait({ sessionID: saved.sessionID });
    await Bun.write(join(root, "real-worker-held.json"), JSON.stringify({ pid: process.pid, input: inputs[0], models }));
    await Bun.sleep(1_800_000); throw new Error("Crash worker was not killed");
  }
  for (let n = 0; n < 300 && !inputs.some(i => i.id === saved.input.id); n++) await Bun.sleep(50);
  assert(inputs.some(i => i.id === saved.input.id), "Installed plugin replayed same real issued item after process reload");
  if (saved.digestInput) {
    for (let n = 0; n < 300 && !inputs.some(i => i.id === saved.digestInput.id); n++) await Bun.sleep(50);
    assert.deepEqual(inputs.find(i => i.id === saved.digestInput.id), saved.digestInput);
    assert.equal((await host.session.inbox.list({ sessionID: saved.digestInput.sessionID })).length, 1, "Digest remains pending after separate-process replay");
  }
  if (suspendedResume) {
    await bounded(Promise.all([replayEntered.promise, modelEntered.promise]), 15_000, "Suspended primary and held duplicate reached their barriers");
    assert.equal(replayForwarded, false);
    assert.deepEqual(models, [saved.input.sessionID], "Exactly the target SDK execution resumed before duplicate forwarding");
    assertStable(join(root, "host.sqlite"), saved.input);
    replayReleased.release();
    await bounded(replayReturned.promise, 15_000, "Duplicate forwarding returned while resumed model was held");
    modelReleased.release();
    await drainSessions(join(root, "host.sqlite"), sessionID => host.session.wait({ sessionID }));
    // Keep the same bounded observation after draining pending wakes, not just synthetic return.
    await Bun.sleep(700);
    await drainSessions(join(root, "host.sqlite"), sessionID => host.session.wait({ sessionID }));
    assert.deepEqual(models, [saved.input.sessionID], "Forwarding adds no primary after resumed execution and pending wakes settle");
    assertStable(join(root, "host.sqlite"), saved.input);
    assert.deepEqual(inputs.find(i => i.id === saved.input.id), saved.input);
    await Bun.write(join(root, "real-suspended-result.json"), JSON.stringify({ pid: process.pid, inputs, models }));
    console.log("REAL_SUSPENDED_RESUME_BEFORE_REPLAY_OK");
  } else {
    await Bun.sleep(700);
    if (saved.uncommitted) assert(models.includes(saved.input.sessionID), "Killed-before-commit delivery may wake on its first durable acceptance");
    else assert.equal(models.length, 0, "Already delivered stable ID replay does not wake again");
    await host.session.wait({ sessionID: saved.input.sessionID });
    if (saved.settled) {
      await drainSessions(join(root, "host.sqlite"), sessionID => host.session.wait({ sessionID }));
      assert.equal(models.length, 0, "Globally settled replay has no queued additional primary");
      assertStable(join(root, "host.sqlite"), saved.input);
    }
    assert.equal((await host.session.context({ sessionID: saved.input.sessionID })).filter(m => m.id === saved.input.id).length, 1);
    assert.deepEqual(inputs.find(i => i.id === saved.input.id), saved.input, "Exact original target, stable ID and payload survive process reload");
    if (saved.digestInput) {
      const before = models.length;
      await host.session.prompt({ sessionID: saved.digestInput.sessionID, text: "Explicit ordinary wake after idle process-replayed digest" });
      await host.session.wait({ sessionID: saved.digestInput.sessionID });
      assert(models.slice(before).includes(saved.digestInput.sessionID));
      assert.equal((await host.session.context({ sessionID: saved.digestInput.sessionID })).filter(m => m.id === saved.digestInput.id).length, 1);
      assert.equal((await host.session.inbox.list({ sessionID: saved.digestInput.sessionID })).length, 0);
    }
    await Bun.write(join(root, "real-reload-result.json"), JSON.stringify({ pid: process.pid, inputs, models }));
    console.log("REAL_PROCESS_RELOAD_STABLE_ID_OK", JSON.stringify({ pid: process.pid, inputs, models }));
  }
} finally { replayReleased.release(); modelReleased.release(); await host.close(); globalThis.fetch = originalFetch; }
