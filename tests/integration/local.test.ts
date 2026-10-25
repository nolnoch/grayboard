// End-to-end over real local-mode processes: each session is a separate
// `grayboard mcp --mode local` driven by an MCP client, sharing a temp database
// and socket directory. Covers liveness in `who`, which only works across processes.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { localBusDir, sha256Hex } from "../../src/shared/attachments.ts";
import { runCli } from "../support/cli.ts";
import { localEnv } from "../support/env.ts";
import { call, closeSessions, localSession, stopSession as stop, type Session } from "../support/mcp.ts";
import { until } from "../support/until.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grayboard-local-"));
});

afterEach(async () => {
  await closeSessions();
  rmSync(dir, { recursive: true, force: true });
});

// Local-mode env for a session in `dir`; no credentials file, so `grayboard mcp` picks local.
function busEnv(identity?: string, lane?: string): Record<string, string> {
  const env = { ...process.env, BUS_DB_PATH: join(dir, "bus.db"), BUS_SOCK_DIR: dir, GRAYBOARD_CREDENTIALS: join(dir, "credentials") };
  delete env.BUS_IDENTITY;
  delete env.BUS_LANE;
  delete env.GRAYBOARD_TOKEN;
  return { ...env, ...(identity ? { BUS_IDENTITY: identity } : {}), ...(lane ? { BUS_LANE: lane } : {}) } as Record<string, string>;
}

const session = (identity: string | undefined, cwd = dir, args?: string[]): Promise<Session> => localSession(dir, identity, { cwd, args });

async function start(identity: string | undefined, cwd = dir, args?: string[]): Promise<Client> {
  return (await session(identity, cwd, args)).c;
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r = await c.callTool({ name, arguments: args });
  const body = (r.content as { text: string }[])[0]!.text;
  if (r.isError) throw new Error(body);
  try {
    return JSON.parse(body);
  } catch {
    return body; // e.g. board_subscribe's "ok: ..."
  }
}

const contents = (s: Session) => s.pushes.map((p) => p.content);

test("who: live sessions are online; a stopped one is offline with last_seen", async () => {
  const be = await start("be");
  const sim = await start("sim");
  const tmp = await start("tmp");
  const before = Date.now();
  await stop(tmp);

  const online = await call(sim, "peer_list");
  expect(online.you).toBe("sim");
  expect(online.peers.map((p: any) => p.handle)).toEqual(["be", "sim"]);
  expect(online.offline_hidden).toBe(1);

  const all = await call(sim, "peer_list", { include_offline: true });
  const gone = all.peers.find((p: any) => p.handle === "tmp");
  expect(gone.online).toBe(false);
  expect(gone.last_seen).toBeGreaterThanOrEqual(before);

  await call(be, "board_create", { name: "e2e", purpose: "fixtures" });
  await call(sim, "board_subscribe", { board: "e2e", mode: "quiet" });
  expect((await call(sim, "peer_list", { board: "#e2e" })).peers).toEqual([
    { handle: "be", online: true, last_seen: expect.any(Number), mode: "push", where: expect.any(String) },
    { handle: "sim", online: true, last_seen: expect.any(Number), self: true, mode: "quiet", where: expect.any(String) },
  ]);
}, 20_000);

test("a worktree session's handle follows the explicit-identity rule, the worktree as its lane", async () => {
  const wt = join(dir, "repo", ".wt", "stream");
  mkdirSync(join(dir, "repo", ".git", "worktrees"), { recursive: true });
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, ".git"), `gitdir: ${join(dir, "repo", ".git", "worktrees", "stream")}\n`);

  // An explicit BUS_IDENTITY is literal: no worktree suffix — the worktree
  // is the session's lane, not a look-alike handle.
  const main = await start("be", join(dir, "repo"));
  const sim = await start("sim", wt);
  expect((await call(sim, "peer_list")).you).toBe("sim");
  expect((await call(main, "peer_list")).peers.map((p: any) => p.handle)).toEqual(["be", "sim"]);

  // A BUS_IDENTITY that re-delivers the repo's pin is derived, not explicit:
  // the session starts unbound (#182), with the derived worktree name
  // ("be-stream", the suffix composes) first among its candidates. The pin
  // lives in the main checkout; the worktree session resolves it through
  // the repo.
  writeFileSync(join(dir, "repo", ".mcp.json"), JSON.stringify({ mcpServers: { grayboard: { env: { BUS_IDENTITY: "be" } } } }));
  const stream = await start("be", wt);
  expect(stream.getInstructions()).toContain('Candidates (free now): be-stream (this checkout\'s default:');
  expect((await call(stream, "peer_list")).you).toBeUndefined();
  await call(stream, "bind", { name: "be-stream", create: true });
  expect((await call(stream, "peer_list")).you).toBe("be-stream");
  expect((await call(main, "peer_list")).peers.map((p: any) => p.handle)).toEqual(["be", "be-stream", "sim"]);
}, 20_000);

test("an explicit identity is lowercased, the server's rule (#181); an invalid one refuses startup", async () => {
  // The server lowercases and validates at hello; local now does at startup,
  // so one configuration yields one handle in both modes (#181).
  const upper = await start("Gray");
  expect((await call(upper, "peer_list")).you).toBe("gray");

  // A name invalid after lowercasing refuses to start, with the reason.
  await expect(session("Gray!")).rejects.toThrow(/invalid identity name/);
}, 20_000);

test("two worktree sessions with one user-scope BUS_IDENTITY collide loudly", async () => {
  // No repo pin: a BUS_IDENTITY from a user-level registration (claude mcp
  // add -e, pi's user mcp.json) is a chosen task name, literal in every
  // worktree. Both sessions resolve to "task": the second starts unbound,
  // its instructions name the holder, and the first keeps the name (one
  // live session per handle; #182).
  const repo = join(dir, "repo2");
  mkdirSync(join(repo, ".git", "worktrees"), { recursive: true });
  for (const wt of ["alpha", "beta"]) {
    const path = join(repo, ".wt", wt);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, ".git"), `gitdir: ${join(repo, ".git", "worktrees", wt)}\n`);
  }

  const first = await start("task", join(repo, ".wt", "alpha"));
  expect((await call(first, "peer_list")).you).toBe("task");
  const second = await start("task", join(repo, ".wt", "beta"));
  expect(second.getInstructions()).toContain('BUS_IDENTITY asked for "task", but');
  expect((await call(second, "peer_list")).you).toBeUndefined();
  const refused = await second.callTool({ name: "bind", arguments: { name: "task" } });
  expect(refused.isError).toBe(true);
  // The first session still owns the name and answers calls.
  expect((await call(first, "peer_list")).you).toBe("task");


test("lanes of one identity run side by side; each DM is delivered exactly once across the fleet, never fanned out", async () => {
  const a = await startCollecting("be", "research");
  const sim = await start("sim");
  await call(sim, "dm_send", { to: "be", body: "first" });
  await Bun.sleep(300);
  expect(a.pushes).toEqual(["first"]);
  // A lane that joins (or drains) after a sibling handled the message starts
  // from the identity's read point: one DM, one agent acting on it.
  const b = await startCollecting("be", "scratch");
  await Bun.sleep(300);
  expect(b.pushes).toEqual([]);
  // A later drain of the fleet (peer_list probes — and so wakes — every
  // socket) re-delivers nothing the identity has already read.
  await call(sim, "peer_list");
  await Bun.sleep(300);
  expect(a.pushes).toEqual(["first"]);
  expect(b.pushes).toEqual([]);
  // New messages with both lanes live and racing on the same poke: the
  // delivery claim is atomic (dm_claims), so every message is delivered
  // EXACTLY once — toBe(1), not toBeGreaterThanOrEqual(1).
  {
    // The first send is the deterministic fleet-truth case: both lanes are
    // caught up past the sender's previous message to the recipient (a
    // because it read it, b because its startup seeding synced to the read
    // point).
    const r = await call(sim, "dm_send", { to: "be", body: "second" });
    expect(r.live_lanes).toBe(2);
    expect(r.read_lanes.sort()).toEqual(["research", "scratch"]);
    await Bun.sleep(250);
  }
  // Later sends: whoever claimed the previous message is the lane caught up
  // past it — membership is claim-race-dependent, so pin the invariants:
  // two live lanes, and at least the previous claimer caught up.
  for (const body of ["third", "fourth"]) {
    const r = await call(sim, "dm_send", { to: "be", body });
    expect(r.live_lanes).toBe(2);
    expect(r.read_lanes.length).toBeGreaterThanOrEqual(1);
    await Bun.sleep(250);
  }
  const count = (x: string) => [...a.pushes, ...b.pushes].filter((p) => p === x).length;
  expect(count("second")).toBe(1);
  expect(count("third")).toBe(1);
  expect(count("fourth")).toBe(1);
  // And a later fleet-wide drain re-delivers nothing.
  await call(sim, "peer_list");
  await Bun.sleep(300);
  expect(count("second")).toBe(1);
  expect(count("third")).toBe(1);
  expect(count("fourth")).toBe(1);
  // A reply from the fleet no longer hides the sender's read state (N4):
  // "the pair's previous message" is the previous one ADDRESSED TO the
  // recipient — the recipient's own reply sits above its receive cursor
  // forever, so a bidirectional compare would always hide read_lanes after
  // the first back-and-forth (the common case).
  await call(a.c, "dm_send", { to: "sim", body: "be replies" });
  await Bun.sleep(250);
  const fifth = await call(sim, "dm_send", { to: "be", body: "fifth" });
  expect(fifth.live_lanes).toBe(2);
  expect((fifth.read_lanes ?? []).length).toBeGreaterThanOrEqual(1);
}, 20_000);

