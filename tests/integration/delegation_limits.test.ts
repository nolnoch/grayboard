// delegate's limits (#252): a per-requester token bucket and a cap on the
// delegation requests one launcher holds but hasn't taken, in both modes.
// The server cases move the hub clock; a local session's clock is its own
// process's, so the local cases exhaust the defaults instead.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DELEGATE_LIMIT, DELEGATE_OPEN_CAP } from "../../src/core/delegation.ts";
import { refusal, type AppSession } from "../support/app_session.ts";
import { call, closeSessions, localSession, refusal as localRefusal } from "../support/mcp.ts";
import { TestServer } from "../support/server.ts";

type Delegated = { to: string; message_id: number; replayed?: unknown };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grayboard-delegate-limits-"));
});
afterEach(async () => {
  await closeSessions();
  rmSync(dir, { recursive: true, force: true });
});

const launcher = (srv: TestServer, token: string, identity: string): Promise<AppSession> => srv.connected(token, identity, { launcher: true });
const rows = (srv: TestServer, action: string) =>
  (srv.app.db.query(`SELECT actor, target, detail FROM access_log WHERE action = ? ORDER BY id`).all(action) as { actor: string; target: string; detail: string }[]);

test("server: the requester's bucket refuses past the burst, audits one streak, and charges neither a replay nor a refusal", async () => {
  let clock = Date.now();
  const srv = new TestServer({ hostedRequestLimit: { burst: 10_000, perSec: 10_000 }, delegateLimit: { burst: 2, perSec: 1 / 60 } }, { now: () => clock });
  try {
    const token = await srv.login("you@example.com");
    await launcher(srv, token, "be");
    const sim = await srv.connected(token, "sim");

    await sim.delegate({ persona: "p", task: "t1" });
    // A refusal (an unknown `to`) spends nothing.
    await refusal(sim.delegate({ persona: "p", task: "t0", to: "nobody" }));
    const second = await sim.delegate({ persona: "p", task: "t2" });
    // The bucket is empty, but an identical repeat is a replay: answered, not charged or refused.
    const again = await sim.delegate({ persona: "p", task: "t2" });
    expect(again.replayed).toBeDefined();
    expect(again.message_id).toBe(second.message_id);

    const r = await refusal(sim.delegate({ persona: "p", task: "t3" }));
    expect(r.code).toBe("rate_limited");
    expect(r.message).toContain("too many delegation requests");
    expect(r.extra.retry_after_ms).toBeGreaterThan(0);
    // resend writes again, so it's charged: refused too.
    expect((await refusal(sim.delegate({ persona: "p", task: "t2", resend: true }))).code).toBe("rate_limited");

    // One throttled row for the streak, naming the requester; the throttled calls aren't delegation.refused rows.
    const throttled = rows(srv, "delegation.throttled");
    expect(throttled.length).toBe(1);
    expect(throttled[0]!.target).toBe("you@example.com/sim");
    expect(throttled[0]!.actor).toBe("you@example.com");
    expect(rows(srv, "delegation.refused").map((x) => JSON.parse(x.detail).reason)).toEqual([expect.stringContaining("nobody")]);

    // A minute refills one token.
    clock += 61_000;
    expect((await sim.delegate({ persona: "p", task: "t3" })).to).toBe("you@example.com/be");
    expect(rows(srv, "delegation.requested").length).toBe(3);
  } finally {
    await srv.stop();
  }
}, 30_000);

test("server, hosted: the throttled row survives the tool call's rolled-back transaction", async () => {
  const srv = new TestServer({ hostedRequestLimit: { burst: 10_000, perSec: 10_000 }, delegateLimit: { burst: 1, perSec: 1 / 60 } });
  try {
    const token = await srv.login("you@example.com");
    await launcher(srv, token, "be");
    const sim = await srv.hosted("you@example.com", "sim");
    await sim.call("delegate", { persona: "p", task: "t1" });
    await expect(sim.call("delegate", { persona: "p", task: "t2" })).rejects.toThrow(/too many delegation requests/);
    await expect(sim.call("delegate", { persona: "p", task: "t3" })).rejects.toThrow(/too many delegation requests/);
    expect(rows(srv, "delegation.throttled").length).toBe(1);
    expect(rows(srv, "delegation.refused").length).toBe(0);
  } finally {
    await srv.stop();
  }
}, 30_000);

