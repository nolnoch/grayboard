import { test } from "bun:test";
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertStable, barrier, bounded, drainSessions, sessionStates, workerBootstrap, heldInput, committedRoots } from "./reload-state.ts";

async function fixture(run: (db: Database, path: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "reload-state-")), path = join(root, "host.sqlite"), db = new Database(path);
  try {
    db.exec("CREATE TABLE session_v2(id TEXT PRIMARY KEY, time_suspended INTEGER); CREATE TABLE session_message(id TEXT, session_id TEXT, type TEXT, data TEXT); CREATE TABLE session_inbox(id TEXT)");
    await run(db, path);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
}

test("reload drain enumerates all owned sessions and repeats for newly created children", () => fixture(async (db, path) => {
  for (let n = 0; n < 250; n++) db.query("INSERT INTO session_v2 VALUES (?, 1)").run(String(n));
  const waited = new Set<string>();
  await drainSessions(path, async id => {
    waited.add(id); db.query("UPDATE session_v2 SET time_suspended = NULL WHERE id = ?").run(id);
    if (id === "0") db.exec("INSERT OR IGNORE INTO session_v2 VALUES ('late-child', 1)");
  });
  assert.equal(waited.size, 251); assert(waited.has("late-child"));
  assert(sessionStates(path).every(s => s.time_suspended === null));
}));

test("wait completion is required and inactive suspension is not repaired by drain", () => fixture(async (db, path) => {
  db.exec("INSERT INTO session_v2 VALUES ('target', 1)");
  await assert.rejects(drainSessions(path, async () => {}), /must be unsuspended/);
  const entered = barrier(), released = barrier();
  const draining = drainSessions(path, async () => { entered.release(); await released.promise; db.exec("UPDATE session_v2 SET time_suspended = NULL"); });
  await entered.promise; assert.equal(sessionStates(path)[0]!.time_suspended, 1);
  released.release(); await draining;
}));

test("only the explicitly held target may be excluded in the separate suspended regression", () => fixture(async (db, path) => {
  db.exec("INSERT INTO session_v2 VALUES ('target', 1), ('sibling', 1)");
  const waited: string[] = [];
  await drainSessions(path, async id => { waited.push(id); db.query("UPDATE session_v2 SET time_suspended = NULL WHERE id = ?").run(id); }, "target");
  assert.deepEqual(waited, ["sibling"]); assert.equal(sessionStates(path).find(s => s.id === "target")!.time_suspended, 1);
}));

test("stable input requires exact target/text/metadata, global uniqueness and zero pending copies", () => fixture(async (db, path) => {
  const input = { id: "stable", sessionID: "target", text: "Fixture", metadata: { notice: "delivery" } };
  db.query("INSERT INTO session_message VALUES (?, ?, 'synthetic', ?)").run(input.id, input.sessionID, JSON.stringify({ text: input.text, metadata: input.metadata }));
  assertStable(path, input);
  assert.throws(() => assertStable(path, { ...input, sessionID: "sibling" }));
  assert.throws(() => assertStable(path, { ...input, text: "changed" }));
  assert.throws(() => assertStable(path, { ...input, metadata: {} }));
  db.exec("INSERT INTO session_inbox VALUES ('stable')"); assert.throws(() => assertStable(path, input), /pending copy/);
  db.exec("DELETE FROM session_inbox; INSERT INTO session_message SELECT * FROM session_message");
  assert.throws(() => assertStable(path, input), /globally exactly once/);
}));

test("owned promise barriers are bounded on failure", async () => {
  await assert.rejects(bounded(barrier().promise, 0, "Fixture barrier expired"), /Fixture barrier expired/);
  const gate = barrier(); gate.release(); await bounded(gate.promise, 100, "unused");
});

// Contract stand-ins only; these do not simulate SDK process or receipt completion.
const action = { sessionID: "ses_action", id: "msg_action", text: "Action fixture", delivery: "queue", resume: true, metadata: { source: "grayboard" } };
const digest = { ...action, sessionID: "ses_digest", id: "msg_digest", resume: false };
const common = { pid: 123, location: { directory: "/fixture" } };
for (const mode of ["hold-before", "hold-after"]) test(`${mode} accepts pre-input bootstrap with one exact receipt root`, () => {
  const bootstrap = workerBootstrap(mode, { ...common, sessionID: action.sessionID });
  assert.deepEqual([...bootstrap.expectedRoots], [action.sessionID]);
  assert.deepEqual(heldInput(bootstrap, action), action);
  assert.throws(() => heldInput(bootstrap, { ...action, sessionID: digest.sessionID }));
  assert.throws(() => heldInput(bootstrap, { ...action, id: undefined }));
  assert.throws(() => heldInput(bootstrap, { ...action, text: undefined }));
  assert.throws(() => heldInput(bootstrap, { ...action, metadata: { source: "grayboard", lost: undefined } }));
});
for (const [mode, flags] of [["replay", {}], ["replay", { uncommitted: true }], ["replay", { settled: true }], ["suspended-resume", {}]] as const) test(`${mode} validates action and optional digest without losing either receipt root ${JSON.stringify(flags)}`, () => {
  const one = workerBootstrap(mode, { ...common, input: action, ...flags });
  assert.deepEqual([...one.expectedRoots], [action.sessionID]);
  const both = workerBootstrap(mode, { ...common, input: action, digestInput: digest, ...flags });
  assert.deepEqual([...both.expectedRoots], [action.sessionID, digest.sessionID]);
  assert.equal(committedRoots(both.expectedRoots, new Set(["ses_unrelated"])), false);
  assert.equal(committedRoots(both.expectedRoots, new Set([action.sessionID])), false);
  assert.equal(committedRoots(both.expectedRoots, new Set([digest.sessionID])), false);
  assert.equal(committedRoots(both.expectedRoots, new Set([action.sessionID, digest.sessionID])), true);
});
test("worker modes and hold roots are explicit, never inferred from replay input", () => {
  for (const mode of ["", "hold-other", "unknown", null, 1]) assert.throws(() => workerBootstrap(mode, { ...common, sessionID: action.sessionID }));
  for (const sessionID of [undefined, "", 1, null, "not-sdk-root"]) for (const mode of ["hold-before", "hold-after"]) assert.throws(() => workerBootstrap(mode, { ...common, sessionID }));
  assert.throws(() => workerBootstrap("hold-before", { ...common, sessionID: action.sessionID, input: action }));
  assert.throws(() => committedRoots(new Set(), new Set()));
});
test("replay cannot fall back and rejects malformed action, digest, identity and contradictory roots", () => {
  for (const input of [undefined, null, {}, ...["sessionID", "id", "text", "delivery", "resume", "metadata"].map(key => ({ ...action, [key]: undefined })), { ...action, sessionID: 1 }, { ...action, id: "" }, { ...action, text: 7 }, { ...action, resume: false }]) {
    assert.throws(() => workerBootstrap("replay", { ...common, sessionID: action.sessionID, input }));
  }
  assert.throws(() => workerBootstrap("replay", { ...common, input: action, sessionID: digest.sessionID }));
  for (const digestInput of [undefined, null, {}, ...["sessionID", "id", "text", "delivery", "resume", "metadata"].map(key => ({ ...digest, [key]: undefined })), { ...digest, id: action.id }, { ...digest, resume: true }]) assert.throws(() => workerBootstrap("replay", { ...common, input: action, digestInput }));
  assert.throws(() => workerBootstrap("replay", { ...common, input: action, settled: true, uncommitted: true }));
});
