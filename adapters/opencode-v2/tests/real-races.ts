import assert from "node:assert/strict";
import type { FailedContinuation } from "./failed-continuation.js";
import { join } from "node:path";
import type { SubscriberWork } from "./subscriber-work.ts";
import { bounded, drainSessions } from "./reload-state.ts";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { FixtureHost } from "./effect-host.js";
import type { NativeInput, NativeAdmission } from "./effect-instrument.js";
import type { startServer } from "../../../src/server/app.ts";
import { OPENCODE_CLIENT } from "../../../tests/helpers/hosted.ts";
import { sessionContext } from "../../../src/server/hosted.ts";

type Input = NativeInput;
export type AdmissionGate = {
  holding: boolean; boundary: "before" | "after"; inputs: Input[];
  accepted: NativeAdmission[];
  models: string[]; entered(): void; released: Promise<void>;
};
async function until(read: () => boolean | Promise<boolean>, label: string) {
  for (let n = 0; n < 240; n++) { if (await read()) return; await Bun.sleep(50); }
  throw new Error("Real race wait expired: " + label);
}
export async function realRace(f: {
  scenario: string; gate: AdmissionGate; host: FixtureHost;
  ctx: Context; app: ReturnType<typeof startServer>; location: { directory: string };
  subscriberWork: SubscriberWork;
  expiryContinuation: FailedContinuation;
  enroll(sessionID: string, name: string): Promise<unknown>; pause(): Promise<unknown>;
  status(): Promise<{ state: string }>; account(): Promise<void>; outage(value: boolean): void; receipts(): number;
}) {
  const { host, app, ctx, gate: g, scenario, location } = f;
  const create = async (title: string, parentID?: string) => {
    const s = await host.session.create({ location, title, ...(parentID ? { parentID } : {}) });
    await host.session.switchModel({ sessionID: s.id, model: { providerID: "fixture", id: "fixture" } }); return s.id;
  };
  const root = await create("Real race root"), other = await create("Untouched root"), child = await create("Untouched child", root);
  await f.enroll(root, "race"); await until(() => app.mcp.activeLeases === 1, "approved lease");
  if (scenario === "outage") {
    const owner = () => app.db.prepare("SELECT ownership_id FROM hosted_sessions WHERE source_session_id = ?").get(root) as { ownership_id: number } | null;
    const old = owner()!.ownership_id; f.outage(true);
    const message = app.repo.messages.insert("you@example.com/sim", "user", "you@example.com/race", "Real network outage recovery", null, false); app.application.wake(["you@example.com/race"]);
    await Bun.sleep(31_000); app.mcp.sessions.sweep();
    assert.equal(owner(), null); assert.equal(app.repo.cursors.directFor("you@example.com/race"), 0); assert.equal(g.inputs.length, 0);
    f.outage(false);
    await until(() => app.repo.cursors.directFor("you@example.com/race") === message.id, "automatic rightful ownership after actual expired outage");
    assert.notEqual(owner()!.ownership_id, old); assert.equal(g.inputs.length, 1); assert.equal(g.inputs[0]!.sessionID, root);
    await host.session.wait({ sessionID: root }); assert(g.models.includes(root)); assert(!g.models.includes(other)); assert(!g.models.includes(child));
    console.log("REAL_NETWORK_OUTAGE_RECOVERY_OK", { oldOwnership: old, recoveredOwnership: owner()!.ownership_id, cursor: message.id }); return;
  }
  let release!: () => void;
  const entered = new Promise<void>(r => { g.entered = r; });
  g.released = new Promise<void>(r => { release = r; }); g.holding = true;
  const beforeCursor = app.repo.cursors.directFor("you@example.com/race"), beforeReceipts = f.receipts();
  const message = app.repo.messages.insert("you@example.com/sim", "user", "you@example.com/race", "IMMUTABLE REAL " + scenario, null, false);
  app.application.wake(["you@example.com/race"]);
  try {
    await Promise.race([entered, Bun.sleep(15_000).then(() => { throw new Error("No real issued batch"); })]);
    const original = structuredClone(g.inputs[0]!); assert.equal(original.sessionID, root); assert(original.text.includes(message.body));
    assert.equal(app.repo.cursors.directFor("you@example.com/race"), beforeCursor);
    if (g.boundary === "after") { await host.session.wait({ sessionID: root }); assert(g.models.includes(root)); }
    else assert.equal(g.accepted.length, 0);
    const retiredSubscriber = f.subscriberWork.current(root);
    let transition: Promise<unknown> = Promise.resolve();
    switch (scenario) {
      case "pause": transition = f.pause(); break;
      case "enrollment": transition = f.enroll(root, "replacement"); break;
      case "archive": transition = host.session.update({ sessionID: root, archived: true }); break;
      case "delete": transition = host.session.remove({ sessionID: root }); break;
      case "account": case "account-away-back": {
        const old = (await host.credential.list()).find((c: { id: string; active: boolean }) => c.active); assert(old);
        await f.account();
        if (scenario === "account-away-back") await host.credential.activate({ credentialID: old.id });
        break;
      }
      case "config": case "away-back": {
        const registration = await ctx.mcp.transform(e => { const c = e.get("grayboard"); assert(c?.type === "remote"); e.set("grayboard", { ...c, headers: { "X-Fixture-Drift": "away" } }); });
        await ctx.mcp.reload();
        if (scenario === "away-back") { await registration.dispose(); await ctx.mcp.reload(); }
        break;
      }
      case "rebind": {
        const integrationID = (await ctx.mcp.list()).data.find(c => c.name === "grayboard")!.integrationID!;
        const connection = await ctx.integration.connection.active(integrationID); assert(connection);
        const grant = await ctx.integration.connection.resolve(connection); assert(grant?.type === "oauth");
        const principal = app.oauth.authenticate(new Request("https://grayboard.example.com/hosted/mcp", { headers: { Authorization: "Bearer " + grant.access } })); assert(!(principal instanceof Response));
        await app.mcp.sessions.bind(principal, sessionContext(principal, { "ai.opencode/sessionID": root }), { name: "replacement", create: true });
        break;
      }
      case "expiry": {
        f.expiryContinuation.arm();
        f.outage(true); await Bun.sleep(31_000); app.mcp.sessions.sweep();
        assert.equal(app.db.prepare("SELECT 1 FROM hosted_sessions WHERE source_session_id = ?").get(root), null, "Real wall-clock sticky deadline releases ownership");
        break;
      }
      case "revocation": {
        const row = app.db.prepare("SELECT grant_id FROM hosted_sessions WHERE source_session_id = ?").get(root) as { grant_id: string };
        const token = app.db.prepare("SELECT hash FROM oauth_tokens WHERE grant_id = ? AND kind = 'refresh' LIMIT 1").get(row.grant_id) as { hash: string };
        app.repo.oauth.revokeToken(token.hash, OPENCODE_CLIENT, Date.now());
        break;
      }
      default: throw new Error("Unknown real race " + scenario);
    }
    if (["account", "account-away-back", "config", "away-back"].includes(scenario)) await until(async () => (await f.status()).state === "paused", "observed drift before releasing original write");
    g.holding = false; release(); await transition;
    if (scenario === "expiry") await bounded(f.expiryContinuation.failed.promise, 12_000, "Real forwarding returned and its failed post-admission transport completion is held before retry");
    else await bounded(retiredSubscriber, 12_000, "Original issued subscriber generation must finish, including its post-admission continuation");
    await drainSessions(join(process.env.GRAYBOARD_GIT_TEST_ROOT!, "host.sqlite"), sessionID => host.session.wait({ sessionID }));
    await Bun.sleep(700); // Supplemental only, after producer retirement and global SDK drain.
    assert.deepEqual(g.inputs[0], original); assert.equal(g.inputs.length, 1, "No subsequent admission after original subscriber completion");
    assert.equal(f.receipts(), beforeReceipts, "No stale receipt attempt");
    assert.equal(app.repo.cursors.directFor("you@example.com/race"), beforeCursor, "Actual backend cursor unchanged");
    assert.deepEqual(await host.session.inbox.list({ sessionID: other }), []);
    assert.equal((await host.session.context({ sessionID: other })).filter((m: { id?: string; type?: string }) => m.type === "synthetic").length, 0);
    assert(!g.models.includes(other)); assert(!g.models.includes(child));
    if (scenario === "delete") {
      await assert.rejects(host.session.get({ sessionID: root })); await assert.rejects(host.session.get({ sessionID: child }));
      assert.equal(g.accepted.length, g.boundary === "before" ? 0 : 1);
      assert.equal(g.models.filter(s => s === root).length, g.boundary === "before" ? 0 : 1);
    } else {
      await host.session.wait({ sessionID: root });
      const actual = (await host.session.context({ sessionID: root })).filter((m: { id?: string; type?: string }) => m.type === "synthetic");
      assert.equal(actual.length, 1); assert.equal(actual[0]!.id, original.id);
      assert.deepEqual(await host.session.inbox.list({ sessionID: child }), []);
      assert(g.models.includes(root), "Accepted old actionable write may wake only exact approved root");
    }
    for (const a of g.accepted) { assert.equal(a.sessionID, original.sessionID); assert.equal(a.id, original.id); assert.equal(a.payload.text, original.text); assert.deepEqual(a.payload.metadata, original.metadata); }
    console.log("REAL_ISSUED_RACE_OK", JSON.stringify({ scenario, boundary: g.boundary, original, accepted: g.accepted.map(a => ({ id: a.id, sessionID: a.sessionID, payload: a.payload })), message: message.id, cursorBefore: beforeCursor, cursorAfter: app.repo.cursors.directFor("you@example.com/race"), staleReceipts: f.receipts() - beforeReceipts, models: g.models }));
  } finally { g.holding = false; release(); f.expiryContinuation.release(); }
}