test("server: a full launcher is skipped by the auto-pick and refused by name; its reply or ack frees a slot", async () => {
  const srv = new TestServer({ hostedRequestLimit: { burst: 10_000, perSec: 10_000 }, delegateLimit: { burst: 100, perSec: 100 }, delegateOpenCap: 2 });
  try {
    const token = await srv.login("you@example.com");
    const be = await launcher(srv, token, "be");
    await launcher(srv, token, "bo");
    const sim = await srv.connected(token, "sim");

    const a = await sim.delegate({ persona: "p", task: "a" });
    const b = await sim.delegate({ persona: "p", task: "b" });
    expect([a.to, b.to]).toEqual(["you@example.com/be", "you@example.com/be"]);
    // be holds two it hasn't taken: the auto-pick moves on to bo.
    expect((await sim.delegate({ persona: "p", task: "c" })).to).toBe("you@example.com/bo");
    const named = await refusal(sim.delegate({ persona: "p", task: "d", to: "be" }));
    expect(named.message).toContain("open delegation requests");
    // The requester's own ack settles its promise, not the launcher's slot.
    await sim.dmAck(a.message_id);
    expect((await refusal(sim.delegate({ persona: "p", task: "d", to: "be" }))).message).toContain("open delegation requests");

    // be takes one by replying in its thread, and acks the other.
    await be.send("sim", "spawned", { parent_id: a.message_id });
    expect((await sim.delegate({ persona: "p", task: "d", to: "be" })).to).toBe("you@example.com/be");
    await be.dmAck(b.message_id);
    expect((await sim.delegate({ persona: "p", task: "e", to: "be" })).to).toBe("you@example.com/be");

    // Both full now (be: d, e; bo: c and one more): refused, never handed to the human.
    await sim.delegate({ persona: "p", task: "f", to: "bo" });
    const all = await refusal(sim.delegate({ persona: "p", task: "g" }));
    expect(all.message).toContain("every live launcher");
  } finally {
    await srv.stop();
  }
}, 30_000);

test("local: the bucket refuses past the burst with one throttled row, and the cap holds across requesters", async () => {
  await localSession(dir, "be", { extra: { BUS_LAUNCHER: "1" } });
  const sims = [await localSession(dir, "sim1"), await localSession(dir, "sim2"), await localSession(dir, "sim3")];
  // Two requesters spend their bursts: DELEGATE_OPEN_CAP requests on be, none taken.
  expect(DELEGATE_LIMIT.burst * 2).toBe(DELEGATE_OPEN_CAP);
  for (const sim of sims.slice(0, 2)) {
    for (let i = 0; i < DELEGATE_LIMIT.burst; i++) expect((await call(sim.c, "delegate", { persona: "p", task: `t${i}` })).to).toBe("be");
  }
  expect(await localRefusal(sims[0]!, "delegate", { persona: "p", task: "over" })).toContain("too many delegation requests");
  expect(await localRefusal(sims[0]!, "delegate", { persona: "p", task: "over again" })).toContain("too many delegation requests");
  // A third requester has tokens, but be is full.
  expect(await localRefusal(sims[2]!, "delegate", { persona: "p", task: "t" })).toContain("every live launcher");
  expect(await localRefusal(sims[2]!, "delegate", { persona: "p", task: "t", to: "be" })).toContain("open delegation requests");

  const bus = new Database(join(dir, "bus.db"), { readonly: true });
  try {
    const throttled = bus.query(`SELECT actor FROM audit_log WHERE action = 'delegation.throttled'`).all() as { actor: string }[];
    expect(throttled.map((r) => r.actor)).toEqual(["sim1"]);
  } finally {
    bus.close();
  }
}, 60_000);
