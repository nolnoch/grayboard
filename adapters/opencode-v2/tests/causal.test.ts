import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterProducers, rootRetrying, rootStatus, SubscriberAdmission } from "./causal.ts";
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

const admissionBody = (root = "A", id = 7) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "delivery_renew", _meta: { "ai.opencode/sessionID": root } } });
const admissionRequest = (role = "subscriber", signal?: AbortSignal) => new Request("https://fixture.example.com/mcp", { method: "POST", headers: role ? { "X-Grayboard-Client": role } : {}, signal });
// Protocol-only unit stand-in; actual server refusal is checked separately by the bounded loopback control.
const unitRefusal = () => Response.json({ jsonrpc: "2.0", id: 7, error: { code: -32000, data: { code: "rate_limited", retry_after_ms: 50 } } }, { status: 429, headers: { "Retry-After": "1" } });

test("admission setup holds the exact subscriber, observes its refusal, then releases its original retry", async () => {
  let now = 100, forwarded = 0;
  const gate = new SubscriberAdmission("A", () => now);
  const first = gate.forward(admissionRequest(), admissionBody(), async () => { forwarded++; return unitRefusal(); });
  let retry: Promise<Response> | undefined;
  try {
    await gate.entered.promise;
    expect(forwarded).toBe(0); expect(() => gate.requireRefused()).toThrow();
    gate.releaseInitial(); expect((await first).status).toBe(429);
    expect(gate.requireRefused()).toEqual({ root: "A", role: "subscriber", operation: "delivery_renew", id: 7, at: 100, status: 429, retryAfterMs: 50 });
    retry = gate.forward(admissionRequest(), admissionBody(), async () => { forwarded++; return new Response(); });
    await gate.retryEntered.promise;
    expect(forwarded).toBe(1); expect(gate.retryForwarded).toBe(false);
    expect(() => gate.releaseRecovery()).toThrow("refill");
    now += 6000; gate.releaseRecovery(); expect((await retry).status).toBe(200);
    expect(forwarded).toBe(2); expect(gate.retryForwarded).toBe(true);
    expect((await gate.forward(admissionRequest(), admissionBody("A", 8), async () => new Response())).status).toBe(200);
  } finally { gate.close(); await first.catch(() => {}); await retry?.catch(() => {}); }
});

test.each(["unrelated", "wrong-root", "headerless"])("%s HTTP429 cannot establish the selected subscriber precondition", async kind => {
  const gate = new SubscriberAdmission("A", () => 100);
  try {
    const response = await gate.forward(admissionRequest(kind === "headerless" ? "" : kind === "unrelated" ? "native" : "subscriber"), admissionBody(kind === "wrong-root" ? "B" : "A"), async () => unitRefusal());
    expect(response.status).toBe(429);
    expect(() => gate.requireRefused()).toThrow("no genuine selected-root");
    const laterSuccess = gate.forward(admissionRequest(), admissionBody(), async () => new Response());
    const rejected = assert.rejects(laterSuccess, /must receive an actual HTTP429/);
    await gate.entered.promise; gate.releaseInitial(); await rejected;
    expect(() => gate.requireRefused()).toThrow("no genuine selected-root");
  } finally { gate.close(); }
});

test("refill before release fails causal setup rather than passing as throttle recovery", async () => {
  let now = 100, forwarded = 0;
  const gate = new SubscriberAdmission("A", () => now);
  const pending = gate.forward(admissionRequest(), admissionBody(), async () => { forwarded++; return new Response(); });
  const rejected = assert.rejects(pending, /refill moved before/);
  try {
    await gate.entered.promise; now += 6000; gate.releaseInitial(); await rejected;
    expect(forwarded).toBe(0); expect(() => gate.requireRefused()).toThrow();
  } finally { gate.close(); }
});

test("account-transition abort retires the held original retry without forwarding or delivery", async () => {
  const gate = new SubscriberAdmission("A", () => 100), account = new AbortController();
  let forwarded = 0, admissions = 0, cursor = 0;
  const first = gate.forward(admissionRequest(), admissionBody(), async () => { forwarded++; return unitRefusal(); });
  let retry: Promise<Response> | undefined;
  try {
    await gate.entered.promise; gate.releaseInitial(); await first;
    retry = gate.forward(admissionRequest("subscriber", account.signal), admissionBody(), async () => { forwarded++; admissions++; cursor++; return new Response(); });
    const retired = assert.rejects(retry, /account selection changed/);
    await gate.retryEntered.promise; gate.requireRefused();
    account.abort(new Error("account selection changed"));
    await bounded(retired, 1000, "Aborted held request must retire");
    expect(gate.retryForwarded).toBe(false); expect(forwarded).toBe(1);
    expect(admissions).toBe(0); expect(cursor).toBe(0);
  } finally { gate.close(); account.abort(); await retry?.catch(() => {}); }
});

test("cleanup rejects a held initial request without forwarding it", async () => {
  const gate = new SubscriberAdmission("A", () => 100);
  let forwarded = false;
  const pending = gate.forward(admissionRequest(), admissionBody(), async () => { forwarded = true; return unitRefusal(); });
  const rejected = assert.rejects(pending, /barrier closed/);
  await gate.entered.promise; gate.close(); await bounded(rejected, 1000, "Fixture cleanup must join a held request");
  expect(forwarded).toBe(false);
});

test("producer refusal fails closed before any no-model assertion", async () => {
  let checked = false, drained = false;
  await expect(afterProducers(async () => { throw new Error("receipt not committed"); }, async () => { drained = true; }, () => { checked = true; })).rejects.toThrow("receipt not committed");
  expect(checked).toBe(false); expect(drained).toBe(false);
});