test("a DM claim stuck by a crashed lane is taken over once it expires", async () => {
  const sim = await start("sim");
  // be connected once (so the roster accepts it) and left; its mail queues.
  const be = await start("be");
  await stop(be);
  const r = await call(sim, "dm_send", { to: "be", body: "stuck" });
  expect(r.delivered_now).toBe(false);
  // A claim from a lane that crashed between claiming and delivering, held
  // past the TTL: the row says someone owns it, but nobody is coming.
  const { openLocalDb } = await import("../../src/local/open.ts");
  const { DM_CLAIM_TTL_MS } = await import("../../src/local/db.ts");
  const db = openLocalDb(join(dir, "bus.db"));
  db.prepare(`INSERT INTO dm_claims (message_id, claimer, claimed_at) VALUES (?, 'be#ghost', ?)`)
    .run(r.message_id, Date.now() - DM_CLAIM_TTL_MS - 1_000);
  db.close();

  // The next session's startup drain takes the expired claim over and
  // delivers the message (at-least-once at the claim level: a message a
  // dead claimer held is never lost).
  const again = await startCollecting("be", "research");
  await Bun.sleep(300);
  expect(again.pushes).toEqual(["stuck"]);
}, 20_000);

test("a claimer that dies mid-handle never loses the DM: the read point holds until takeover (D1)", async () => {
  const sim = await start("sim");
  const be = await start("be");
  await stop(be);
  const stuck = await call(sim, "dm_send", { to: "be", body: "stuck" });
  expect(stuck.delivered_now).toBe(false);
  // A FRESH claim (well inside the TTL) by a lane that dies between claiming
  // and delivering — the reviewer's crash window.
  const { openLocalDb } = await import("../../src/local/open.ts");
  const { DM_CLAIM_TTL_MS } = await import("../../src/local/db.ts");
  const db1 = openLocalDb(join(dir, "bus.db"));
  db1.prepare(`INSERT INTO dm_claims (message_id, claimer, claimed_at) VALUES (?, 'be#ghost', ?)`)
    .run(stuck.message_id, Date.now());
  db1.close();

  // A live sibling lane delivers a LATER message: the loser of the old
  // world synced past the stuck claim and lost it; the read point must hold.
  const live = await startCollecting("be", "live");
  await Bun.sleep(300); // startup drain: "stuck" is skipped (a live claim holds it)
  expect(live.pushes).toEqual([]);
  await call(sim, "dm_send", { to: "be", body: "later" });
  await Bun.sleep(300);
  expect(live.pushes).toEqual(["later"]);
  // Sender truth: "stuck" is undelivered (no agent received it), "later" is
  // delivered (its marker), even while the live lane's cursor is held back.
  const hist = await call(sim, "dm_history", { peer: "be", limit: 10 });
  const byBody = Object.fromEntries(hist.filter((m: any) => m.delivered !== undefined).map((m: any) => [m.body, m.delivered]));
  expect(byBody).toMatchObject({ stuck: false, later: true });

  // The claim ages past its TTL (injected); the next poke's drain takes it
  // over: "stuck" is delivered exactly once — never lost, never duplicated.
  const db2 = openLocalDb(join(dir, "bus.db"));
  db2.prepare(`UPDATE dm_claims SET claimed_at = ? WHERE message_id = ?`)
    .run(Date.now() - DM_CLAIM_TTL_MS - 1_000, stuck.message_id);
  db2.close();
  await call(sim, "dm_send", { to: "be", body: "after-ttl" });
  await Bun.sleep(300);
  expect(live.pushes).toEqual(["later", "stuck", "after-ttl"]);

  // A same-lane restart reclaims its OWN stuck claim immediately: its own
  // message is not stranded behind a sibling's TTL window.
  await stop(live.c);
  const own = await call(sim, "dm_send", { to: "be", body: "own" });
  expect(own.delivered_now).toBe(false);
  const db3 = openLocalDb(join(dir, "bus.db"));
  db3.prepare(`INSERT INTO dm_claims (message_id, claimer, claimed_at) VALUES (?, 'be#restarted', ?)`)
    .run(own.message_id, Date.now()); // fresh, well inside the TTL
  db3.close();
  const restarted = await startCollecting("be", "restarted");
  await Bun.sleep(300);
  expect(restarted.pushes).toEqual(["own"]);
}, 30_000);

test("the lane that loses the claim race is not woken by deferred items alone (D2)", async () => {
  // 24 trials: a fresh deferred thread reply, then a DM that pokes both
  // lanes. The DM's claim race has exactly one winner; the LOSER must not
  // deliver the deferred board item — deferred pushes and digests never
  // wake a session on their own, and a sibling's claim is not this lane's
  // wake. (Race-dependent, hence the loop: the bug fired in 3 of the
  // reviewer's 12 trials; the aggregate count below catches double-pushes
  // the per-trial checks can miss.)
  const a = await startCollecting("sim", "research");
  const b = await startCollecting("sim", "scratch");
  const be = await start("be");
  const fe = await start("fe");
  await call(be, "board_create", { name: "ops-race", purpose: "x" });
  const root = await call(be, "board_post", { board: "ops-race", body: "root" });
  await call(a.c, "board_post", { board: "ops-race", body: "sim chimes in", parent_id: root.post_id });
  const mid = await call(fe, "board_post", { board: "ops-race", body: "fe asks", parent_id: root.post_id });
  for (let i = 0; i < 24; i++) {
    const aBefore = a.pushes.length, bBefore = b.pushes.length;
    const reply = await call(be, "board_post", { board: "ops-race", body: `answer ${i}`, parent_id: mid.post_id });
    expect(reply.deferred).toContain("sim");
    await call(fe, "dm_send", { to: "sim", body: `dm ${i}` });
    await Bun.sleep(300);
    const aDelta = a.pushes.slice(aBefore), bDelta = b.pushes.slice(bBefore);
    // Exactly one lane delivers the DM.
    const dmCount = (d: string[]) => d.includes(`dm ${i}`);
    expect((dmCount(aDelta) ? 1 : 0) + (dmCount(bDelta) ? 1 : 0)).toBe(1);
    // The deferred reply rides along with the WINNER's drain only: a lane
    // that pushed the board item must be the lane that pushed the DM. The
    // loser delivering it alone was the round-4 bug (3 of 12 trials).
    for (const d of [aDelta, bDelta]) {
      if (d.includes(`answer ${i}`)) expect(d.includes(`dm ${i}`)).toBe(true);
    }
  }
  // Aggregate: every answer pushed at most once across the fleet — a
  // double-push (both lanes fetched it before either marked it delivered)
  // is the same bug in its other shape.
  expect([...a.pushes, ...b.pushes].filter((p) => p.startsWith("answer")).length).toBeLessThanOrEqual(24);
}, 45_000);

