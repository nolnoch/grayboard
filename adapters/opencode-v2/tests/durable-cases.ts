import assert from "node:assert/strict";
import { join } from "node:path";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { OpenCode } from "@opencode/sdk";

type Host = Awaited<ReturnType<typeof OpenCode.create>>;
type Input = Parameters<Context["session"]["synthetic"]>[0];
type Admission = Awaited<ReturnType<Context["session"]["synthetic"]>>;
export type Batch = { id: string; actionable: boolean; event: { text: string }; ownership: number; bind_gen: number; name: string };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
export class DurableFixture {
  readonly scenario = process.env.GRAYBOARD_DURABLE_CASE ?? "";
  readonly boundary = process.env.GRAYBOARD_DURABLE_BOUNDARY ?? "before";
  readonly phase = process.env.GRAYBOARD_DURABLE_PHASE ?? "admit";
  readonly batches = new Map<string, Batch[]>();
  readonly invalid = new Set<string>();
  readonly receiptAttempts: string[] = [];
  readonly cursor = new Set<string>();
  readonly inputs: Input[] = [];
  readonly admitted: Admission[] = [];
  readonly models: string[] = [];
  readonly entered = deferred();
  readonly released = deferred();
  revoked = false;
  configAway = false;
  dropReceipts = false;
  holding = true;
  constructor(readonly root: string) {}
  async synthetic(input: Input, forward: (input: Input) => Promise<Admission>) {
    this.inputs.push(structuredClone(input));
    if (this.holding && this.boundary === "before") { this.entered.resolve(); await this.released.promise; }
    const value = await forward(input);
    this.admitted.push(value);
    if (this.holding && this.boundary === "after") { this.entered.resolve(); await this.released.promise; }
    return value;
  }
  receipt(session: string, ids: string[]) {
    this.receiptAttempts.push(...ids);
    if (this.dropReceipts) throw new Error("fixture receipt connection disconnected");
    for (const id of ids) { assert(this.batches.get(session)?.some(i => i.id === id)); this.cursor.add(id); }
  }
}
async function until(read: () => boolean | Promise<boolean>, label: string) {
  for (let n = 0; n < 160; n++) { if (await read()) return; await Bun.sleep(50); }
  throw new Error("Durable wait expired: " + label);
}
export async function durableCases(f: DurableFixture, host: Host, ctx: Context, rpc: { enroll(input: { sessionID: string; name?: string }, options: { location: { directory: string } }): Promise<unknown>; pause(input: {}, options: { location: { directory: string } }): Promise<unknown>; status(input: {}, options: { location: { directory: string } }): Promise<unknown> }, location: { directory: string }, state: (id: string) => { name: string | null; ownership: number | null; gen: number; capability?: string }) {
  const replay = f.scenario === "reload";
  if (replay && f.phase === "reload") {
    const saved = await Bun.file(join(f.root, "durable.json")).json();
    f.holding = false;
    await until(() => f.cursor.size === 2, "replayed receipts");
    assert.deepEqual(f.inputs.map(i => i.id).sort(), saved.inputs.map((i: Input) => i.id).sort());
    for (const value of f.admitted) {
      const old = saved.inputs.find((i: Input) => i.id === value.id);
      assert(old); assert.equal(value.sessionID, old.sessionID); assert.equal(value.payload.text, old.text);
    }
    await Bun.sleep(500); assert.equal(f.models.length, 0, "delivered action replay and pending digest do not wake");
    assert.equal((await host.session.inbox.list({ sessionID: saved.digest })).length, 1);
    assert.equal((await host.session.context({ sessionID: saved.action })).filter(m => m.type === "synthetic").length, 1);
    assert.equal(f.cursor.size, 2);
    assert(f.inputs.every(i => i.text.includes("ALTERED REPLAY")), "replay uses changed incoming text to test immutable host records");
    assert.deepEqual(await host.session.inbox.list({ sessionID: saved.other }), []);
    assert.deepEqual(await host.session.inbox.list({ sessionID: saved.child }), []);
    await host.session.prompt({ sessionID: saved.digest, text: "Explicit later ordinary prompt" });
    await host.session.wait({ sessionID: saved.digest });
    assert(f.models.includes(saved.digest), "digest drains only after an ordinary wake");
    assert.equal((await host.session.context({ sessionID: saved.digest })).filter(m => m.type === "synthetic").length, 1);
    console.log("DURABLE_RELOAD_OK", JSON.stringify({ inputs: f.inputs, cursor: [...f.cursor], models: f.models }));
    return;
  }
  const create = async (title: string, parentID?: string) => {
    const session = await host.session.create({ location, title, ...(parentID ? { parentID } : {}) });
    await host.session.switchModel({ sessionID: session.id, model: { providerID: "fixture", id: "fixture" } }); return session.id;
  };
  const root = await create("Durable root"), other = await create("Untouched root"), child = await create("Untouched child", root);
  await rpc.enroll({ sessionID: root, name: "durable" }, { location });
  await until(() => !!state(root).capability, "initial lease");
  const batch = (session: string, id: string, actionable: boolean): Batch => ({ id, actionable, event: { text: "IMMUTABLE ORIGINAL " + id }, ownership: state(session).ownership!, bind_gen: state(session).gen, name: state(session).name! });
  if (replay) {
    const action = await create("Durable action");
    await rpc.enroll({ sessionID: action, name: "action" }, { location });
    await until(() => !!state(action).capability, "action lease");
    f.holding = false; f.dropReceipts = true;
    f.batches.set(root, [batch(root, "fixture:digest", false)]); f.batches.set(action, [batch(action, "fixture:action", true)]);
    await until(() => f.admitted.length >= 2 && f.receiptAttempts.length >= 2, "durable admissions before lost receipts");
    await host.session.wait({ sessionID: action }); await Bun.sleep(200);
    assert.equal(f.models.filter(id => id === root).length, 0, "digest stays idle");
    assert(f.models.includes(action), "actionable delivery wakes exact root");
    assert.equal((await host.session.inbox.list({ sessionID: root })).length, 1);
    assert.equal((await host.session.context({ sessionID: action })).filter(m => m.type === "synthetic").length, 1);
    assert.equal(f.cursor.size, 0, "lost receipts never move fake cursor");
    await Bun.write(join(f.root, "durable.json"), JSON.stringify({ digest: root, action, other, child, inputs: f.inputs.slice(0, 2), batches: [...f.batches] }));
    console.log("DURABLE_ADMIT_OK", JSON.stringify({ inputs: f.inputs, cursor: [...f.cursor], receiptAttempts: f.receiptAttempts, models: f.models }));
    return;
  }
  f.batches.set(root, [batch(root, "fixture:race", true)]);
  await f.entered.promise;
  const old = structuredClone(f.inputs[0]!);
  assert.equal(old.sessionID, root); assert(old.id); assert(old.text.includes("IMMUTABLE ORIGINAL"));
  if (f.boundary === "before") assert.deepEqual(await host.session.inbox.list({ sessionID: root }), []);
  else { await host.session.wait({ sessionID: root }); assert(f.models.includes(root)); }
  let transition: Promise<unknown> = Promise.resolve();
  switch (f.scenario) {
    case "pause": transition = rpc.pause({}, { location }); break;
    case "archive": transition = host.session.update({ sessionID: root, archived: true }); break;
    case "delete": transition = host.session.remove({ sessionID: root }); break;
    case "rebind": transition = rpc.enroll({ sessionID: root, name: "replacement" }, { location }); break;
    case "expiry": f.invalid.add(root); break;
    case "revocation": f.revoked = true; break;
    case "account": case "account-away-back": {
      const integrationID = (await ctx.mcp.list()).data.find(m => m.name === "grayboard")!.integrationID!;
      const old = (await host.credential.list()).find(c => c.integrationID === integrationID && c.active); assert(old);
      const method = (await ctx.integration.get({ integrationID })).data!.methods.find(m => m.type === "oauth")!;
      await host.credential.create({ integrationID, label: "Fixture other account", activate: true, value: { type: "oauth", methodID: method.id, access: "fixture-other-access", refresh: "fixture-other-refresh", expires: Date.now() + 3_600_000, metadata: { serverUrl: "https://grayboard.example.com/mcp", issuer: "https://grayboard.example.com", scope: "grayboard:delivery grayboard:tools", client: { client_id: "fixture-native-client" } } } });
      if (f.scenario === "account-away-back") await host.credential.activate({ credentialID: old.id });
      break;
    }
    case "late-away-back":
      await ctx.mcp.transform(e => e.set("grayboard", { type: "remote", url: "https://grayboard.example.com/mcp", headers: { "X-Fixture-Drift": "late" }, codemode: false }));
      await ctx.mcp.transform(e => e.set("grayboard", { type: "remote", url: "https://grayboard.example.com/mcp", codemode: false }));
      break;
    case "config": case "away-back":
      f.configAway = true; await ctx.mcp.reload();
      if (f.scenario === "away-back") { f.configAway = false; await ctx.mcp.reload(); }
      break;
    default: throw new Error("Unknown durable case " + f.scenario);
  }
  await Bun.sleep(200);
  if (["account", "account-away-back", "config", "away-back", "late-away-back"].includes(f.scenario)) {
    await until(async () => (await rpc.status({}, { location }) as { state: string }).state === "paused", "observed drift latched before forwarding/returning the held write");
  }
  f.holding = false; f.released.resolve();
  await transition;
  if (f.scenario === "rebind") f.batches.clear();
  await Bun.sleep(700);
  assert.deepEqual(f.inputs[0], old, "the authorized in-flight input never retargets or mutates");
  assert.equal(f.receiptAttempts.length, 0, "stale completion cannot attempt receipt or advance cursor");
  assert.equal(f.cursor.size, 0);
  assert.equal(f.inputs.length, 1, "no new admission after the observed transition");
  for (const value of f.admitted) {
    assert.equal(value.id, old.id); assert.equal(value.sessionID, old.sessionID);
    assert.equal(value.payload.text, old.text); assert.deepEqual(value.payload.metadata, old.metadata);
  }
  assert.equal((await host.session.context({ sessionID: other })).filter(m => m.type === "synthetic").length, 0);
  assert.deepEqual(await host.session.inbox.list({ sessionID: other }), []);
  if (f.scenario === "delete") await assert.rejects(host.session.get({ sessionID: child }));
  else assert.deepEqual(await host.session.inbox.list({ sessionID: child }), []);
  assert.equal(f.models.some(id => id === other || id === child), false);
  if (f.scenario === "delete") {
    await assert.rejects(host.session.get({ sessionID: root }));
    assert.equal(f.models.filter(id => id === root).length, f.boundary === "before" ? 0 : 1);
    assert.equal(f.admitted.length, f.boundary === "before" ? 0 : 1);
  }
  else {
    await host.session.wait({ sessionID: root });
    const synthetic = (await host.session.context({ sessionID: root })).filter(m => m.type === "synthetic");
    assert.equal(synthetic.length, 1); assert.equal(synthetic[0]!.id, old.id);
    assert(f.models.includes(root), "accepted old actionable write wakes only its original root");
  }
  console.log("DURABLE_RACE_OK", JSON.stringify({ scenario: f.scenario, boundary: f.boundary, input: old, admitted: f.admitted.map(a => ({ id: a.id, sessionID: a.sessionID, payload: a.payload })), cursor: [...f.cursor], receiptAttempts: f.receiptAttempts, models: f.models }));
}
