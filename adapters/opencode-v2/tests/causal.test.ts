import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterProducers, rootRetrying, rootStatus } from "./causal.ts";
import { observeRuns } from "./subscriber-work.ts";
import { barrier, bounded, drainSessions } from "./reload-state.ts";

test.each(["settled", "suspended", "lost-receipt"])("late forbidden primary cannot pass the %s causal replay check", async mode => {
  const receipt = barrier(), entered = barrier(), model = barrier();
  const target = "target";
  const models = mode === "suspended" ? [target] : [];
  const allowed = [...models];
  let finished = false;
  const check = () => assert.deepEqual(models, allowed);
  check(); // The old elapsed-only oracle could run here, while the controlled producer is still held.
  const result = afterProducers(async () => { entered.release(); await receipt.promise; }, async () => {
    await model.promise; models.push(mode === "lost-receipt" ? "digest" : target);
  }, check).finally(() => { finished = true; });
  const rejected = assert.rejects(result, /deep-equal/);
  try {
    await entered.promise; await Promise.resolve(); expect(finished).toBe(false);
    receipt.release(); await Promise.resolve(); expect(finished).toBe(false);
    model.release(); await bounded(rejected, 1000, "Late primary must fail causal assertion");
  } finally { receipt.release(); model.release(); await result.catch(() => {}); }
});

test("global drain counts unrelated roots and re-enumerates children created while waiting", async () => {
  const root = mkdtempSync(join(tmpdir(), "grayboard-causal-")), path = join(root, "host.sqlite");
  const db = new Database(path);
  const models: string[] = [], waited: string[] = [];
  db.exec("CREATE TABLE session_v2 (id TEXT PRIMARY KEY, time_suspended INTEGER)");
  db.exec("INSERT INTO session_v2 VALUES ('target', NULL), ('unrelated', NULL)");
  try {
    await assert.rejects(afterProducers(async () => {}, () => drainSessions(path, async id => {
      waited.push(id);
      if (id === "target" && !db.query("SELECT 1 FROM session_v2 WHERE id='late-child'").get()) db.exec("INSERT INTO session_v2 VALUES ('late-child', NULL)");
      if (id === "late-child") models.push(id);
    }), () => assert.equal(models.length, 0)), /strictly equal/);
    expect(waited).toContain("unrelated"); expect(waited).toContain("late-child");
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("retired-generation barrier joins the real continuation, not synthetic return or a later generation", async () => {
  const released = barrier(), entered = barrier(), replacement = barrier();
  const calls: string[] = [];
  class Subscriber {
    async run(_root: unknown, enrollment: { sessionID: string }, generation: number) {
      entered.release();
      await (generation === 1 ? released.promise : replacement.promise);
      if (generation === 1) calls.push(enrollment.sessionID);
    }
  }
  const original = Subscriber.prototype.run;
  const observation = observeRuns(Subscriber.prototype), instance = new Subscriber();
  const first = instance.run({}, { sessionID: "root" }, 1);
  const retired = observation.current("root");
  const second = instance.run({}, { sessionID: "root" }, 2);
  const result = afterProducers(() => retired, async () => {}, () => assert.equal(calls.length, 0));
  const rejected = assert.rejects(result, /strictly equal/);
  try {
    await entered.promise;
    assert.equal(calls.length, 0, "An elapsed-only absence check passes while the actual continuation is held");
    released.release();
    await bounded(rejected, 1000, "Late forbidden continuation must fail without waiting for unrelated new generation");
    expect(observation.current("root")).not.toBe(retired);
  } finally { released.release(); replacement.release(); await Promise.all([first, second]); observation.restore(); }
  expect(Subscriber.prototype.run).toBe(original);
});

test("exact root retry is visible while the aggregate legitimately prioritizes another paused root", () => {
  const b = Object.freeze({ sessionID: "B", state: "paused", operation: "delivery" });
  const a = Object.freeze({ sessionID: "A", state: "retrying", operation: "reopen", code: "operation_failed" });
  const status = { state: "paused", sessionID: "B", roots: Object.freeze([b, a]) };
  expect(rootRetrying(status, "A")).toBe(true);
  expect(rootStatus(status, "B")).toBe(b);
  expect(rootStatus(status, "B")?.state).toBe("paused");
  expect(status.state).toBe("paused");
});

test("another root retry cannot satisfy a paused target's retry boundary", () => {
  const status = { state: "retrying", roots: [
    { sessionID: "B", state: "retrying", operation: "reopen", code: "operation_failed" },
    { sessionID: "A", state: "paused", operation: "subscriber", code: "retry_exhausted" },
  ] };
  expect(rootRetrying(status, "A")).toBe(false);
  expect(rootStatus(status, "A")?.state).toBe("paused");
});

test("a missing exact root cannot satisfy the retry boundary", () => {
  const status = { roots: [{ sessionID: "B", state: "retrying", operation: "reopen", code: "operation_failed" }] };
  expect(rootRetrying(status, "A")).toBe(false);
  expect(rootStatus(status, "A")).toBeUndefined();
});

test.each([{ operation: "subscriber", code: "operation_failed" }, { operation: "reopen", code: "not_found" }])("a different retry phase or cause cannot satisfy the lost-transport boundary: %j", phase => {
  expect(rootRetrying({ roots: [{ sessionID: "A", state: "retrying", ...phase }] }, "A")).toBe(false);
});

test("producer refusal fails closed before any no-model assertion", async () => {
  let checked = false, drained = false;
  await expect(afterProducers(async () => { throw new Error("receipt not committed"); }, async () => { drained = true; }, () => { checked = true; })).rejects.toThrow("receipt not committed");
  expect(checked).toBe(false); expect(drained).toBe(false);
});