test("prune keeps delivered markers above a stuck claim; only the read point's own markers go (round-6 item 1)", async () => {
  // A stuck undelivered claim holds the read point below itself; delivered
  // markers ABOVE it must survive any age, or the lane that later takes the
  // stuck claim over re-delivers them (the reviewer's 24h repro). Markers at
  // or below the read point are unreachable by any future scan (every drain
  // syncs its cursor to the read point first), so aging them out is safe.
  // Prune runs inside the sessions (a drain's sweep); rows are asserted on
  // the database directly. Aged markers are aged past DM_CLAIM_RETENTION_MS.
  const sim = await start("sim");
  const be = await start("be");
  await stop(be);
  const stuck = await call(sim, "dm_send", { to: "be", body: "stuck" });    // N
  const above1 = await call(sim, "dm_send", { to: "be", body: "above-1" }); // N+1
  const above2 = await call(sim, "dm_send", { to: "be", body: "above-2" }); // N+2
  const { openLocalDb } = await import("../../src/local/open.ts");
  const { DM_CLAIM_RETENTION_MS } = await import("../../src/local/db.ts");
  const db = openLocalDb(join(dir, "bus.db"));
  const now = Date.now();
  const aged = now - DM_CLAIM_RETENTION_MS - 1_000;
  const marker = (id: number) =>
    db.prepare(`INSERT OR REPLACE INTO dm_claims (message_id, claimer, claimed_at, delivered_at) VALUES (?, 'be#marker', ?, ?)`)
      .run(id, aged, aged);
  marker(above1.message_id);
  marker(above2.message_id);
  // A FRESH undelivered claim on N: the read point clamps below it even
  // though the recipient's cursor row reads past N+2.
  db.prepare(`INSERT OR REPLACE INTO dm_claims (message_id, claimer, claimed_at) VALUES (?, 'be#ghost', ?)`)
    .run(stuck.message_id, now - 1_000);
  db.prepare(`INSERT OR REPLACE INTO cursors (reader, last_seen_id) VALUES ('be', ?)`).run(above2.message_id);
  // A draining session runs pruneDmClaims (its sweep): everything for 'be'
  // sits above the clamped read point, so all of it survives any age.
  await start("fe");
  await Bun.sleep(300);
  const present = (id: number) => !!db.prepare(`SELECT 1 FROM dm_claims WHERE message_id = ?`).get(id);
  expect(present(stuck.message_id)).toBe(true);
  expect(present(above1.message_id)).toBe(true);
  expect(present(above2.message_id)).toBe(true);
  // Deliver the stuck claim and age its row: the read point releases past
  // N+2, every marker is now at-or-below it and aged — the next drain's
  // prune takes them all.
  db.prepare(`UPDATE dm_claims SET delivered_at = ?, claimed_at = ? WHERE message_id = ?`).run(now, aged, stuck.message_id);
  await call(sim, "peer_list"); // pokes every handle: fe drains, prune runs
  await Bun.sleep(300);
  expect(present(stuck.message_id)).toBe(false);
  expect(present(above1.message_id)).toBe(false);
  expect(present(above2.message_id)).toBe(false);
  db.close();
}, 20_000);

test("a skipped live claim arms its own TTL retry: a crashed claimer's DM delivers with no other wake (round-6 item 2)", async () => {
  const sim = await start("sim");
  const be = await start("be");
  await stop(be);
  const stuck = await call(sim, "dm_send", { to: "be", body: "ttl-armed" });
  expect(stuck.delivered_now).toBe(false);
  // A ghost claim with a generous remaining TTL (~2.5 s): a live lane's
  // drain skips it and must arm the retry itself — no further send or poke
  // happens in this test, so only the armed timer can deliver the message.
  const { openLocalDb } = await import("../../src/local/open.ts");
  const { DM_CLAIM_TTL_MS } = await import("../../src/local/db.ts");
  const db = openLocalDb(join(dir, "bus.db"));
  db.prepare(`INSERT INTO dm_claims (message_id, claimer, claimed_at) VALUES (?, 'be#ghost', ?)`)
    .run(stuck.message_id, Date.now() - DM_CLAIM_TTL_MS + 2_500);
  db.close();
  // The startup drain skips the live claim (nothing delivered, no board
  // items) and arms the retry for the remaining TTL.
  const live = await startCollecting("be", "research");
  await Bun.sleep(300);
  expect(live.pushes).toEqual([]);
  // No traffic of any kind: the armed timer fires past the TTL, the drain
  // takes the expired claim over, and the message delivers exactly once.
  await Bun.sleep(3_500);
  expect(live.pushes).toEqual(["ttl-armed"]);
}, 20_000);

test("a first skip whose tail spans the claim's expiry still arms the takeover: no poke, no wake (round-8 N1 residual)", async () => {
  const sim = await start("sim");
  const be = await start("be");
  await stop(be);
  const stuck = await call(sim, "dm_send", { to: "be", body: "first-skip" });
  expect(stuck.delivered_now).toBe(false);
  // The maintainer's repro from the round-7 review, merged with an early
  // no-premature-delivery assert: a ghost claim with ~1.5 s of remaining
  // TTL; the live lane's startup drain skips it for the FIRST time —
  // nothing is armed yet — and its 3 s test-injected tail spans the expiry
  // (~1.5 s). No poke arrives (the round-7 pin had one: the poke's drain
  // request set the rerun flag and its pass took the claim over). Here
  // nobody requests anything: the drain's own expiry check is the only
  // chance to arm. With nextClaimExpiry filtering expired claims it read
  // null and armed nothing — at 5aa346d this repro failed with [] after
  // 8 s. The fix drops the filter, so the expired claim arms an immediate
  // retry and the message delivers with zero external requests.
  const { openLocalDb } = await import("../../src/local/open.ts");
  const { DM_CLAIM_TTL_MS } = await import("../../src/local/db.ts");
  const db = openLocalDb(join(dir, "bus.db"));
  db.prepare(`INSERT INTO dm_claims (message_id, claimer, claimed_at) VALUES (?, 'be#ghost', ?)`)
    .run(stuck.message_id, Date.now() - DM_CLAIM_TTL_MS + 1_500);
  db.close();
  process.env.BUS_TEST_DRAIN_TAIL_MS = "3000";
  try {
    const live = await startCollecting("be", "research");
    // The startup drain: skip (batch empty), then the 3 s tail. No traffic
    // of any kind after this point — only an armed timer can deliver.
    await Bun.sleep(500);
    expect(live.pushes).toEqual([]);
    await Bun.sleep(7_500);
    expect(live.pushes).toEqual(["first-skip"]);
  } finally {
    delete process.env.BUS_TEST_DRAIN_TAIL_MS;
  }
}, 20_000);

test("nextClaimExpiry: an expired undelivered claim is pending, not gone — null means nothing undelivered (round-8 N1)", async () => {
  // A check landing between a claim's expiry and its armed timer must not
  // read the claim as gone: with the old `claimed_at > now - ttl` filter it
  // read null and cleared the armed retry. The claimed row is the pending
  // signal now; the caller clamps the (possibly past) moment to >= 0. Bound
  // to this test's DB by importing the module fresh with BUS_DB_PATH set.
  const sim = await start("sim");
  const be = await start("be");
  await stop(be);
  const expired = await call(sim, "dm_send", { to: "be", body: "expired-pending" });
  const live = await call(sim, "dm_send", { to: "be", body: "live-pending" });
  const done = await call(sim, "dm_send", { to: "be", body: "delivered-only" });
  const { openLocalDb } = await import("../../src/local/open.ts");
  const w = openLocalDb(join(dir, "bus.db"));
  const { DM_CLAIM_TTL_MS } = await import("../../src/local/db.ts");
  const now = Date.now();
  w.prepare(`INSERT INTO dm_claims (message_id, claimer, claimed_at) VALUES (?, 'be#ghost', ?)`)
    .run(expired.message_id, now - DM_CLAIM_TTL_MS - 100); // expired 100 ms ago
  w.prepare(`INSERT INTO dm_claims (message_id, claimer, claimed_at) VALUES (?, 'be#holder', ?)`)
    .run(live.message_id, now - DM_CLAIM_TTL_MS + 5_000); // live, 5 s remaining
  w.prepare(`INSERT INTO dm_claims (message_id, claimer, claimed_at, delivered_at) VALUES (?, 'be#gone', ?, ?)`)
    .run(done.message_id, now - DM_CLAIM_TTL_MS - 100, now); // delivered: never pending
  const prevDbPath = process.env.BUS_DB_PATH;
  process.env.BUS_DB_PATH = join(dir, "bus.db");
  try {
    const mod = await import(`../../src/local/db.ts?pinb-${Date.now()}`);
    // The expired claim is the oldest pending: its (past) expiry moment,
    // not null — the value a check in the arm window must still see.
    expect(mod.nextClaimExpiry("be")).toBe(now - DM_CLAIM_TTL_MS - 100 + DM_CLAIM_TTL_MS);
    // Only the live claim pending: its future expiry moment.
    w.prepare(`UPDATE dm_claims SET delivered_at = ? WHERE message_id = ?`).run(Date.now(), expired.message_id);
    expect(mod.nextClaimExpiry("be")).toBe(now - DM_CLAIM_TTL_MS + 5_000 + DM_CLAIM_TTL_MS);
    // Nothing undelivered: null — and only then is clearing an arm safe.
    w.prepare(`UPDATE dm_claims SET delivered_at = ? WHERE message_id = ?`).run(Date.now(), live.message_id);
    expect(mod.nextClaimExpiry("be")).toBeNull();
  } finally {
    if (prevDbPath === undefined) delete process.env.BUS_DB_PATH;
    else process.env.BUS_DB_PATH = prevDbPath;
    w.close();
  }
}, 10_000);

