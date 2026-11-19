// The hosted scenarios pi and omp share (#439): one body each, parameterized
// by a harness descriptor that tests/support/pi.ts and tests/support/omp.ts
// supply. Both harnesses speak pi's RPC protocol, so the Pi class and the
// hosted helpers come from tests/support/pi.ts. Where the harnesses differ,
// the descriptor says so; each keeps its own, stricter where it has one.
import { expect } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../../src/server/config.ts";
import { onChannelDm, startFakeModel, type FakeModel, type Reply, type Rule } from "./fake_model.ts";
import { hostedServer, seedGrant, tokenRequests, type HostedServer } from "./hosted_oauth.ts";
import { answerPeer, expectDeliveryRecords, expectSignInOffer, hostedPeer, tokenPeer, hostedRow, leased, ownershipEnded, pingPong, scripted, statusOf, stopAll, toolResultNamed, type Peer, type Pi } from "./pi.ts";
import { grayboardDescendants } from "./procs.ts";
import { accessAudits } from "./audit.ts";
import { serviceRun } from "./service_token.ts";
import { until } from "./until.ts";

// `env`: extra environment for the harness process (a static run's launcher variables, BUS_IDENTITY).
export type StartOpts = { persist?: boolean; session?: string; env?: Record<string, string> };

export type HostedHarness = {
  // "pi" or "omp": its notices and sign-in text name it, and so do the scenarios' bus names.
  name: string;
  // The pinned harness version a failure names.
  version: string;
  // The OAuth client the extension signs in as.
  client: string;
  // The harness's grayboard tool-name prefix.
  prefix: string;
  // The extension's state dir under the scenario's `dir` (config, grant, delivery lock).
  stateDir(dir: string): string;
  // Written once per scenario, before any process starts.
  install(dir: string, srv: HostedServer, modelPort: number): void;
  // `persist` keeps the session files (/fork, /new, /resume need them); `session` opens one.
  start(dir: string, procs: ChildProcess[], o?: StartOpts): Pi;
  // The harness finished its run.
  idle(proc: Pi): Promise<unknown>;
  // The first get_state's timeout (unset: Pi.command's default).
  stateTimeout?: number;
  // How long the refresh scenario's two processes may take to reach the server.
  onServerTimeout: number;
  // /fork, as the harness's RPC takes it.
  fork(proc: Pi): Promise<void>;
  // The fork's session file also holds the delivery records it copied from the session it left.
  forkCopiesRecords: boolean;
  // Checks the model request that carried each DM a carry ping delivered.
  delivered?(model: FakeModel, ping: number, name: string): void;
  // Waits until a second process may start on the same agent dir.
  beforeSecondStart?(dir: string): Promise<unknown>;
  // The logout notice lands after the prompt command returns, so the scenario waits for it instead of asserting at once.
  logoutNoticeLags: boolean;
  // A root may sit in `retrying` until its next reopen meets the sign-out (#606), so the scenario waits for the paused status.
  pauseLags: boolean;
  // Model rules under which the prompt `trigger` makes the root run one subagent whose calls are `steps`: pi's
  // detached runner, a process its bash execs with the root's environment; omp's task subagent, in its process.
  // `root()` is the root's own session ID, read when the root's step runs.
  subagent(dir: string, trigger: string, steps: Reply[], root: () => string): Rule[];
};

export type Hosted = { srv: HostedServer; model: FakeModel; peer: Peer; start(o?: StartOpts): Pi };

// A failure names the harness's version.
export async function named(h: { name: string; version: string }, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (e) {
    if (e instanceof Error) e.message = `${h.name} ${h.version}: ${e.message}`;
    throw e;
  }
}

// A server, the fake model (answerPeer first, then `rules`), the peer and the
// installed extension; `run` starts the harness processes. Everything stops after.
export function withHosted(h: HostedHarness, dir: string, rules: Rule[], run: (hosted: Hosted) => Promise<void>, server: Partial<Config> = {}): Promise<void> {
  return named(h, async () => {
    const procs: ChildProcess[] = [];
    const srv = hostedServer(server);
    const model = startFakeModel([answerPeer(h.prefix), ...rules]);
    let peer: Peer | undefined;
    try {
      peer = await hostedPeer(srv, dir);
      h.install(dir, srv, model.port);
      await run({ srv, model, peer, start: (o) => h.start(dir, procs, o) });
      expect(model.unhandled).toEqual([]);
      expect(peer.reports).toEqual([]);
    } finally {
      await stopAll(procs);
      await peer?.close();
      model.stop();
      await srv.stop();
    }
  });
}

