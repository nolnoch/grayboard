// #807 P3 C9b: the Postgres auth generation's races (c9-scope §3.2; postgres-server.md D5): the write path's own bump
// (0001's gb.auth_touched mark, read by store/pg/tx.ts before COMMIT), outside writes reaching a pod through NOTIFY
// gb_auth, two pods, zero-row and non-auth writes, a fill straddling an outside bump, a dropped LISTEN connection, and a
// COMMIT whose outcome is unknown. Each test has its own database and "pods" (tests/support/pg_auth.ts: a store, its
// generation over a listener the test controls, the auth cache over both). Waits have deadlines that name what they
// waited for; races assert the end state first. The heartbeat, first-LISTEN retry and re-listen ordering rows
// (T-C9-7..9) are C9b2's. Without GRAYBOARD_TEST_PG_URL it skips (tests/support/pg.ts).
import { SQL } from "bun";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { describePg, pgDatabase } from "../../../../tests/support/pg.ts";
import { pgAuthPod, within, type PgAuthPod } from "../../../../tests/support/pg_auth.ts";
import { commitCutProxy } from "../../../../tests/support/pg_proxy.ts";
import { until } from "../../../../tests/support/until.ts";
import { OAUTH_TTL, type OAuthAuthorization } from "../../oauth-types.ts";
import type { Tx } from "../tx_base.ts";
import { AUTH_CHANNEL } from "./auth_generation.ts";
import { pgOf } from "./tx.ts";

const RESOURCE = "https://bus.example.com/mcp";
const MOVE_MS = 2000;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const gate = () => { let open!: () => void; const p = new Promise<void>(r => { open = r; }); return { p, open }; };

const seed = async (pod: PgAuthPod, email: string) => (await pod.tx.write(tx => pod.identity.users.upsertByEmail(tx, email, null))).id;

// An access token for userId through consent and redemption; returns its hash.
let serial = 0;
async function issue(pod: PgAuthPod, userId: number): Promise<string> {
  const start = Date.now(), n = ++serial;
  const binding: OAuthAuthorization = { clientId: "native", resource: RESOURCE, scopes: ["grayboard:tools"], redirectUri: "http://127.0.0.1/callback", codeChallenge: "A".repeat(43) };
  const request = { ...binding, requestHash: sha(`request${n}`), browserHash: sha(`browser${n}`), csrfHash: sha(`csrf${n}`), stateHash: sha(`state${n}`), consentSessionHash: null, createdAt: start, expiresAt: start + OAUTH_TTL.request };
  const code = { ...binding, userId, codeHash: sha(`code${n}`), createdAt: start, expiresAt: start + OAUTH_TTL.code };
  const sessionHash = sha(`browser-session${n}`);
  const tokens = { ...binding, accessHash: sha(`access${n}`), refreshHash: sha(`refresh${n}`), accessExpiresAt: start + OAUTH_TTL.access, refreshExpiresAt: start + OAUTH_TTL.refresh };
  const o = pod.oauth;
  await pod.tx.write(async tx => {
    expect((await o.createBrowserSession(tx, { sessionHash, userId, createdAt: start, expiresAt: start + OAUTH_TTL.browser }, start)).status).toBe("ok");
    expect((await o.createRequest(tx, request, start)).status).toBe("ok");
    expect((await o.bindRequestSession(tx, request.requestHash, request.browserHash, sessionHash, start)).status).toBe("ok");
    expect((await o.decideRequest(tx, { requestHash: request.requestHash, browserHash: request.browserHash, csrfHash: request.csrfHash, sessionHash, approve: true, code }, start)).status).toBe("ok");
    expect((await o.redeemCode(tx, { ...binding, codeHash: code.codeHash, grantId: `grant_${n.toString(16).padStart(16, "0")}`, grantExpiresAt: start + OAUTH_TTL.grant, tokens }, start)).status).toBe("ok");
  });
  return tokens.accessHash;
}