test("an immediate-retry-armed drain skips a live claim and takes it over only at expiry (round-8 N1, live-claimer invariant)", async () => {
  // The clamp arms retries at once for expired claims; the invariant the
  // old filter half-served is that a claim WITHIN its TTL is never taken
  // over — no double-claiming while the original claimer is alive. A drain
  // that delivers an expired claim arms for the live one's expiry; the
  // armed retry fires past that expiry and only then takes it over.
  const sim = await start("sim");
  const be = await start("be");
  await stop(be);
  const expired = await call(sim, "dm_send", { to: "be", body: "expired-now" });
  const held = await call(sim, "dm_send", { to: "be", body: "held-live" });
  const { openLocalDb } = await import("../../src/local/open.ts");
  const { DM_CLAIM_TTL_MS } = await import("../../src/local/db.ts");
  const now = Date.now();
  const w = openLocalDb(join(dir, "bus.db"));
  // Expired 100 ms ago: the startup drain takes it over at once.
  w.prepare(`INSERT INTO dm_claims (message_id, claimer, claimed_at) VALUES (?, 'be#ghost', ?)`)
    .run(expired.message_id, now - DM_CLAIM_TTL_MS - 100);
  // Live with ~1.5 s of TTL left at insert: within TTL at the drain's scan
  // (~300 ms in), so the drain must SKIP it — the claimer 'be#holder' is
  // alive by TTL's definition — and arm for its expiry instead.
  w.prepare(`INSERT INTO dm_claims (message_id, claimer, claimed_at) VALUES (?, 'be#holder', ?)`)
    .run(held.message_id, now - DM_CLAIM_TTL_MS + 1_500);
  w.close();
  const other = await startCollecting("be", "research");
  // First pass: the expired claim delivered, the live claim suppressed —
  // the immediate-retry arming must not steamroll a within-TTL claim.
  await Bun.sleep(600);
  expect(other.pushes).toEqual(["expired-now"]);
  // The armed retry fires past the held claim's expiry (~1.2 s out from
  // the scan) and takes it over: delivered exactly once, by the timer.
  await Bun.sleep(3_000);
  expect(other.pushes).toEqual(["expired-now", "held-live"]);
}, 15_000);

test("a drain whose tail spans the claim's expiry reruns instead of losing the retry (round-7 N1)", async () => {
  const sim = await start("sim");
  const be = await start("be");
  await stop(be);
  const stuck = await call(sim, "dm_send", { to: "be", body: "tail-span" });
  expect(stuck.delivered_now).toBe(false);
  // A ghost claim with ~1 s of remaining TTL: the live lane's drain skips
  // it and arms the retry. A poke 300 ms before expiry starts its own
  // drain, whose test-injected tail (BUS_TEST_DRAIN_TAIL_MS) spans the
  // expiry — the armed timer fires mid-drain and bails on `draining`. The
  // drain's own expiry check then sees the claim expired
  // (nextClaimExpiry filters claimed_at > now - ttl) and returns null:
  // without the rerun flag nothing re-arms and the message is lost — the
  // reviewer's widened-window repro.
  const { openLocalDb } = await import("../../src/local/open.ts");
  const { DM_CLAIM_TTL_MS } = await import("../../src/local/db.ts");
  const db = openLocalDb(join(dir, "bus.db"));
  db.prepare(`INSERT INTO dm_claims (message_id, claimer, claimed_at) VALUES (?, 'be#ghost', ?)`)
    .run(stuck.message_id, Date.now() - DM_CLAIM_TTL_MS + 1_000);
  db.close();
  process.env.BUS_TEST_DRAIN_TAIL_MS = "600";
  try {
    const live = await startCollecting("be", "research");
    // The startup drain skips the live claim and arms the retry for the
    // remaining TTL (~1 s from the insert, ~300 ms spent on startup).
    await Bun.sleep(700);
    await call(sim, "dm_send", { to: "be", body: "poke" });
    // Past the expiry, the timer's bail on `draining`, the tail, and the
    // rerun pass: the poke delivered, the expired claim taken over —
    // each exactly once.
    await Bun.sleep(2_500);
    expect(live.pushes).toEqual(["poke", "tail-span"]);
  } finally {
    delete process.env.BUS_TEST_DRAIN_TAIL_MS;
  }
}, 20_000);

test("the pending-claim queries drive from dm_claims through the partial index (round-7 item 6)", async () => {
  // EXPLAIN the exported constants the code executes — not a hand copy.
  // A plain JOIN lets the planner drive from messages (a scan of the
  // recipient's whole history, ~5 ms at 100k messages); CROSS JOIN pins
  // dm_claims outer so idx_dm_claims_pending bounds the clamp by the
  // number of stuck claims. Reverting any CROSS JOIN fails this pin.
  const { openLocalDb } = await import("../../src/local/open.ts");
  const {
    READ_POINT_SQL, UNDELIVERED_BELOW_SQL, NEXT_EXPIRY_SQL, PRUNE_DISTINCT_SQL,
  } = await import("../../src/local/db.ts");
  const db = openLocalDb(join(dir, "explain.db"));
  const detail = (sql: string, ...params: unknown[]) =>
    (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[])
      .map((r) => r.detail).join(" | ");
  for (const [sql, params] of [
    [READ_POINT_SQL, ["be"]],
    [UNDELIVERED_BELOW_SQL, ["be", 5]],
    [NEXT_EXPIRY_SQL, ["be"]], // one bind: the filter is gone, the row is the signal (round-8 N1)
  ] as const) {
    const d = detail(sql, ...params);
    expect(d).toContain("SEARCH cl USING INDEX idx_dm_claims_pending");
    expect(d).toContain("SEARCH m USING INTEGER PRIMARY KEY");
    expect(d).not.toContain("SCAN m");
  }
  // The prune scans dm_claims (small: markers) and probes messages by
  // rowid — never a scan of the recipient's message history.
  const prune = detail(PRUNE_DISTINCT_SQL, Date.now());
  expect(prune).toContain("SCAN d");
  expect(prune).toContain("SEARCH m USING INTEGER PRIMARY KEY");
  expect(prune).not.toContain("SCAN m");
  db.close();
}, 20_000);