// A declaration, not a const: pi.ts and omp.ts call it while loading, inside an import cycle.
export function loginNotice(harness: string): string {
  return `grayboard: Signed out of grayboard in ${harness}; run /grayboard login`;
}

// /fork is a new root with its own lease that carries the name; /new carries
// it too; /resume of the first session rebinds that session's remembered
// name. Each time the name receives in the current session and the outgoing
// one has ended.
export function hostedCarryScenario(h: HostedHarness, dir: string): Promise<void> {
  const name = `${h.name}-carry`;
  const row = (srv: HostedServer, raw: string) => hostedRow(srv, h.client, raw);
  const leasedAs = (srv: HostedServer, raw: string) => leased(srv, h.client, raw, name);
  return withHosted(h, dir, [scripted("bind", [{ tool: `${h.prefix}bind`, args: { name, create: true } }])], async ({ srv, model, peer, start }) => {
    await seedGrant(srv, h.stateDir(dir), h.client);
    const proc = start({ persist: true });
    const first = await proc.command({ type: "get_state" }, h.stateTimeout);
    const ping = async () => {
      const id = await pingPong(srv, peer, name);
      h.delivered?.(model, id, name);
      await h.idle(proc);
      return id;
    };
    await proc.command({ type: "prompt", message: "bind" });
    await until(() => leasedAs(srv, first.sessionId), 30_000, `first session leased as ${name}`);
    const p1 = await ping();
    const firstOwnership = row(srv, first.sessionId)!.ownership_id;

    // /fork: the outgoing session ends; the fork binds the name under its own ownership and lease.
    await h.fork(proc);
    const forked = await proc.command({ type: "get_state" });
    expect(forked.sessionId).not.toBe(first.sessionId);
    await until(() => leasedAs(srv, forked.sessionId), 15_000, `fork leased as ${name}`);
    expect(row(srv, first.sessionId)).toBeUndefined();
    expect(ownershipEnded(srv, firstOwnership)).toBe(true);
    expect(row(srv, forked.sessionId)!.ownership_id).not.toBe(firstOwnership);
    const p2 = await ping();

    // /new carries it on.
    const forkOwnership = row(srv, forked.sessionId)!.ownership_id;
    await proc.command({ type: "new_session" });
    const fresh = await proc.command({ type: "get_state" });
    expect([first.sessionId, forked.sessionId]).not.toContain(fresh.sessionId);
    await until(() => leasedAs(srv, fresh.sessionId), 15_000, `new session leased as ${name}`);
    expect(row(srv, forked.sessionId)).toBeUndefined();
    expect(ownershipEnded(srv, forkOwnership)).toBe(true);
    const p3 = await ping();

    // /resume of the first session: it rebinds the name it remembers.
    await proc.command({ type: "switch_session", sessionPath: first.sessionFile });
    expect((await proc.command({ type: "get_state" })).sessionId).toBe(first.sessionId);
    await until(() => leasedAs(srv, first.sessionId), 15_000, `resumed first session leased as ${name}`);
    expect(row(srv, fresh.sessionId)).toBeUndefined();
    const p4 = await ping();
    expect(grayboardDescendants(proc.pid)).toEqual([]);
    expect(proc.events.filter((e) => e.type === "extension_error")).toEqual([]);
    // Each session's file records its deliveries: the first holds the DMs it
    // received before the fork and after the resume, /new's the one it did,
    // the fork's its own and, where /fork copies the session it left
    // (forkCopiesRecords), the first's records it copied (#504).
    await expectDeliveryRecords(first.sessionFile, first.sessionId, [p1, p4], name);
    await expectDeliveryRecords(forked.sessionFile, forked.sessionId, [p2], name, h.forkCopiesRecords ? { root: first.sessionId, pings: [p1] } : undefined);
    await expectDeliveryRecords(fresh.sessionFile, fresh.sessionId, [p3], name);
    await proc.quit();
    await until(() => srv.app.mcp.activeLeases === 0 && !row(srv, first.sessionId), 10_000, "released on quit");
  });
}

