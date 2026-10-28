import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Plugin } from "@opencode/plugin/effect";
import type { Context } from "@opencode/plugin/promise/plugin";
import { fromPromise } from "@opencode/plugin/promise/adapter";
import { DateTime, Effect } from "effect";
import { createFixtureHost } from "./effect-host.js";
import { instrument, type NativeAdmission } from "./effect-instrument.js";
import { barrier, bounded } from "./reload-state.js";

const root = process.env.GRAYBOARD_EFFECT_PORT_PROBE_DIR;
assert(root); assert.equal(Bun.version, "1.4.4");
mkdirSync(join(root, "project"), { recursive: true });
const installed = resolve(import.meta.dir, "..");
const { default: actual, Grayboard } = await import(pathToFileURL(join(installed, "src/index.ts")).href) as typeof import("../src/index.js");
let context: Context | undefined, native: NativeAdmission | undefined;
const ready = barrier(), before = barrier(), releaseBefore = barrier(), after = barrier(), releaseAfter = barrier();
const captured = Plugin.define({ id: actual.id, effect: host => Effect.gen(function* () {
  yield* actual.effect(host);
  yield* fromPromise({ id: "fixture.encoding", setup: c => { context = c; ready.release(); } }).effect(host);
}) });
const wrapped = instrument(captured, async (input, forward) => {
  before.release(); await releaseBefore.promise;
  native = await forward(input);
  after.release(); await releaseAfter.promise;
  return native;
});
let host: Awaited<ReturnType<typeof createFixtureHost>> | undefined;
let admission: Promise<unknown> | undefined;
try {
  host = await createFixtureHost({ plugins: [wrapped], database: { path: join(root, "host.sqlite") }, models: { fetch: false }, config: { directory: join(root, "config"), project: false, claude: false }, fs: { filewatcher: false } });
  const location = { directory: join(root, "project") };
  await host.agent.list({ location });
  await bounded(ready.promise, 8000, "Actual default composition and scoped Promise adapter activated"); assert(context);
  const session = await host.session.create({ location, title: "Effect fixture port" });
  let returned = false;
  const input = { sessionID: session.id, id: "msg_fixture_port_probe", text: "Owned nonactionable port probe", delivery: "queue" as const, resume: false, metadata: { source: "grayboard" } };
  const admitted = context.session.synthetic(input).then(value => { returned = true; return value; });
  admission = admitted;
  void admitted.catch(() => {});
  await bounded(before.promise, 1000, "Native interception entered before real forward");
  assert.equal(returned, false); assert.deepEqual(await host.session.inbox.list({ sessionID: session.id }), []);
  releaseBefore.release(); await bounded(after.promise, 1000, "Real native forward returned before after-hold");
  assert.equal(returned, false); assert.equal((await host.session.inbox.list({ sessionID: session.id })).length, 1);
  assert(native); assert(DateTime.isDateTime(native.time.created));
  releaseAfter.release(); const encoded = await admitted;
  assert.equal(typeof encoded.time.created, "number"); assert.equal(encoded.time.created, DateTime.toEpochMillis(native.time.created));
  assert.equal(encoded.id, native.id); assert.equal(encoded.sessionID, session.id); assert.equal(encoded.payload.text, input.text);
  const status = await host.rpc(Grayboard).status({}, { location }); assert(Array.isArray(status.roots));
  await host.close(); await host.close();
  await assert.rejects(host.session.get({ sessionID: session.id }));
  await Bun.write(join(root, "result.json"), JSON.stringify({ installed, plugin: actual.id, bun: Bun.version, encodedTimestamp: encoded.time.created, nativeUtc: true, beforeAfterReturned: true, actualRpc: true, scopedClose: true }, null, 2));
} finally { releaseBefore.release(); releaseAfter.release(); await admission?.catch(() => {}); await host?.close(); }