test("a pre-delivered_at dm_claims row is backfilled as delivered, not clamped forever (round-6 item 3)", async () => {
  // A round-4-shaped database: dm_claims without the delivered_at column.
  // The guarded ALTER adds it; the same branch backfills every row as
  // delivered (claimed_at), or they read as undelivered forever, clamping
  // the read point below themselves and re-delivering on takeover.
  const { Database } = await import("bun:sqlite");
  const old = new Database(join(dir, "bus.db"));
  old.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT NOT NULL, recipient TEXT NOT NULL,
              body TEXT NOT NULL, parent_id INTEGER, created_at INTEGER NOT NULL);
            CREATE TABLE cursors (reader TEXT PRIMARY KEY, last_seen_id INTEGER NOT NULL);
            CREATE TABLE dm_claims (message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
              claimer TEXT NOT NULL, claimed_at INTEGER NOT NULL);
            INSERT INTO messages (sender, recipient, body, created_at) VALUES ('sim', 'be', 'old-claim', 1);
            INSERT INTO dm_claims (message_id, claimer, claimed_at) VALUES (1, 'be#ghost', 1111);`);
  old.close();
  const be = await startCollecting("be", "research");
  await Bun.sleep(300);
  // Backfilled as delivered: no re-delivery at startup…
  expect(be.pushes).toEqual([]);
  // …and no clamp: the row carries delivered_at = claimed_at.
  const { openLocalDb } = await import("../../src/local/open.ts");
  const db = openLocalDb(join(dir, "bus.db"));
  const row = db.prepare(`SELECT delivered_at FROM dm_claims WHERE message_id = 1`).get() as { delivered_at: number };
  expect(row.delivered_at).toBe(1111);
  db.close();
}, 20_000);

test("a second session on a live lane fails loudly instead of shadowing it", async () => {
  const first = await start("be", dir, [CLI, "mcp", "--mode", "local"], "research");
  const p = Bun.spawn([process.execPath, CLI, "mcp", "--mode", "local"], {
    cwd: dir, env: busEnv("be", "research"), stdin: "ignore", stderr: "pipe",
  });
  expect(await p.exited).toBe(1);
  expect(await new Response(p.stderr).text()).toContain("already in use");
  // The first session keeps its lane.
  expect((await call(first, "peer_list")).you).toBe("be");
}, 20_000);

test("a crashed lane's row is swept lazily by the next draining session", async () => {
  const be = await start("be");
  const sim = await start("sim");
  // A lane row past its grace window, with a socket file nothing answers: a
  // session that crashed and left both behind (local mode has no close event).
  const { openLocalDb } = await import("../../src/local/open.ts");
  const db = openLocalDb(join(dir, "bus.db"));
  const stale = Date.now() - 120_000;
  db.prepare(
    `INSERT INTO lanes (handle, lane, kind, cwd, push_capable, first_seen, last_seen) VALUES ('be', 'crashed', 'session', NULL, 1, ?, ?)`,
  ).run(stale, stale);
  db.close();
  writeFileSync(join(dir, "sock.be.crashed"), "");

  // Any drain — this DM wakes be's session — sweeps the dead lane's row.
  await call(sim, "dm_send", { to: "be", body: "nudge" });
  await Bun.sleep(400);
  const db2 = openLocalDb(join(dir, "bus.db"));
  const rows = db2.prepare(`SELECT lane FROM lanes WHERE handle = 'be' ORDER BY lane`).all() as { lane: string }[];
  db2.close();
  expect(rows.map((r) => r.lane)).toEqual(["main"]);
  void be;
}, 20_000);

test("a bridge lane's row is sticky: the lazy sweep leaves it alone", async () => {
  const be = await start("be");
  const sim = await start("sim");
  // A bridge lane (the human's reachability rides on it) whose process died
  // long ago: kind "bridge" is exempt from the sweep, unlike "session" rows.
  const { openLocalDb } = await import("../../src/local/open.ts");
  const db = openLocalDb(join(dir, "bus.db"));
  const stale = Date.now() - 120_000;
  db.prepare(
    `INSERT INTO lanes (handle, lane, kind, cwd, push_capable, first_seen, last_seen) VALUES ('be', 'slackbridge', 'bridge', NULL, 1, ?, ?)`,
  ).run(stale, stale);
  db.close();
  writeFileSync(join(dir, "sock.be.slackbridge"), "");

  // A drain (this DM wakes be's session) sweeps stale session rows only.
  await call(sim, "dm_send", { to: "be", body: "nudge" });
  await Bun.sleep(400);
  const db2 = openLocalDb(join(dir, "bus.db"));
  const rows2 = db2.prepare(`SELECT lane, kind FROM lanes WHERE handle = 'be' ORDER BY lane`).all() as { lane: string; kind: string }[];
  db2.close();
  expect(rows2).toEqual([
    { lane: "main", kind: "session" },
    { lane: "slackbridge", kind: "bridge" },
  ]);
  void be;
}, 20_000);

test("a stale lane socket file from a crash is taken over, not a lockout", async () => {
  // Bind-first: the path exists but nothing answers, so it's a stale file
  // from a crashed session — cleared and rebound, never a live holder's.
  // The proof the lane really holds it: a DM wakes and reaches it.
  writeFileSync(join(dir, "sock.be.rescue"), "");
  const be = await startCollecting("be", "rescue");
  const sim = await start("sim");
  await call(sim, "dm_send", { to: "be", body: "anyone there?" });
  await Bun.sleep(300);
  expect(be.pushes).toContain("anyone there?");
||||||| 07c76bb
  expect((await call(stream, "peer_list")).you).toBe("be-stream");
  expect((await call(main, "peer_list")).peers.map((p: any) => p.handle)).toEqual(["be", "be-stream"]);
}, 20_000);

test("grayboard mcp: local mode when signed out, named after the repo", async () => {
  const repo = join(dir, "api");
  mkdirSync(join(repo, ".git"), { recursive: true });
  // No BUS_IDENTITY: unbound, the repo's name its first candidate (#182).
  const api = await start(undefined, repo, ["mcp"]);
  const be = await start("be", dir, ["mcp"]);
  // api has never existed: the candidate says binding it needs create.
  expect(api.getInstructions()).toContain("Candidates (free now): api (this checkout's default: new: bind with create: true)");
  await call(api, "bind", { name: "api", create: true });
  expect((await call(api, "peer_list")).you).toBe("api");
  expect((await call(be, "peer_list")).peers.map((p: any) => p.handle)).toEqual(["api", "be"]);
}, 20_000);

test("grayboard mcp: a signed-out credentials file fails instead of falling back to local", async () => {
  writeFileSync(join(dir, "credentials"), "");
  const r = await runCli(["mcp"], { cwd: dir, env: busEnv("be") });
  expect(r.code).toBe(1);
  expect(r.err).toContain("signed out");
}, 20_000);

test("grayboard mcp --mode local overrides a signed-in credentials file", async () => {
  writeFileSync(join(dir, "credentials"), JSON.stringify({ session_token: "x", server: "http://127.0.0.1:9", user_email: "a@b.c" }));
  const be = await start("be");
  expect((await call(be, "peer_list")).you).toBe("be");
}, 20_000);

test("dm_send to a handle that never connected is an error, not a silent queue", async () => {
  const be = await start("be");
  await expect(call(be, "dm_send", { to: "backend", body: "hi" })).rejects.toThrow(/peer_list/);
  await start("fe");
  expect((await call(be, "dm_send", { to: "fe", body: "hi" })).delivered_now).toBe(true);
}, 20_000);

test("dm_thread from any message returns the whole thread; pushes carry parent_id", async () => {
  const be = await start("be");
  const { c: fe, pushes } = await session("fe");
  const root = await call(be, "dm_send", { to: "fe", body: "q" });
  const reply = await call(fe, "dm_send", { to: "be", body: "a", parent_id: root.message_id });
  const leaf = await call(be, "dm_send", { to: "fe", body: "thanks", parent_id: reply.message_id });
  const thread = await call(fe, "dm_thread", { thread: leaf.message_id });
  expect(thread.map((m: any) => m.id)).toEqual([root.message_id, reply.message_id, leaf.message_id]);
  const sim = await start("sim");
  await expect(call(sim, "dm_thread", { thread: root.message_id })).rejects.toThrow(/not found/);
  await expect(call(sim, "dm_send", { to: "be", body: "x", parent_id: root.message_id })).rejects.toThrow(/not a message you/);
  await Bun.sleep(300);
  expect(pushes.find((p) => p.meta.message_id === String(leaf.message_id))?.meta.parent_id).toBe(String(reply.message_id));
}, 20_000);

test("peer_list shows where a session runs and its status; a restart clears the status", async () => {
  const be = await start("be");
  let sim = await start("sim");
  await call(sim, "peer_status", { text: "spec 163 soak" });
  const row = (await call(be, "peer_list")).peers.find((p: any) => p.handle === "sim");
  expect(row).toMatchObject({ where: basename(dir), status: "spec 163 soak", status_age: "0m" });
  await stop(sim);
  sim = await start("sim");
  expect((await call(be, "peer_list")).peers.find((p: any) => p.handle === "sim").status).toBeUndefined();
}, 20_000);

test("active claims show in board_read and in a new session's instructions", async () => {
  const be = await start("be");
  await call(be, "board_create", { name: "dev-deploys", purpose: "rolls" });
  await call(be, "claim_take", { key: "dev:freeze", board: "dev-deploys", note: "24h soak", ttl_minutes: 60 });
  const r = await call(be, "board_read", { board: "dev-deploys" });
  expect(r.active_claims).toMatchObject([{ key: "dev:freeze", holder: "be", note: "24h soak" }]);
  const fe = await start("fe");
  expect(fe.getInstructions()).toContain("Others': dev:freeze.");
}, 20_000);

test("a wrong argument name gets an error naming the expected call", async () => {
  const be = await start("be");
  await start("fe");
  await expect(call(be, "dm_send", { recipient: "fe", body: "hi" })).rejects.toThrow(
    "dm_send(to, body, parent_id?, pending?, attachments?): missing to; unknown recipient.",
  );
}, 20_000);

test("identities from before the handles roster are backfilled", async () => {
  const { Database } = await import("bun:sqlite");
  const old = new Database(join(dir, "bus.db"));
  old.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT NOT NULL, recipient TEXT NOT NULL,
              body TEXT NOT NULL, parent_id INTEGER, created_at INTEGER NOT NULL);
            CREATE TABLE cursors (reader TEXT PRIMARY KEY, last_seen_id INTEGER NOT NULL);
            INSERT INTO messages (sender, recipient, body, created_at) VALUES ('fe', 'be', 'hi', 1), ('be', 'typo', 'x', 2);
            INSERT INTO cursors VALUES ('docs', 1);`);
  old.close();
  const be = await start("be");
  const all = await call(be, "peer_list", { include_offline: true });
  expect(all.peers.map((p: any) => p.handle)).toEqual(["be", "docs", "fe"]);
  expect((await call(be, "dm_send", { to: "fe", body: "still there?" })).delivered_now).toBe(false);
  await expect(call(be, "dm_send", { to: "typo", body: "x" })).rejects.toThrow(/peer_list/);
}, 20_000);