// Two processes on one agentDir start with an expired access token: one
// refresh serves both. Then /grayboard logout in one revokes the grant and
// pauses both.
export function hostedRefreshLogoutScenario(h: HostedHarness, dir: string): Promise<void> {
  const [nameA, nameB] = [`${h.name}-a`, `${h.name}-b`];
  const row = (srv: HostedServer, raw: string) => hostedRow(srv, h.client, raw);
  return withHosted(h, dir, [
    scripted("bind a", [{ tool: `${h.prefix}bind`, args: { name: nameA, create: true } }]),
    scripted("bind b", [{ tool: `${h.prefix}bind`, args: { name: nameB, create: true } }]),
    scripted("check", [{ tool: `${h.prefix}whoami`, args: {} }]),
  ], async ({ srv, start }) => {
    const seeded = await seedGrant(srv, h.stateDir(dir), h.client, "alice@example.com", -60_000);
    const refreshTokens = () => srv.app.db.query<{ n: number; spent: number }, [string]>(
      "SELECT count(*) AS n, count(spent_at) AS spent FROM oauth_tokens WHERE grant_id = ? AND kind = 'refresh'").get(seeded.grantId)!;
    expect(refreshTokens()).toEqual({ n: 1, spent: 0 });
    const tokens = tokenRequests(srv);

    // The one rotation must serve both processes, even when b waits on a
    // (beforeSecondStart) to start.
    const a = start();
    await h.beforeSecondStart?.(dir);
    const b = start();
    const [sa, sb] = await Promise.all([a.command({ type: "get_state" }, h.stateTimeout), b.command({ type: "get_state" }, h.stateTimeout)]);
    expect(sa.sessionId).not.toBe(sb.sessionId);
    // Both reached the server on one refresh request, and so one rotation.
    await until(() => row(srv, sa.sessionId) && row(srv, sb.sessionId), h.onServerTimeout, "both sessions on the server");
    expect(refreshTokens()).toEqual({ n: 2, spent: 1 });
    expect(tokens()).toEqual(["refresh_token"]);

    await a.command({ type: "prompt", message: "bind a" });
    await b.command({ type: "prompt", message: "bind b" });
    await until(() => row(srv, sa.sessionId)?.name === nameA && row(srv, sb.sessionId)?.name === nameB && srv.app.mcp.activeLeases === 2, 30_000, "both leased");
    expect(refreshTokens()).toEqual({ n: 2, spent: 1 });
    expect(tokens()).toEqual(["refresh_token"]);
    await Promise.all([h.idle(a), h.idle(b)]);

    // Logout in a: the grant is revoked, so the server drops both leases,
    // and both processes pause with the login notice.
    const seenA = a.notices().length, seenB = b.notices().length;
    const loggedOut = `grayboard: signed out; every ${h.name} session on this server pauses until run /grayboard login`;
    await a.command({ type: "prompt", message: "/grayboard logout" });
    if (h.logoutNoticeLags) await until(() => a.notices().slice(seenA).includes(loggedOut), 10_000, "the logout notice");
    else expect(a.notices().slice(seenA)).toContain(loggedOut);
    await until(() => srv.app.mcp.activeLeases === 0, 15_000, "both leases dropped");
    expect(srv.app.db.query<{ revoked_at: number | null }, [string]>("SELECT revoked_at FROM oauth_grants WHERE id = ?").get(seeded.grantId)!.revoked_at).not.toBeNull();
    await until(() => b.notices().slice(seenB).includes(loginNotice(h.name)), 15_000, "the login notice in the other process");
    const paused = (status: string) => status.includes("\nsign-in: signed out (logged_out); run /grayboard login\n") && /: paused, /.test(status);
    // A root whose subscription closed first sits in `retrying` until its next reopen meets the sign-out (#606).
    if (h.pauseLags) {
      for (const proc of [a, b]) await until(async () => {
        const status = await statusOf(proc);
        return paused(status) ? status : undefined;
      }, 15_000, "both roots paused by the sign-out");
    } else {
      for (const proc of [a, b]) {
        const status = await statusOf(proc);
        expect(status).toContain("\nsign-in: signed out (logged_out); run /grayboard login\n");
        expect(status).toMatch(/: paused, /);
      }
    }
    // The other process's next tool call offers a sign-in; once it lands,
    // both processes' roots restart (unbound: the logout's revoke ended their sessions).
    await expectSignInOffer(srv, b, h.name, { results: 0, whoami: (nth) => toolResultNamed(b, `${h.prefix}whoami`, nth), idle: (p) => h.idle(p) });
    for (const proc of [a, b]) await until(async () => {
      const status = await statusOf(proc);
      return status.includes("\nsign-in: signed in\n") && !status.includes("paused") ? status : undefined;
    }, 20_000, "both roots restarted signed in");
    await Promise.all([a.quit(), b.quit()]);
  });
}