// Holds a write body on `pod` open until release(); `wrote` resolves once the body holds the queue.
function hold(pod: PgAuthPod) {
  const g = gate(), wrote = gate();
  const done = pod.tx.write(async () => { wrote.open(); await g.p; });
  return { wrote: wrote.p, release: g.open, done };
}

async function capturingErrors<T>(fn: () => Promise<T>): Promise<{ value: T; logged: unknown[][] }> {
  const logged: unknown[][] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  try { return { value: await fn(), logged }; } finally { console.error = error; }
}

const moved = (pod: PgAuthPod, from: string | undefined, what: string) =>
  until(() => { const g = pod.auth.authGeneration(); return g !== undefined && g !== from; }, MOVE_MS, `pod ${pod.name}'s generation to move past ${from} after ${what}`);

describePg("Postgres auth generation", () => {
  // One database and pods on it, closed in reverse.
  const withPods = (name: string, n: number, fn: (db: Awaited<ReturnType<typeof pgDatabase>>, ...pods: PgAuthPod[]) => Promise<void>, timeout?: number) => test(name, async () => {
    await using db = await pgDatabase({ max: 3 });
    const pods: PgAuthPod[] = [];
    try {
      for (const p of ["a", "b"].slice(0, n)) pods.push(await pgAuthPod(db, p));
      await fn(db, ...pods);
    } finally { for (const p of pods.reverse()) await p.close(); }
  }, timeout);

  // 0001's triggers: four per auth table, the three row events through a transition table, TRUNCATE without one.
  withPods("the auth tables carry statement triggers with transition tables for INSERT, UPDATE and DELETE, and one for TRUNCATE", 0, async db => {
    const rows = await db.sql`SELECT c.relname, t.tgname, pg_get_triggerdef(t.oid) AS def FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal ORDER BY c.relname, t.tgname`;
    const want = (t: string) => [
      `CREATE TRIGGER ${t}_auth_del AFTER DELETE ON public.${t} REFERENCING OLD TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION gb_auth_rows_touched()`,
      `CREATE TRIGGER ${t}_auth_ins AFTER INSERT ON public.${t} REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION gb_auth_rows_touched()`,
      `CREATE TRIGGER ${t}_auth_trunc AFTER TRUNCATE ON public.${t} FOR EACH STATEMENT EXECUTE FUNCTION gb_auth_touched()`,
      `CREATE TRIGGER ${t}_auth_upd AFTER UPDATE ON public.${t} REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION gb_auth_rows_touched()`,
    ];
    expect(rows.map((r: { def: string }) => r.def)).toEqual([...want("oauth_grants"), ...want("oauth_tokens"), ...want("users")]);
  });

  // settle() and seen() (tests/support/pg_auth.ts) end only on their own marker: an earlier notification, delivered
  // first and on its own, leaves them waiting.
  withPods("the harness: settle() waits for its own marker, not a notification delivered before it", 1, async (db, a) => {
    const u = await seed(a, "u0@example.com");
    await a.settle();
    const g0 = a.auth.authGeneration();
    a.listener.queueing = true;
    let resolved = false;
    let settled: Promise<void>;
    try {
      await db.sql`UPDATE users SET display_name = 'x' WHERE id = ${u}`;
      settled = a.settle().then(() => { resolved = true; });
      await until(() => a.listener.queued.length === 2, MOVE_MS, "the outside write's notification and the settle marker to be queued");
      a.listener.deliver(1);
      await new Promise(r => setTimeout(r, 0));
      expect(a.auth.authGeneration()).not.toBe(g0);
      expect(resolved).toBe(false);
    } finally { a.listener.queueing = false; a.listener.deliver(); }
    await settled;
    expect(resolved).toBe(true);
  });

  withPods("T-C9-1 own write: the generation moves, and the disable is refused, inside `committed` and while the queue's next body holds", 1, async (_db, a) => {
    const u = await seed(a, "u1@example.com");
    const t = await issue(a, u);
    await a.settle();
    const now = Date.now();
    expect(await a.auth.isDisabled(a.tx.read, u)).toBe(false); // cached
    expect(await a.auth.findActiveAccess(a.tx.read, t, RESOURCE, [], now)).toBeDefined(); // cached
    const g0 = a.auth.authGeneration();
    // Deaf: only the write path's own bump can move the generation, not the disable's NOTIFY.
    a.listener.deaf = true;
    const disabled = a.tx.write(tx => a.identity.users.setDisabled(tx, u, true), async () => {
      const g = a.auth.authGeneration();
      return { g, disabled: await a.auth.isDisabled(a.tx.read, u), token: await a.auth.findActiveAccess(a.tx.read, t, RESOURCE, [], now) };
    });
    const next = hold(a);
    await within(next.wrote, MOVE_MS, "the queue's next body to start");
    let during: { g: string | undefined; disabled: boolean };
    try {
      during = { g: a.auth.authGeneration(), disabled: await a.auth.isDisabled(a.tx.read, u) };
    } finally { next.release(); }
    const inCommitted = await disabled;
    await next.done;
    expect(inCommitted.disabled).toBe(true);
    expect(inCommitted.token).toBeUndefined();
    expect(during.disabled).toBe(true);
    expect(inCommitted.g).toBeDefined();
    expect(inCommitted.g).not.toBe(g0);
    expect(during.g).not.toBe(g0);
  });

  withPods("T-C9-2 an outside INSERT, UPDATE or DELETE on each auth table, and a TRUNCATE, moves the pod's generation; its next check reads afresh", 1, async (db, a) => {
    const u = await seed(a, "u2@example.com");
    const t = await issue(a, u);
    const far = Date.now() + OAUTH_TTL.grant;
    const sql = db.sql;
    const cases: [string, () => Promise<{ count: number }>][] = [
      ["users INSERT", () => sql`INSERT INTO users (email, created_at) VALUES ('z@example.com', 0)`],
      ["users UPDATE", () => sql`UPDATE users SET display_name = 'Z' WHERE email = 'z@example.com'`],
      ["users DELETE", () => sql`DELETE FROM users WHERE email = 'z@example.com'`],
      ["oauth_grants INSERT", () => sql`INSERT INTO oauth_grants (id, user_id, expires_at, data) VALUES ('grant_scratch', ${u}, ${far}, '{}'::jsonb)`],
      ["oauth_tokens INSERT", () => sql`INSERT INTO oauth_tokens (hash, grant_id, kind, expires_at, created_at) VALUES ('scratch', 'grant_scratch', 'refresh', ${far}, 0)`],
      ["oauth_tokens UPDATE", () => sql`UPDATE oauth_tokens SET revoked_at = 1 WHERE hash = 'scratch'`],
      ["oauth_tokens DELETE", () => sql`DELETE FROM oauth_tokens WHERE hash = 'scratch'`],
      ["oauth_grants UPDATE", () => sql`UPDATE oauth_grants SET revoked_at = 1 WHERE id = 'grant_scratch'`],
      // No token or code left under it: no cascade fires another table's trigger.
      ["oauth_grants DELETE", () => sql`DELETE FROM oauth_grants WHERE id = 'grant_scratch'`],
      ["oauth_tokens TRUNCATE", async () => { await sql`TRUNCATE oauth_tokens`; return { count: 1 }; }],
    ];
    const ran: string[] = [];
    for (const [what, run] of cases) {
      await a.settle();
      const now = Date.now();
      expect(await a.auth.isDisabled(a.tx.read, u)).toBe(false); // cached under g
      expect(await a.auth.findActiveAccess(a.tx.read, t, RESOURCE, [], now)).toBeDefined();
      const g = a.auth.authGeneration();
      expect(a.auth.authPeek()?.user(u)).toBeDefined();
      expect((await run()).count).toBeGreaterThan(0);
      await moved(a, g, what);
      ran.push(what);
      expect(a.auth.authPeek()?.user(u)).toBeUndefined();
      const reads = a.counts.users;
      expect(await a.auth.isDisabled(a.tx.read, u)).toBe(false);
      expect(a.counts.users).toBe(reads + 1);
    }
    expect(ran).toHaveLength(10);
  });

  withPods("T-C9-3 pod A revokes a token: pod B moves and refuses it, by lookup and by peek", 2, async (_db, a, b) => {
    const u = await seed(a, "u3@example.com");
    const t = await issue(a, u);
    await a.settle();
    await b.settle();
    const now = Date.now();
    expect(await b.auth.findActiveAccess(b.tx.read, t, RESOURCE, [], now)).toBeDefined(); // B caches it
    expect(b.auth.authPeek()?.access(t, RESOURCE, now)).toBeDefined();
    const gB = b.auth.authGeneration();
    await a.tx.write(tx => a.oauth.revokeToken(tx, t, "native", now));
    await moved(b, gB, "pod A's revoke");
    expect(b.auth.authPeek()?.access(t, RESOURCE, now)).toBeUndefined();
    const reads = b.counts.accesses;
    expect(await b.auth.findActiveAccess(b.tx.read, t, RESOURCE, [], now)).toBeUndefined();
    expect(b.counts.accesses).toBe(reads + 1);
  });

  withPods("T-C9-4 zero-row auth statements and non-auth writes move no generation and send no notification", 1, async (db, a) => {
    const u = await seed(a, "u4@example.com");
    await issue(a, u);
    // A probe listener of its own, drained up to a marker.
    const probe = new SQL({ url: db.url, max: 1 });
    try {
      const got: string[] = [];
      const sub = await probe.listen(AUTH_CHANNEL, p => { got.push(p); });
      const drain = async (what: string) => {
        const m = `test:probe:${++serial}`;
        await db.sql.notify(AUTH_CHANNEL, m);
        await until(() => got.includes(m), MOVE_MS, `the probe listener to receive ${m} (${what})`);
        // The pod's settle markers reach the probe too; anything else is a trigger's.
        return got.splice(0).filter(p => !p.startsWith("test:"));
      };
      await drain("after the seed");
      await a.settle();
      expect(await a.auth.isDisabled(a.tx.read, u)).toBe(false);
      const g0 = a.auth.authGeneration();
      // The OAuth cleanup with nothing expired: DELETEs on oauth_tokens and oauth_grants that match no row.
      await a.tx.write(tx => a.oauth.cleanup(tx, Date.now()));
      await a.tx.write(async (tx: Tx) => {
        const sql = pgOf(tx);
        await sql`INSERT INTO users (email, created_at) SELECT 'none@example.com', 0 WHERE false`;
        await sql`UPDATE users SET display_name = 'x' WHERE id = -1`;
        await sql`DELETE FROM oauth_tokens WHERE hash = 'none'`;
      });
      await a.tx.write(tx => a.cursors.advance(tx, "a@example.com/fe", "direct", "a@example.com/fe", 1));
      expect(await drain("after the writes")).toEqual([]);
      await a.settle();
      expect(a.auth.authGeneration()).toBe(g0);
      const reads = a.counts.users;
      expect(await a.auth.isDisabled(a.tx.read, u)).toBe(false);
      expect(a.counts.users).toBe(reads);
      await sub.unlisten();
    } finally { await probe.close(); }
  });

  withPods("T-C9-5 a user read that straddles an outside disable answers as read but caches nothing; the next lookup refuses", 1, async (db, a) => {
    const u = await seed(a, "u5@example.com");
    await a.settle();
    const reached = gate(), release = gate();
    a.afterUserRead = async () => { a.afterUserRead = undefined; reached.open(); await release.p; };
    const g0 = a.auth.authGeneration();
    const look = a.auth.isDisabled(a.tx.read, u);
    let answered: boolean;
    try {
      await within(reached.p, MOVE_MS, "pod A's user read to be held");
      await db.sql`UPDATE users SET disabled_at = ${Date.now()} WHERE id = ${u}`;
      await (await a.listener.marker(db.sql))("the outside disable's notification");
      expect(a.auth.authGeneration()).not.toBe(g0);
    } finally {
      release.open();
      answered = await look;
    }
    expect(answered).toBe(false); // read before the disable: linearized before it
    expect(a.auth.authPeek()?.user(u)).toBeUndefined(); // and not cached
    const reads = a.counts.users;
    expect(await a.auth.isDisabled(a.tx.read, u)).toBe(true);
    expect(a.counts.users).toBe(reads + 1);
  });

  withPods("T-C9-6 a dropped LISTEN connection: off from onclose until the next LISTEN, uncached meanwhile; a write whose notification was lost is refused after", 1, async (db, a) => {
    const u = await seed(a, "u6@example.com");
    await a.settle();
    expect(await a.auth.isDisabled(a.tx.read, u)).toBe(false); // cached
    const g0 = a.auth.authGeneration();
    // A disable whose notification is lost: replica mode skips the triggers, so no NOTIFY at all.
    await db.sql.begin(async t => {
      await t`SET LOCAL session_replication_role = replica`;
      await t`UPDATE users SET disabled_at = ${Date.now()} WHERE id = ${u}`;
    });
    await a.settle();
    expect(a.auth.authGeneration()).toBe(g0);
    expect(await a.auth.isDisabled(a.tx.read, u)).toBe(false); // the stale entry: nothing told the pod
    const atClose: (string | undefined)[] = [];
    a.listener.onClosed = () => { atClose.push(a.gen.read()); };
    a.listener.holdingListen = true;
    const listens = a.listener.listens;
    await db.sql`SELECT pg_terminate_backend(${await a.listenerPid()})`;
    try {
      await until(() => a.listener.heldListen, 3000, "pod A's listener to reconnect and its LISTEN to be acknowledged");
      expect(atClose).toEqual([undefined]);
      expect(a.auth.authGeneration()).toBeUndefined();
      expect(a.auth.authPeek()).toBeUndefined();
      const reads = a.counts.users;
      expect(await a.auth.isDisabled(a.tx.read, u)).toBe(true);
      expect(await a.auth.isDisabled(a.tx.read, u)).toBe(true);
      expect(a.counts.users).toBe(reads + 2); // uncached while off
    } finally { a.listener.holdingListen = false; a.listener.releaseListen(); }
    expect(a.listener.listens).toBe(listens + 1);
    const g1 = a.auth.authGeneration();
    expect(g1).toBeDefined();
    expect(g1).not.toBe(g0);
    expect(await a.auth.isDisabled(a.tx.read, u)).toBe(true);
  });

  for (const mode of ["dropped", "ack lost"] as const) test(`T-C9-10 COMMIT ${mode} on a body that wrote users: the generation moves anyway`, async () => {
    await using db = await pgDatabase({ max: 3 });
    const proxy = commitCutProxy(db.url, mode);
    const a = await pgAuthPod(db, "a", { txUrl: proxy.url });
    try {
      const u = await seed(a, "u10@example.com");
      await a.settle();
      expect(await a.auth.isDisabled(a.tx.read, u)).toBe(false);
      const g0 = a.auth.authGeneration();
      a.listener.deaf = true; // only the write path's bump counts
      const { value: e, logged } = await capturingErrors(() => within(a.tx.write(async tx => {
        await pgOf(tx)`UPDATE users SET disabled_at = ${Date.now()} WHERE id = ${u}`;
        proxy.arm();
      }).then(() => undefined, (error: any) => error), 10000, "the in-doubt write to settle"));
      expect(e?.code).toBe("ERR_POSTGRES_CONNECTION_CLOSED");
      expect(logged).toEqual([["[grayboard] commit outcome unknown:", { class: "PostgresError", code: "ERR_POSTGRES_CONNECTION_CLOSED" }]]);
      const g1 = a.auth.authGeneration();
      expect(g1).toBeDefined();
      expect(g1).not.toBe(g0);
    } finally {
      await a.close();
      proxy.stop();
    }
  }, 30000);
});