test("senders see what hasn't reached an offline peer: send result, history, and next session", async () => {
  const fe = await start("fe");
  await stop(fe);
  let be = await start("be");
  await call(be, "dm_send", { to: "fe", body: "contract change 1" });
  const second = await call(be, "dm_send", { to: "fe", body: "contract change 2" });
  expect(second).toMatchObject({ delivered_now: false, recipient_last_seen: expect.stringMatching(/ago$/), undelivered_from_you: 2 });
  expect((await call(be, "dm_history", { peer: "fe" })).map((m: any) => m.delivered)).toEqual([false, false]);

  await stop(be);
  const { Database } = await import("bun:sqlite");
  const db = new Database(join(dir, "bus.db"));
  db.exec(`UPDATE messages SET created_at = created_at - 2 * 86400000`);
  db.close();
  be = await start("be");
  expect(be.getInstructions()).toMatch(/haven't reached the recipient after 24h: fe: 2 since message_id \d+ \(last seen/);

  await start("fe");
  await Bun.sleep(300); // fe's first drain moves its cursor
  expect((await call(be, "dm_history", { peer: "fe" })).map((m: any) => m.delivered)).toEqual([true, true]);
}, 20_000);

test("dm_inbox lists what you owe: replied and acked messages drop out", async () => {
  const be = await start("be");
  const fe = await start("fe");
  const q = await call(fe, "dm_send", { to: "be", body: "question?" });
  const fyi = await call(fe, "dm_send", { to: "be", body: "FYI: deployed" });
  const later = await call(fe, "dm_send", { to: "be", body: "follow-up", parent_id: q.message_id });
  expect((await call(be, "dm_inbox")).unanswered.map((m: any) => m.id)).toEqual([q.message_id, fyi.message_id, later.message_id]);

  await call(be, "dm_send", { to: "fe", body: "answer", parent_id: q.message_id });
  await call(be, "dm_ack", { message_id: fyi.message_id });
  expect((await call(be, "dm_inbox")).unanswered).toEqual([]);
  await expect(call(fe, "dm_ack", { message_id: fyi.message_id })).rejects.toThrow(/no message/);
  expect(be.getInstructions()).toContain("dm_inbox()");
}, 20_000);

test("dm_send pending lists a promise in dm_inbox until your next message in the thread, or a dm_ack", async () => {
  const be = await start("be");
  const fe = await start("fe");
  const q = await call(fe, "dm_send", { to: "be", body: "can you check the soak?" });
  const p = await call(be, "dm_send", { to: "fe", body: "on it, results by noon", parent_id: q.message_id, pending: true });
  expect(p).toMatchObject({ pending: true });
  expect((await call(be, "dm_inbox", { days: 1 })).promised).toMatchObject([{ id: p.message_id, to: "fe", parent_id: q.message_id, body: "on it, results by noon" }]);
  // Their reply doesn't keep it; yours does. History marks only the pending one.
  await call(fe, "dm_send", { to: "be", body: "thanks", parent_id: p.message_id });
  expect((await call(be, "dm_inbox")).promised).toHaveLength(1);
  expect((await call(be, "dm_thread", { thread: q.message_id })).map((m: any) => m.pending)).toEqual([undefined, true, undefined]);
  await call(be, "dm_send", { to: "fe", body: "soak passed", parent_id: p.message_id });
  expect((await call(be, "dm_inbox")).promised).toBeUndefined();

  // dm_ack drops your own promise; it still can't ack your other sends.
  const p2 = await call(be, "dm_send", { to: "fe", body: "will follow up", pending: true });
  await expect(call(fe, "dm_ack", { message_id: [p2.message_id] })).resolves.toBe("ok");
  expect((await call(be, "dm_inbox")).promised).toHaveLength(1);
  expect(await call(be, "dm_ack", { message_id: p2.message_id })).toBe("ok");
  expect((await call(be, "dm_inbox")).promised).toBeUndefined();
}, 20_000);

test("dm_ack takes a list, so one combined reply clears every message it covered", async () => {
  const be = await start("be");
  const fe = await start("fe");
  const ids = [];
  for (const body of ["a", "b", "c"]) ids.push((await call(fe, "dm_send", { to: "be", body })).message_id);
  await call(be, "dm_send", { to: "fe", body: "re a, b, c", parent_id: ids[0] });
  expect(await call(be, "dm_ack", { message_id: [ids[1], ids[2]] })).toBe("ok");
  expect((await call(be, "dm_inbox")).unanswered).toEqual([]);
  // Partial: acks what it can and names the rest; all-bad is an error.
  const d = (await call(fe, "dm_send", { to: "be", body: "d" })).message_id;
  const mine = (await call(be, "dm_send", { to: "fe", body: "mine" })).message_id;
  expect(await call(be, "dm_ack", { message_id: [d, mine] })).toMatchObject({ acked: [d], not_found: [mine] });
  await expect(call(be, "dm_ack", { message_id: [mine] })).rejects.toThrow(/no message/);
  await expect(call(be, "dm_ack", { message_id: [] })).rejects.toThrow(/list of them/);
}, 20_000);

test("a send to a long-idle handle says so; dm_retract withdraws it until it's delivered", async () => {
  await stop(await start("fe"));
  const be = await start("be");
  const sim = await start("sim");
  const first = await call(be, "dm_send", { to: "fe", body: "first" });
  expect(first.note).toMatch(/^Recipient offline/);
  const { Database } = await import("bun:sqlite");
  const db = new Database(join(dir, "bus.db"));
  db.exec(`UPDATE handles SET last_seen = last_seen - 22 * 3600000 WHERE name = 'fe'`);
  db.close();
  const wrong = await call(be, "dm_send", { to: "fe", body: "meant for sim" });
  expect(wrong.note).toMatch(/^Queued: fe last seen 22h ago\. .*dm_retract/);
  const followup = await call(be, "dm_send", { to: "fe", body: "also", parent_id: first.message_id });

  await expect(call(sim, "dm_retract", { message_id: wrong.message_id })).rejects.toThrow(/no message \d+ from you/);
  await expect(call(be, "dm_retract", { message_id: first.message_id })).rejects.toThrow(/has a reply/);
  expect(await call(be, "dm_retract", { message_id: wrong.message_id })).toBe("ok");
  expect((await call(be, "dm_history", { peer: "fe" })).map((m: any) => m.body)).toEqual(["first", "also"]);

  const fe = await session("fe");
  await Bun.sleep(500);
  expect(contents(fe)).toEqual(["first", "also"]);
  await expect(call(be, "dm_retract", { message_id: followup.message_id })).rejects.toThrow(/already reached fe/);
}, 20_000);

test("identity create --mcp names a missing directory instead of failing with ENOENT", async () => {
  const create = (path: string) => runCli(["identity", "create", "be", "--mcp", path], { cwd: dir, env: busEnv() });
  const bad = await create("nope/.mcp.json");
  expect(bad.code).toBe(1);
  expect(bad.err).toMatch(/directory \S*\/nope doesn't exist/);
  const ok = await create(".mcp.json");
  expect(ok.code).toBe(0);
  // The pin is a suggestion; the output says how to bind at start (#182).
  expect(ok.out).toContain(`"be" is pinned as this checkout's default`);
  expect(ok.out).toContain("set BUS_IDENTITY in the launch command to bind at start");
}, 20_000);

test("grayboard claims: exits 2 when another session holds a match, 0 otherwise", async () => {
  const claims = (identity: string, ...args: string[]) => runCli(["claims", ...args], { cwd: dir, env: busEnv(identity) });
  expect((await claims("fe")).code).toBe(0); // no bus yet
  const be = await start("be");
  await call(be, "claim_take", { key: "dev:env", note: "migrating", ttl_minutes: 60 });

  const held = await claims("fe");
  expect(held.code).toBe(2);
  expect(held.err).toMatch(/dev:env held by be until \d{4}-\d\d-\d\dT\d\d:\d\dZ: migrating/);
  expect((await claims("fe", "--prefix", "prod:")).code).toBe(0);
  expect((await claims("be")).code).toBe(0);
  expect((await claims("be", "--include-self")).code).toBe(2);
  const json = await claims("fe", "--json");
  expect(JSON.parse(json.out)).toEqual([expect.objectContaining({ key: "dev:env", holder: "be", note: "migrating" })]);
  expect(JSON.parse(json.out)[0].board).toBeUndefined();
}, 20_000);

// The CLI as a lane's shell runs it: env and cwd decide the handle.
const gb = (identity: string | undefined, cwd: string, ...args: string[]) => runCli(args, { cwd, env: busEnv(identity) });

test("grayboard claim take/release acts as the shell's bound session; held exits 2", async () => {
  const repo = join(dir, "api");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const api = await start(undefined, repo, ["mcp"]);
  const be = await start("be");

  // Each session runs under its own harness stand-in, none of them an
  // ancestor of the CLI, so the checkout picks (#182 decision 18); the
  // ancestor rule is src/cli/claim.test.ts's. An unbound session has no name
  // to act as: refuse, never guess.
  const unbound = await gb(undefined, repo, "whoami");
  expect(unbound.code).toBe(1);
  expect(unbound.err).toContain("hasn't bound a name yet");
  await call(api, "bind", { name: "api", create: true });
  expect(await gb(undefined, repo, "whoami")).toMatchObject({ code: 0, out: "api (from the session in this checkout)\n" });
  const elsewhere = mkdtempSync(join(dir, "elsewhere-"));
  expect((await gb(undefined, elsewhere, "whoami")).err).toContain("no live session runs this shell or this checkout");
  expect(JSON.parse((await gb("be", dir, "--json", "whoami")).out)).toEqual({ handle: "be", source: "BUS_IDENTITY" });

  const took = await gb(undefined, repo, "claim", "take", "sandbox:sbx-1", "--ttl", "2h", "--note", "smoke");
  expect(took.code).toBe(0);
  expect(JSON.parse(took.out)).toMatchObject({ ok: true, claim: { key: "sandbox:sbx-1", holder: "api", note: "smoke" } });
  const listed = await call(be, "claim_list");
  expect(listed).toMatchObject([{ key: "sandbox:sbx-1", holder: "api" }]);
  expect(listed[0].expires_at - Date.now()).toBeGreaterThan(110 * 60_000);

  const held = await gb("be", dir, "claim", "take", "sandbox:sbx-1");
  expect(held.code).toBe(2);
  expect(JSON.parse(held.out)).toMatchObject({ ok: false, held_by: "api", note: "smoke" });
  expect((await gb("be", dir, "claim", "take", "sandbox:sbx-2")).code).toBe(0);

  expect((await gb(undefined, dir, "--as", "api", "claim", "release", "sandbox:sbx-1")).code).toBe(0);
  expect((await call(api, "claim_list")).map((c: any) => c.key)).toEqual(["sandbox:sbx-2"]);
  expect((await gb(undefined, dir, "--as", "be", "claims")).code).toBe(0); // --as counts as self
}, 20_000);

test("grayboard claim refuses a handle no session has used, and the human's handle", async () => {
  await start("be");
  const unknown = await gb(undefined, dir, "--as", "nobody", "claim", "take", "k");
  expect(unknown.code).toBe(1);
  expect(unknown.err).toMatch(/no session has used handle "nobody".*whoami/);
  expect((await cli("human", "alex")).code).toBe(0);
  const human = await gb(undefined, dir, "--as", "alex", "claim", "take", "k");
  expect(human.code).toBe(1);
  expect(human.err).toContain(`"alex" is the human handle`);
  expect((await gb(undefined, dir, "--as", "Bad Name", "claim", "take", "k")).err).toContain("invalid --as");
}, 20_000);

test("grayboard claim watch: the session is pushed the release", async () => {
  const be = await start("be");
  const sim = await session("sim");
  await call(be, "board_create", { name: "e2e", purpose: "x" });
  await call(sim.c, "board_subscribe", { board: "e2e", mode: "quiet" });
  await call(be, "claim_take", { key: "sandbox:sbx-1", board: "e2e" });
  const w = await gb("sim", dir, "claim", "watch", "sandbox:sbx-1");
  expect(w.code, w.err).toBe(0);
  await call(be, "claim_release", { key: "sandbox:sbx-1", note: "done" });
  await Bun.sleep(300);
  expect(contents(sim)).toEqual(["[release] sandbox:sbx-1 — done cc @sim"]);
}, 20_000);

test("claim_watch: a quiet subscriber is pushed the release of the claim it waits on", async () => {
  const be = await start("be");
  const sim = await session("sim");
  await call(be, "board_create", { name: "dev-deploys", purpose: "x" });
  await call(sim.c, "board_subscribe", { board: "dev-deploys", mode: "quiet" });
  await call(be, "claim_take", { key: "dev:env", board: "dev-deploys" });
  await call(sim.c, "claim_watch", { key: "dev:env" });
  await call(be, "claim_release", { key: "dev:env", note: "done" });
  await Bun.sleep(300);
  expect(contents(sim)).toEqual(["[release] dev:env — done cc @sim"]);
}, 20_000);

test("a thread reply to a bystander waits for its next wake, here a DM", async () => {
  const be = await start("be");
  const fe = await start("fe");
  const sim = await session("sim");
  await call(be, "board_create", { name: "ops", purpose: "x" });
  await call(be, "board_subscribe", { board: "ops", mode: "off" });
  const root = await call(be, "board_post", { board: "ops", body: "root" });
  await call(sim.c, "board_post", { board: "ops", body: "sim chimes in", parent_id: root.post_id });
  const mid = await call(fe, "board_post", { board: "ops", body: "fe asks", parent_id: root.post_id });
  const reply = await call(be, "board_post", { board: "ops", body: "answer for fe", parent_id: mid.post_id });
  expect(reply).toMatchObject({ notified: ["fe"], deferred: ["sim"] });
  await Bun.sleep(300);
  expect(contents(sim)).toEqual([]); // both replies to the thread are deferred for sim
  await call(fe, "dm_send", { to: "sim", body: "ping" });
  await Bun.sleep(300);
  expect(contents(sim)).toEqual(["ping", "fe asks", "answer for fe"]);
}, 20_000);

test("dm_send and dm_history check body and limit as server mode does", async () => {
  await stop(await start("fe"));
  const be = await start("be");
  await expect(call(be, "dm_send", { to: "fe", body: " " })).rejects.toThrow("body is required");
  await expect(call(be, "dm_send", { to: "fe", body: "x".repeat(64 * 1024 + 1) })).rejects.toThrow("body exceeds");
  for (const body of ["one", "two", "three"]) await call(be, "dm_send", { to: "fe", body });
  const bodies = async (limit: unknown) => (await call(be, "dm_history", { peer: "fe", limit })).map((m: any) => m.body);
  expect(await bodies(2)).toEqual(["two", "three"]);
  expect(await bodies(0)).toEqual(["three"]);
  await expect(bodies("lots")).rejects.toThrow("limit must be a number");
}, 20_000);

test("a message queued while offline is pushed when the session starts", async () => {
  await stop(await start("be"));
  const fe = await start("fe");
  expect((await call(fe, "dm_send", { to: "be", body: "queued dm" })).delivered_now).toBe(false);
  const be = await session("be");
  await Bun.sleep(500);
  expect(contents(be)).toEqual(["queued dm"]);
}, 20_000);

test("the reply and recovery tools ask Claude Code to load them upfront", async () => {
  const c = await start("be");
  const { tools } = await c.listTools();
  const upfront = tools.filter((t) => t._meta?.["anthropic/alwaysLoad"] === true).map((t) => t.name).sort();
  expect(upfront).toEqual(["bind", "board_post", "claim_list", "dm_ack", "dm_inbox", "dm_send", "dm_thread", "peer_status"]);
}, 20_000);

test("a Claude Code session started without a channels flag runs tools-only and is warned", async () => {
  // Stand-in for Claude Code: a process named `claude` (bun under another
  // name) that runs grayboard mcp as its child on inherited stdio, with
  // CLAUDECODE=1 as Claude Code sets. Its own flags come before "::".
  const fake = join(dir, "claude");
  symlinkSync(process.execPath, fake);
  const host = join(dir, "host.ts");
  writeFileSync(host, `const cmd = process.argv.slice(process.argv.indexOf("::") + 1);
Bun.spawn([process.execPath, ...cmd], { stdio: ["inherit", "inherit", "inherit"] }).exited.then((c) => process.exit(c ?? 0));`);
  const claude = async (identity: string, flags: string[]) =>
    (await localSession(dir, identity, { extra: { CLAUDECODE: "1" }, via: [fake, host, ...flags, "::"] })).c;
  const texts = async (c: Client) => ((await c.callTool({ name: "peer_list", arguments: {} })).content as { text: string }[]).map((t) => t.text);

  const off = await claude("be", []);
  expect(off.getInstructions()).toStartWith("Warning: this Claude Code session was started without");
  expect((await texts(off)).some((t) => t.startsWith("Warning:"))).toBe(true);
  expect((await texts(off)).some((t) => t.startsWith("Warning:"))).toBe(false); // first tool result only

  const on = await claude("fe", ["--dangerously-load-development-channels", "server:grayboard"]);
  expect(on.getInstructions()).not.toContain("Warning:");
  expect((await texts(on)).some((t) => t.startsWith("Warning:"))).toBe(false);

  // The flagless session would drop pushes yet mark them delivered: it holds
  // its name but takes none, so a DM waits. A session with channels can't
  // take the name while it's held (#182); once the flagless one exits, it
  // binds the name and gets what waited.
  expect((await call(on, "dm_send", { to: "be", body: "waits" })).delivered_now).toBe(false);
  const be = await session("be");
  expect(be.c.getInstructions()).toContain('BUS_IDENTITY asked for "be", but');
  await stop(off);
  await be.call("bind", { name: "be" });
  await until(() => contents(be).length > 0);
  expect(contents(be)).toEqual(["waits"]);
}, 20_000);

const cli = (...args: string[]) => runCli(args, { cwd: dir, env: busEnv() });

const exitOf = (identity: string, extra: Record<string, string> = {}) => runCli(["mcp", "--mode", "local"], { cwd: dir, env: busEnv(identity, extra) });

test("the human's handle: BUS_HUMAN needs a declaration, and agents can't take it by name", async () => {
  expect(await exitOf("alex", { BUS_HUMAN: "1" })).toMatchObject({ code: 1, err: expect.stringContaining("grayboard human alex") });
  expect((await cli("announce", "hi")).err).toContain("no human handle declared");
  expect((await cli("human", "alex")).code).toBe(0);
  expect((await cli("human")).out.trim()).toBe("alex");
  expect(await exitOf("alex")).toMatchObject({ code: 1, err: expect.stringContaining("your user's handle") });
  // Declared, with BUS_HUMAN=1 as the bridge runs it: starts (and exits 0 at stdin EOF).
  expect((await exitOf("alex", { BUS_HUMAN: "1" })).code).toBe(0);
}, 20_000);

test("grayboard board create makes a board as the human; agents see it", async () => {
  expect((await cli("board", "create", "workspace", "lanes")).err).toContain("no human handle declared");
  await cli("human", "alex");
  const r = await cli("board", "create", "#Workspace", "lane", "count", "and", "naming");
  expect(r.code).toBe(0);
  expect(r.out).toContain("Created #workspace");
  expect((await cli("board", "create", "workspace", "again")).err).toContain("already exists");
  const be = await start("be");
  const b = (await call(be, "board_list")).find((x: any) => x.name === "workspace");
  expect(b).toMatchObject({ purpose: "lane count and naming", created_by: "alex" });
}, 20_000);

test("grayboard announce reaches live sessions marked human; a TTL carries it into new sessions", async () => {
  await cli("human", "alex");
  const { c: be, pushes } = await session("be");
  await stop(await start("fe"));
  await expect(call(be, "board_post", { board: "announce", body: "relayed: stop" })).rejects.toThrow(/only your user starts posts/);

  const r = await cli("announce", "--ttl", "1h", "merge", "freeze");
  expect(r.out).toContain("reached: be");
  await Bun.sleep(500);
  expect(pushes.find((p) => p.content === "merge freeze")?.meta).toMatchObject({ board: "announce", from: "alex", human: "true" });

  const fe = await start("fe");
  expect(fe.getInstructions()).toMatch(/announcements still in effect \(human="true"\): post \d+ from alex, in effect until .*: merge freeze/);
}, 20_000);

test("attachments: sent with a DM or post, shown on reads and pushes, fetched by readers only", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]);
  writeFileSync(join(dir, "shot.png"), png);
  writeFileSync(join(dir, "notes.md"), "# notes");
  writeFileSync(join(dir, ".env"), "TOKEN=x");
  const be = await start("be");
  const { c: fe, pushes } = await session("fe");
  const sim = await start("sim");

  await expect(call(be, "dm_send", { to: "fe", body: "x", attachments: [".env"] })).rejects.toThrow(/dotfiles/);
  await expect(call(be, "dm_send", { to: "fe", body: "x", attachments: ["/etc/hosts"] })).rejects.toThrow(/outside the directories/);
  const sent = await call(be, "dm_send", { to: "fe", body: "see these", attachments: ["shot.png", join(dir, "notes.md")] });
  const [shot, notes] = sent.attachments;
  expect(shot).toEqual({ id: expect.any(Number), filename: "shot.png", type: "image/png", size: png.length, sha256: sha256Hex(png) });
  expect(notes).toMatchObject({ filename: "notes.md", type: "text/markdown", size: 7 });

  await Bun.sleep(300);
  const meta = pushes.find((p) => p.meta.message_id === String(sent.message_id))!.meta;
  expect(meta.files_tool).toMatch(/^attachment_get\(id/);
  expect(meta.attachments).toBe(`${shot.id}:shot.png image/png 10B sha256:${sha256Hex(png)}; ${notes.id}:notes.md text/markdown 7B sha256:${sha256Hex(new TextEncoder().encode("# notes"))}`);
  expect((await call(fe, "dm_thread", { thread: sent.message_id }))[0].attachments).toEqual(sent.attachments);
  expect((await call(fe, "dm_inbox")).unanswered[0].attachments).toEqual(sent.attachments);

  const saved = await call(fe, "attachment_get", { id: shot.id });
  expect(saved.path).toBe(join(dir, "saved", localBusDir(join(dir, "bus.db")), `${shot.id}-shot.png`));
  expect(new Uint8Array(readFileSync(saved.path))).toEqual(png);
  mkdirSync(join(dir, "out"));
  expect((await call(fe, "attachment_get", { id: notes.id, dir: "out" })).path).toBe(join(realpathSync(dir), "out", `${notes.id}-notes.md`));
  await expect(call(fe, "attachment_get", { id: notes.id, dir: "/" })).rejects.toThrow(/outside the directories/);
  await expect(call(sim, "attachment_get", { id: shot.id })).rejects.toThrow(/no attachment/);

  await call(be, "board_create", { name: "e2e", purpose: "fixtures" });
  await call(fe, "board_subscribe", { board: "e2e", mode: "push" });
  await expect(call(be, "board_post", { board: "e2e", body: "x", parent_id: 9999, attachments: ["shot.png"] })).rejects.toThrow(/parent_id/);
  const posted = await call(be, "board_post", { board: "e2e", body: "shot", attachments: ["shot.png"] });
  expect(posted.attachments).toEqual([{ id: expect.any(Number), filename: "shot.png", type: "image/png", size: png.length, sha256: sha256Hex(png) }]);
  await Bun.sleep(300);
  expect(pushes.find((p) => p.meta.post_id === String(posted.post_id))!.meta.attachments).toBe(`${posted.attachments[0].id}:shot.png image/png 10B sha256:${sha256Hex(png)}`);
  expect((await call(sim, "board_read", { board: "e2e" })).posts[0].attachments).toEqual(posted.attachments);
  expect((await call(sim, "attachment_get", { id: posted.attachments[0].id })).size).toBe(png.length);

  const { Database } = await import("bun:sqlite");
  const db = new Database(join(dir, "bus.db"));
  const count = () => (db.prepare(`SELECT COUNT(*) AS n FROM attachments`).get() as { n: number }).n;
  // The refused post released its upload; the blob is shared by content.
  expect(count()).toBe(3);
  expect((db.prepare(`SELECT COUNT(*) AS n FROM attachment_blobs`).get() as { n: number }).n).toBe(2);

  await stop(fe);
  const queued = await call(be, "dm_send", { to: "fe", body: "oops", attachments: ["notes.md"] });
  expect(count()).toBe(4);
  expect(await call(be, "dm_retract", { message_id: queued.message_id })).toBe("ok");
  expect(count()).toBe(3);
  db.close();
}, 20_000);