// A service run (#1243): the launcher's run token in the environment and
// BUS_IDENTITY=w-1, no grant store. The harness binds `ingest/w-1` as the
// service under its svc_ client and takes the lease, a DM from another of the
// service's sessions (on a second run token from the same credential) starts
// one turn whose reply goes out as `ingest/w-1`, a subagent (which inherits
// the run token) registers as a child under the root's svc_ session, writes
// as `ingest/w-1` and ends with its run (#1303), /grayboard status names the
// static run and never the token, /grayboard login and logout refuse, and
// nothing offers a sign-in or opens a browser. Revoking the credential then
// ends the run: one notice naming the launcher, and the next tool call
// answers it, with no token request.
export function hostedStaticScenario(h: HostedHarness, dir: string): Promise<void> {
  const SVC = "ingest", NAME = `${SVC}/w-1`, SENDER = `${SVC}/sender`;
  const ended = `grayboard: delivery paused: Signed out of grayboard in ${h.name}; the launcher must start a new run with a fresh run token`;
  const gate = join(dir, "subagent-go");
  let rootSession = "";
  return withHosted(h, dir, [
    onChannelDm(SENDER, (id) => ({ tool: `${h.prefix}dm_send`, args: { to: SENDER, body: "pong", parent_id: id } })),
    scripted("check", [{ tool: `${h.prefix}whoami`, args: {} }]),
    // The subagent sends, then holds its run open (a bash gate) until the scenario has looked at its child row.
    ...h.subagent(dir, "delegate", [
      { tool: `${h.prefix}dm_send`, args: { to: SENDER, body: "from the subagent" } },
      // Bounded: a failed scenario deletes dir and orphans this shell, which must then exit, not spin.
      { tool: "bash", args: { command: `i=0; while [ ! -f '${gate}' ] && [ -d '${dir}' ] && [ $i -lt 1200 ]; do sleep 0.1; i=$((i+1)); done; [ -f '${gate}' ] || { echo 'subagent gate never opened within 120 s' >&2; exit 1; }` } },
    ], () => rootSession),
  ], async ({ srv, start }) => {
    const run = await serviceRun(srv, { admin: "root@example.com" });
    // The service's other session: a cross-account DM stays mail that doesn't wake (#270 open question 7), the service's own wakes.
    const sender = await tokenPeer(srv, dir, await run.mint(), "sender");
    // A browser opened anywhere leaves a mark.
    const opened = join(dir, "opened");
    for (const opener of ["open", "xdg-open"]) writeFileSync(join(dir, "bin", opener), `#!/bin/sh\necho "$@" >> '${opened}'\n`, { mode: 0o755 });
    const tokens = tokenRequests(srv);
    const proc = start({ env: { ...run.env, BUS_IDENTITY: "w-1" } });
    const state = await proc.command({ type: "get_state" }, h.stateTimeout);
    await until(() => leased(srv, run.clientId, state.sessionId, "w-1"), 30_000, `leased as ${NAME}`);

    const { message_id: id } = await sender.call("dm_send", { to: NAME, body: "ping w-1" });
    const reply = await until(() => srv.app.db.query<{ sender: string }, [number]>("SELECT sender FROM messages WHERE parent_id = ? AND body = 'pong'").get(id), 30_000, `pong to DM ${id}`);
    expect(reply.sender).toBe(NAME);
    await h.idle(proc);

    // A subagent of the service run (#1303): it inherits the run token, registers as a child under the root's
    // svc_ session at its first call, writes as the root's name, and ends with its run.
    rootSession = state.sessionId;
    const root = srv.app.db.query<{ session_id: string }, [string, string]>("SELECT session_id FROM hosted_sessions WHERE client_id = ? AND source_session_id = ?").get(run.clientId, state.sessionId)!.session_id;
    await proc.command({ type: "prompt", message: "delegate" });
    const sent = await until(() => srv.app.db.query<{ sender: string }, []>("SELECT sender FROM messages WHERE body = 'from the subagent'").get(), 60_000, "the subagent's DM");
    expect(sent.sender).toBe(NAME);
    const registered = accessAudits(srv.app.db, "hosted.child_registered");
    expect(registered.map((r) => [r.target, r.detail.via])).toEqual([[root, []]]);
    const child = registered[0]!.detail.child as string;
    expect(child).not.toBe(root);
    expect(registered[0]!.detail.source_session_id).not.toBe(state.sessionId);
    const childRow = srv.app.db.query<{ client_id: string; user_id: number; root_session_id: string | null }, [string]>("SELECT client_id, user_id, root_session_id FROM hosted_sessions WHERE session_id = ?").get(child);
    const rootRow = srv.app.db.query<{ user_id: number }, [string]>("SELECT user_id FROM hosted_sessions WHERE session_id = ?").get(root)!;
    expect(childRow).toEqual({ client_id: run.clientId, user_id: rootRow.user_id, root_session_id: root });
    const writes = accessAudits(srv.app.db, "hosted.write").filter((w) => w.detail.tool === "dm_send" && w.target === child);
    expect(writes.map((w) => w.detail)).toEqual([expect.objectContaining({ session: child, root, held: [NAME] })]);
    writeFileSync(gate, "");
    await until(() => accessAudits(srv.app.db, "hosted.child_released").length === 1, 30_000, "the subagent's child ended with its run");
    expect(accessAudits(srv.app.db, "hosted.child_released").map((r) => [r.target, r.detail.child])).toEqual([[root, child]]);
    expect(srv.app.db.query("SELECT 1 FROM hosted_sessions WHERE session_id = ?").get(child)).toBeNull();
    await h.idle(proc);

    const status = await statusOf(proc);
    expect(status).toContain(`\nsign-in: static run token for service ${SVC} (issuer ${srv.issuer})\n`);
    const seen = proc.notices().length;
    await proc.command({ type: "prompt", message: "/grayboard login" });
    await proc.command({ type: "prompt", message: "/grayboard logout" });
    await until(() => proc.notices().length >= seen + 2, 5_000, "login and logout answered");
    expect(proc.notices().slice(seen)).toEqual([
      `grayboard: this run uses a launcher-set run token (static mode): there's no sign-in here; if it stops working, the launcher must start a new run with a fresh run token`,
      "grayboard: this run uses a launcher-set run token: nothing to sign out here; the launcher revokes it",
    ]);

    // The credential's revoke ends the run.
    await run.revoke();
    await until(() => proc.notices().includes(ended), 20_000, "the run-ended notice");
    await proc.command({ type: "prompt", message: "check" });
    const result = await toolResultNamed(proc, `${h.prefix}whoami`);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("the launcher must start a new run with a fresh run token");
    await h.idle(proc);

    expect(proc.notices().filter(n => n.includes("sign in at") || n.includes("sign-in started"))).toEqual([]);
    expect(existsSync(opened)).toBe(false);
    expect(tokens()).toEqual([]);
    expect(proc.notices().join("\n")).not.toContain(run.token);
    expect(proc.stderr).not.toContain(run.token);
    await proc.quit();
    await sender.close();
  }, { admins: ["root@example.com"] });
}
