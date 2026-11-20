// #807 P3 C9b: the Postgres auth generation's races (c9-scope §3.2; postgres-server.md D5): the write path's own bump
// (0001's gb.auth_touched mark, read by store/pg/tx.ts before COMMIT), outside writes reaching a pod through NOTIFY
// gb_auth, two pods, zero-row and non-auth writes, a fill straddling an outside bump, a dropped LISTEN connection, and a
// COMMIT whose outcome is unknown, a silently dead listener (the heartbeat), a first LISTEN that fails (the retry) and
// re-listen ordering. Each test has its own database and "pods" (tests/support/pg_auth.ts: a store, its generation over
// a listener the test controls, the auth cache over both; the heartbeat and retry on timers the test drives, unless a
// row says real ones). Waits have deadlines that name what they waited for; races assert the end state first. Without
// GRAYBOARD_TEST_PG_URL it skips (tests/support/pg.ts).
import { SQL } from "bun";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { describePg, pgDatabase } from "../../../../tests/support/pg.ts";
import { pgAuthPod, within, type PgAuthPod } from "../../../../tests/support/pg_auth.ts";
import { commitCutProxy } from "../../../../tests/support/pg_proxy.ts";
import { until } from "../../../../tests/support/until.ts";
import { OAUTH_SCOPES } from "../../oauth-config.ts";
import { OAUTH_TTL, type OAuthAuthorization, type ServiceTokenLimits } from "../../oauth-types.ts";
import type { Tx } from "../tx_base.ts";
import { AUTH_CHANNEL, RETRY_FIRST_MS, RETRY_MAX_MS, realTimers } from "./auth_generation.ts";
import { pgOf } from "./tx.ts";

const RESOURCE = "https://bus.example.com/mcp";
const MOVE_MS = 2000;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
// Every pending microtask (a rejection's handlers among them) has run once this resolves: setImmediate runs after them.
const flush = () => new Promise<void>(r => setImmediate(r));
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

// A service with a credential and `secrets` live secrets on `pod`; returns the secret IDs.
const SVC = `svc_${"a".repeat(32)}`;
const LIMITS: ServiceTokenLimits = { maxSeconds: 600, mintsPerMinute: 100, unexpired: 100 };
async function service(pod: PgAuthPod, now: number, secrets: number): Promise<number[]> {
  return pod.tx.write(async tx => {
    const svc = await pod.identity.services.create(tx, "ingest");
    const r = await pod.oauth.addServiceCredential(tx, { userId: svc.id, clientId: SVC, grantId: "svcgrant_0123456789", resource: RESOURCE, source: "generic",
      tokenSeconds: 3600, expiresAt: now + OAUTH_TTL.grant, secretHash: sha("secret-1") }, now);
    if (r.status !== "ok") throw new Error(`addServiceCredential answered ${r.status}`);
    const ids = [r.value.secretId];
    for (let i = 2; i <= secrets; i++) {
      const s = await pod.oauth.rotateServiceCredential(tx, { clientId: SVC, secretHash: sha(`secret-${i}`) }, now);
      if (s.status !== "ok") throw new Error(`rotateServiceCredential answered ${s.status}`);
      ids.push(s.value.secretId);
    }
    return ids;
  });
}
const mint = (pod: PgAuthPod, tx: Tx, secretId: number, tokenHash: string, now: number) =>
  pod.oauth.mintServiceToken(tx, { clientId: SVC, secretId, tokenHash, scopes: [...OAUTH_SCOPES], limits: LIMITS }, now);

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

// The production clocks don't keep the process alive: each handle they create is unref'd.
test("the real heartbeat and retry timers are unref'd", () => {
  const handles: Timer[] = [];
  const { setInterval: si, setTimeout: st } = globalThis;
  globalThis.setInterval = ((...args: Parameters<typeof si>) => { const t = si(...args); handles.push(t); return t; }) as typeof si;
  globalThis.setTimeout = ((...args: Parameters<typeof st>) => { const t = st(...args); handles.push(t); return t; }) as typeof st;
  let cancels: (() => void)[];
  try { cancels = [realTimers.every(60_000, () => {}), realTimers.after(60_000, () => {})]; }
  finally { globalThis.setInterval = si; globalThis.setTimeout = st; }
  try {
    expect(handles).toHaveLength(2);
    expect(handles.map(h => h.hasRef())).toEqual([false, false]);
  } finally { for (const c of cancels) c(); }
});

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

  // 0001's triggers: four per auth table, the three row events through a transition table, TRUNCATE without one, each
  // ENABLE ALWAYS ('A': it fires under session_replication_role = replica too).
  withPods("the auth tables carry ENABLE ALWAYS statement triggers with transition tables for INSERT, UPDATE and DELETE, and one for TRUNCATE", 0, async db => {
    const rows = await db.sql`SELECT c.relname, t.tgname, t.tgenabled::text AS enabled, pg_get_triggerdef(t.oid) AS def FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND t.tgname LIKE ${"%\\_auth\\_%"} ORDER BY c.relname, t.tgname`;
    const want = (t: string) => [
      `CREATE TRIGGER ${t}_auth_del AFTER DELETE ON public.${t} REFERENCING OLD TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION gb_auth_rows_touched()`,
      `CREATE TRIGGER ${t}_auth_ins AFTER INSERT ON public.${t} REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION gb_auth_rows_touched()`,
      `CREATE TRIGGER ${t}_auth_trunc AFTER TRUNCATE ON public.${t} FOR EACH STATEMENT EXECUTE FUNCTION gb_auth_touched()`,
      `CREATE TRIGGER ${t}_auth_upd AFTER UPDATE ON public.${t} REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION gb_auth_rows_touched()`,
    ];
    expect(rows.map((r: { def: string }) => r.def)).toEqual(["oauth_grants", "oauth_tokens", "principals", "service_credential_secrets", "service_credentials", "users"].flatMap(want));
    expect(rows.map((r: { enabled: string }) => r.enabled)).toEqual(Array(24).fill("A"));
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

  withPods("T-C9-1 own write: the generation moves, and the disable is refused, inside an afterCommit effect, inside `committed` and while the queue's next body holds", 1, async (_db, a) => {
    const u = await seed(a, "u1@example.com");
    const t = await issue(a, u);
    await a.settle();
    const now = Date.now();
    expect(await a.auth.isDisabled(a.tx.read, u)).toBe(false); // cached
    expect(await a.auth.findActiveAccess(a.tx.read, t, RESOURCE, [], now)).toBeDefined(); // cached
    const g0 = a.auth.authGeneration();
    // Deaf: only the write path's own bump can move the generation, not the disable's NOTIFY.
    a.listener.deaf = true;
    // The effect records the generation, and the generation isDisabled reads synchronously (its cache lookup) before
    // its first await: the bump must come before the effects, not only before `committed`.
    const effect: { g?: string; firstRead: (string | undefined)[]; disabled?: Promise<boolean> } = { firstRead: [] };
    const disabled = a.tx.write(async tx => {
      tx.afterCommit(() => {
        effect.g = a.auth.authGeneration();
        const read = a.gen.read;
        a.gen.read = () => { const v = read(); effect.firstRead.push(v); return v; };
        try { effect.disabled = a.auth.isDisabled(a.tx.read, u); } finally { a.gen.read = read; }
      });
      await a.identity.users.setDisabled(tx, u, true);
    }, async () => {
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
    expect(await within(effect.disabled!, MOVE_MS, "the effect's isDisabled")).toBe(true);
    expect(effect.g).toBeDefined();
    expect(effect.g).not.toBe(g0);
    expect(effect.firstRead[0]).toBeDefined();
    expect(effect.firstRead[0]).not.toBe(g0);
    expect(inCommitted.disabled).toBe(true);
    expect(inCommitted.token).toBeUndefined();
    expect(during.disabled).toBe(true);
    expect(inCommitted.g).toBeDefined();
    expect(inCommitted.g).not.toBe(g0);
    expect(during.g).not.toBe(g0);
  });

  withPods("T-C9-2 an outside INSERT, UPDATE or DELETE on each auth table, a TRUNCATE, and a replica-mode write moves the pod's generation; its next check reads afresh", 1, async (db, a) => {
    const u = await seed(a, "u2@example.com");
    const t = await issue(a, u);
    const far = Date.now() + OAUTH_TTL.grant;
    const sql = db.sql;
    const cases: [string, () => Promise<{ count: number }>][] = [
      ["users INSERT", () => sql`INSERT INTO users (email, created_at) VALUES ('z@example.com', 0)`],
      ["users UPDATE", () => sql`UPDATE users SET display_name = 'Z' WHERE email = 'z@example.com'`],
      ["users DELETE", () => sql`DELETE FROM users WHERE email = 'z@example.com'`],
      ["oauth_grants INSERT", () => sql`INSERT INTO oauth_grants (id, user_id, expires_at, data) VALUES ('grant_scratch', ${u}, ${far}, '{}'::jsonb)`],
      // A service credential under it, for the secrets.
      ["service_credentials INSERT", () => sql`INSERT INTO service_credentials (client_id, user_id, grant_id, source, token_seconds, created_at) VALUES ('scratch', ${u}, 'grant_scratch', 'generic', 60, 0)`],
      ["service_credentials UPDATE", () => sql`UPDATE service_credentials SET source = 'opencode' WHERE client_id = 'scratch'`],
      ["service_credential_secrets INSERT", () => sql`INSERT INTO service_credential_secrets (credential_id, hash, created_at)
        SELECT id, 'scratch-secret', 0 FROM service_credentials WHERE client_id = 'scratch'`],
      ["service_credential_secrets UPDATE", () => sql`UPDATE service_credential_secrets SET revoked_at = 1 WHERE hash = 'scratch-secret'`],
      // No token under it: no cascade fires oauth_tokens' trigger.
      ["service_credential_secrets DELETE", () => sql`DELETE FROM service_credential_secrets WHERE hash = 'scratch-secret'`],
      // No secret left under it: no cascade fires the secrets' trigger.
      ["service_credentials DELETE", () => sql`DELETE FROM service_credentials WHERE client_id = 'scratch'`],
      ["principals INSERT", () => sql`INSERT INTO principals (kind, name, user_id, created_at) VALUES ('service', 'scratch-svc', ${u}, 0)`],
      ["principals UPDATE", () => sql`UPDATE principals SET name = 'scratch-svc2' WHERE name = 'scratch-svc'`],
      ["principals DELETE", () => sql`DELETE FROM principals WHERE name = 'scratch-svc2'`],
      ["oauth_tokens INSERT", () => sql`INSERT INTO oauth_tokens (hash, grant_id, kind, expires_at, created_at) VALUES ('scratch', 'grant_scratch', 'refresh', ${far}, 0)`],
      ["oauth_tokens UPDATE", () => sql`UPDATE oauth_tokens SET revoked_at = 1 WHERE hash = 'scratch'`],
      ["oauth_tokens DELETE", () => sql`DELETE FROM oauth_tokens WHERE hash = 'scratch'`],
      ["oauth_grants UPDATE", () => sql`UPDATE oauth_grants SET revoked_at = 1 WHERE id = 'grant_scratch'`],
      // No token or code left under it: no cascade fires another table's trigger.
      ["oauth_grants DELETE", () => sql`DELETE FROM oauth_grants WHERE id = 'grant_scratch'`],
      // A restore or replication apply: ENABLE ALWAYS triggers fire in replica mode too.
      ["users UPDATE under session_replication_role = replica", () => sql.begin(async t => {
        await t`SET LOCAL session_replication_role = replica`;
        const r = await t`UPDATE users SET display_name = 'R' WHERE id = ${u}`;
        return { count: r.count };
      })],
      // Last: it removes the token each case checks.
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
    expect(ran).toHaveLength(cases.length);
    expect(ran).toHaveLength(20);
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
    const reached = gate(), release = gate(), looked = gate();
    a.afterUserRead = async () => { a.afterUserRead = undefined; reached.open(); await release.p; };
    const g0 = a.auth.authGeneration();
    // A body pinned at g0, before the disable, peeks once the read has answered: a fill under g0 (the read's own
    // generation, no longer current) would show here; under the new generation it couldn't have been filled at all.
    const atG0 = a.auth.authRead(async () => { await looked.p; const p = a.auth.authPeek(); return { g: p?.generation, user: p?.user(u) }; });
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
      looked.open();
    }
    expect(answered).toBe(false); // read before the disable: linearized before it
    const peek = await within(atG0, MOVE_MS, "the body pinned at g0 to peek");
    expect(peek.g).toBe(g0);
    expect(peek.user).toBeUndefined(); // and not cached under the generation it read at
    const reads = a.counts.users;
    expect(await a.auth.isDisabled(a.tx.read, u)).toBe(true);
    expect(a.counts.users).toBe(reads + 1);
  });

  withPods("T-C9-6 a dropped LISTEN connection: off from onclose until the next LISTEN, uncached meanwhile; a write whose notification was lost is refused after", 1, async (db, a) => {
    const u = await seed(a, "u6@example.com");
    await a.settle();
    expect(await a.auth.isDisabled(a.tx.read, u)).toBe(false); // cached
    const g0 = a.auth.authGeneration();
    // A disable whose notification is lost: the listener drops it (deaf); markers still pass.
    a.listener.deaf = true;
    try {
      await db.sql`UPDATE users SET disabled_at = ${Date.now()} WHERE id = ${u}`;
      await a.settle();
    } finally { a.listener.deaf = false; }
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

  // The secret join is all that refuses a run token minted while its secret's revoke ran (store/pg/oauth.ts
  // revokeServiceSecret, D3): the revoke's token UPDATE can't see the uncommitted mint and matches no row, so only
  // service_credential_secrets' trigger tells pod A the token it cached is dead.
  withPods("T-C9-11 a run token pod A minted while pod B revoked its secret, cached on A between the commits, is refused from A's cache once B commits", 2, async (_db, a, b) => {
    const now = Date.now();
    const [s1] = await service(a, now, 2);
    await a.settle();
    await b.settle();
    const t = sha("run-token");
    const mintIn = gate(), mintGo = gate(), revokeIn = gate(), revokeGo = gate();
    const minted = a.tx.write(async tx => { const r = await mint(a, tx, s1!, t, now); mintIn.open(); await mintGo.p; return r.status; });
    let revoked: Promise<string> | undefined;
    try {
      await within(mintIn.p, MOVE_MS, "pod A's mint to insert its token, uncommitted");
      revoked = b.tx.write(async tx => { const r = await b.oauth.revokeServiceSecret(tx, s1!, now); revokeIn.open(); await revokeGo.p; return r.status; });
      await within(revokeIn.p, MOVE_MS, "pod B's revoke to update the secret (and match no token), uncommitted");
      mintGo.open();
      expect(await minted).toBe("ok");
      await a.settle();
      expect(await a.auth.findActiveAccess(a.tx.read, t, RESOURCE, [], now)).toBeDefined(); // B's revoke not yet committed
      expect(a.auth.authPeek()?.access(t, RESOURCE, now)).toBeDefined(); // cached
    } finally {
      mintGo.open();
      revokeGo.open();
    }
    const gA = a.auth.authGeneration();
    expect(await revoked).toBe("ok");
    await a.settle();
    expect(await a.oauth.findActiveAccess(a.tx.read, t, RESOURCE, [], now)).toBeUndefined(); // the database refuses it
    expect(a.auth.authGeneration()).not.toBe(gA);
    expect(a.auth.authPeek()?.access(t, RESOURCE, now)).toBeUndefined();
    expect(await a.auth.findActiveAccess(a.tx.read, t, RESOURCE, [], now)).toBeUndefined();
  });

  withPods("T-C9-12 an outside UPDATE of a service secret's revoked_at refuses the run token a pod cached under it", 1, async (db, a) => {
    const now = Date.now();
    const [s1] = await service(a, now, 1);
    const t = sha("run-token-outside");
    expect((await a.tx.write(tx => mint(a, tx, s1!, t, now))).status).toBe("ok");
    await a.settle();
    expect(await a.auth.findActiveAccess(a.tx.read, t, RESOURCE, [], now)).toBeDefined();
    expect(a.auth.authPeek()?.access(t, RESOURCE, now)).toBeDefined(); // cached
    const g = a.auth.authGeneration();
    expect((await db.sql`UPDATE service_credential_secrets SET revoked_at = ${now} WHERE id = ${s1!}`).count).toBe(1);
    await moved(a, g, "the outside secret revoke");
    expect(a.auth.authPeek()?.access(t, RESOURCE, now)).toBeUndefined();
    const reads = a.counts.accesses;
    expect(await a.auth.findActiveAccess(a.tx.read, t, RESOURCE, [], now)).toBeUndefined();
    expect(a.counts.accesses).toBe(reads + 1);
  });

  // The heartbeat (c9-scope §2.4): every tick checks the last ping arrived, then sends the next through the store's pool.
  const on = (pod: PgAuthPod, what: string) =>
    until(() => pod.gen.read() !== undefined, MOVE_MS, `pod ${pod.name}'s auth cache to turn on again after ${what}`);
  // The heartbeat the last tick sent has been handled (or dropped) by the pod's listener: its send settled (so the ping
  // committed before the marker below) and a marker sent after it arrived.
  const pinged = async (pod: PgAuthPod, db: { sql: SQL }) => {
    await until(() => pod.sent.length > 0, MOVE_MS, `pod ${pod.name}'s heartbeat to be sent`);
    await within(pod.lastSend!, MOVE_MS, `pod ${pod.name}'s heartbeat ${pod.sent.at(-1)} send to settle`);
    await (await pod.listener.marker(db.sql))(`pod ${pod.name}'s heartbeat ${pod.sent.at(-1)} to be handled`);
  };

  withPods("T-C9-7 a silently dead listener: a ping missing at the next tick turns the cache off and replaces the instance, which turns it on with a bump; the old instance's callbacks change nothing", 1, async (db, a) => {
    const timers = a.timers!;
    const u = await seed(a, "u7@example.com");
    await a.settle();
    expect(await a.auth.isDisabled(a.tx.read, u)).toBe(false); // cached
    const g0 = a.auth.authGeneration()!;
    const [old] = a.listener.instances;
    // The old connection stops delivering (a hung backend: no FIN, no event). A disable committed now is lost to it.
    old!.deaf = true;
    await db.sql`UPDATE users SET disabled_at = ${Date.now()} WHERE id = ${u}`;
    timers.tick();
    await pinged(a, db);
    // One tick with the ping outstanding: still on, the stale entry still answers (the 2H window).
    expect(a.auth.authGeneration()).toBe(g0);
    expect(await a.auth.isDisabled(a.tx.read, u)).toBe(false);
    const listens = a.listener.listens;
    timers.tick();
    // At the second tick the ping never arrived: off at once, the old instance closed, a new one opened.
    expect(a.auth.authGeneration()).toBeUndefined();
    expect(a.listener.instances).toHaveLength(2);
    expect(old!.closed).toBe(true);
    await on(a, "the replacement's LISTEN");
    expect(a.listener.listens).toBe(listens + 1);
    const g1 = a.auth.authGeneration()!;
    expect(Number(g1)).toBeGreaterThan(Number(g0));
    // The old backend is gone: exactly one listener backend.
    await a.listenerPid();
    // The disable the old instance lost is refused now.
    expect(a.auth.authPeek()?.user(u)).toBeUndefined();
    expect(await a.auth.isDisabled(a.tx.read, u)).toBe(true);
    // The old instance's callbacks, after the new one is on: none moves the generation or turns the cache off.
    const g2 = a.auth.authGeneration();
    old!.onnotify!("");
    expect(a.auth.authGeneration()).toBe(g2);
    old!.onlisten!();
    expect(a.auth.authGeneration()).toBe(g2);
    old!.onclose(new Error("test: the old instance's late close"));
    expect(a.auth.authGeneration()).toBe(g2);
    // Nor does an old instance's copy of the outstanding ping clear it: with the new instance deaf, the next tick
    // finds it missing.
    const [, current] = a.listener.instances;
    current!.deaf = true;
    timers.tick();
    await pinged(a, db);
    old!.onnotify!(a.sent.at(-1)!);
    expect(a.auth.authGeneration()).toBe(g2);
    timers.tick();
    expect(a.auth.authGeneration()).toBeUndefined();
    expect(a.listener.instances).toHaveLength(3);
    await on(a, "the second replacement's LISTEN");
  });

  withPods("the heartbeat: a ping that arrives keeps the cache on and never bumps; another pod's ping and a stale one of its own neither bump nor clear the outstanding one; close() turns the cache off and closes the listener", 1, async (db, a) => {
    const timers = a.timers!;
    await a.settle();
    const g0 = a.auth.authGeneration();
    for (let k = 1; k <= 3; k++) {
      timers.tick();
      await until(() => a.listener.heartbeats === k, MOVE_MS, `pod a's heartbeat ${k} to arrive`);
      expect(a.auth.authGeneration()).toBe(g0);
    }
    expect(new Set(a.sent).size).toBe(3);
    expect(a.sent.every(p => p.startsWith("hb:"))).toBe(true);
    // Ping 4 is lost (only it: the listener drops this pod's newest ping). Another pod's ping and this pod's stale ping
    // 3 arrive while it's outstanding: neither bumps, and neither clears it, so the next tick finds it missing.
    const [first] = a.listener.instances;
    first!.drop = p => p === a.sent.at(-1);
    timers.tick();
    await pinged(a, db);
    expect(a.sent).toHaveLength(4);
    await db.sql.notify(AUTH_CHANNEL, "hb:another-pod:1");
    await db.sql.notify(AUTH_CHANNEL, a.sent[2]!);
    await a.settle();
    expect(a.listener.heartbeats).toBe(5);
    expect(a.auth.authGeneration()).toBe(g0);
    expect(a.listener.instances).toHaveLength(1);
    await capturingErrors(async () => { timers.tick(); });
    expect(a.auth.authGeneration()).toBeUndefined();
    expect(a.listener.instances).toHaveLength(2);
    expect(first!.closed).toBe(true);
    await on(a, "the replacement's LISTEN");
    // close() on a live, acknowledged instance: the cache off and that instance closed.
    const current = a.listener.instances[1]!;
    expect(current.closed).toBe(false);
    await a.gen.close();
    expect(a.gen.read()).toBeUndefined();
    expect(current.closed).toBe(true);
  });

  withPods("the heartbeat: a send that fails after the next tick already replaced the instance changes nothing", 1, async (db, a) => {
    const timers = a.timers!;
    await a.settle();
    // Ping 1's send hangs (a pool wait), so tick 2 finds it missing and replaces the instance.
    a.holdSends = true;
    await capturingErrors(async () => {
      timers.tick();
      timers.tick();
      await on(a, "the replacement's LISTEN");
    });
    a.holdSends = false;
    expect(a.listener.instances).toHaveLength(2);
    const g = a.gen.read();
    // Ping 1's send fails now: no longer the outstanding ping, it replaces nothing.
    a.failHeldSends();
    await within(a.lastSend!, MOVE_MS, "ping 1's send to settle");
    await flush();
    expect(a.gen.read()).toBe(g);
    expect(a.listener.instances).toHaveLength(2);
    expect(a.listener.instances[1]!.closed).toBe(false);
    // And the heartbeat carries on over the replacement.
    timers.tick();
    await pinged(a, db);
    timers.tick();
    expect(a.gen.read()).toBe(g);
    expect(a.listener.instances).toHaveLength(2);
  });

  withPods("the heartbeat: a send that fails turns the cache off and replaces the instance; the next LISTEN turns it on", 1, async (_db, a) => {
    const timers = a.timers!;
    const u = await seed(a, "u7s@example.com");
    await a.settle();
    expect(await a.auth.isDisabled(a.tx.read, u)).toBe(false); // cached
    const g0 = a.auth.authGeneration()!;
    a.notifyFails = true;
    // The replacement's LISTEN is held, so the off period can be seen.
    a.listener.holdingListen = true;
    try {
      const { logged } = await capturingErrors(async () => {
        timers.tick();
        await until(() => a.listener.heldListen, MOVE_MS, "pod a's listener to be replaced after its heartbeat send failed, and the new LISTEN acknowledged");
      });
      expect(a.auth.authGeneration()).toBeUndefined();
      expect(logged.map(l => l[0])).toEqual(["[grayboard] auth LISTEN heartbeat send failed; the auth cache is off until it listens again"]);
      expect(a.listener.instances).toHaveLength(2);
      expect(a.listener.instances[0]!.closed).toBe(true);
    } finally { a.listener.holdingListen = false; a.listener.releaseListen(); a.notifyFails = false; }
    await on(a, "the replacement's LISTEN");
    expect(Number(a.auth.authGeneration())).toBeGreaterThan(Number(g0));
    expect(a.auth.authPeek()?.user(u)).toBeUndefined();
  });

  // A 1 s interval, so a scheduler stall short of a second can't run a tick before the last ping's I/O is handled.
  test("the heartbeat on real timers: pings through the store's read-only pool keep the cache on; a deaf listener is replaced", async () => {
    await using db = await pgDatabase({ max: 3 });
    const a = await pgAuthPod(db, "a", { timers: "real", heartbeatMs: 1000 });
    try {
      const g0 = a.auth.authGeneration();
      await until(() => a.listener.heartbeats >= 2, 6000, "two heartbeats to arrive on real timers");
      expect(a.auth.authGeneration()).toBe(g0);
      expect(a.listener.instances).toHaveLength(1);
      a.listener.instances[0]!.deaf = true;
      await capturingErrors(() => until(() => a.listener.instances.length === 2 && a.gen.read() !== undefined, 6000,
        "the deaf listener to be replaced and the cache on again"));
      expect(Number(a.auth.authGeneration())).toBeGreaterThan(Number(g0));
    } finally { await a.close(); }
  }, 20_000);

  test("T-C9-8 a first LISTEN that fails: start() resolves with the cache off, the LISTEN is retried at 1 s doubling to 30 s, logged once, and on with a bump when one succeeds", async () => {
    await using db = await pgDatabase({ max: 3 });
    const { value: a, logged } = await capturingErrors(async () => {
      const a = await within(pgAuthPod(db, "a", { allowOff: true, prepare: l => { l.failListens = 8; } }), MOVE_MS, "start() with a refused LISTEN");
      try {
        const timers = a.timers!;
        expect(a.gen.read()).toBeUndefined();
        expect(a.auth.authPeek()).toBeUndefined();
        for (let k = 1; k <= 8; k++) {
          await until(() => timers.pending === 1, MOVE_MS, `retry ${k} to be scheduled`);
          expect(a.gen.read()).toBeUndefined();
          timers.fire();
        }
        await on(a, "the ninth LISTEN");
      } catch (error) { await a.close(); throw error; }
      return a;
    });
    try {
      expect(a.timers!.delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
      expect([RETRY_FIRST_MS, RETRY_MAX_MS]).toEqual([1000, 30000]);
      expect(logged.map(l => l[0])).toEqual(["[grayboard] auth LISTEN failed; the auth cache stays off and the LISTEN is retried:"]);
      // The LISTEN's own bump: a generation never handed out while the cache was off.
      expect(Number(a.gen.read())).toBeGreaterThan(0);
      expect(a.listener.instances).toHaveLength(9);
      expect(a.listener.instances.slice(0, 8).every(i => i.closed)).toBe(true);
      await a.listenerPid();
      // An acknowledged LISTEN resets the backoff: a later failure retries at 1 s again.
      a.listener.failListens = 1;
      a.notifyFails = true;
      await capturingErrors(async () => {
        a.timers!.tick();
        await until(() => a.timers!.pending === 1, MOVE_MS, "the retry after the heartbeat's failure and a refused LISTEN");
      });
      expect(a.timers!.delays.at(-1)).toBe(1000);
      a.notifyFails = false;
    } finally { await a.close(); }
    // close() stops the heartbeat and the pending retry.
    expect(a.timers!.intervals).toBe(0);
    expect(a.timers!.pending).toBe(0);
  });

  test("T-C9-8 a first LISTEN that never answers: start() resolves after its timeout with the cache off; the attempt counts as failed after a full heartbeat interval and is retried", async () => {
    await using db = await pgDatabase({ max: 3 });
    const a = await within(pgAuthPod(db, "a", { allowOff: true, startTimeoutMs: 50, prepare: l => { l.hangListens = 1; } }), MOVE_MS, "start() with a LISTEN that never answers");
    try {
      const timers = a.timers!;
      expect(a.gen.read()).toBeUndefined();
      const { logged } = await capturingErrors(async () => {
        timers.tick();
        expect(timers.pending).toBe(0); // one tick isn't a full interval
        timers.tick();
      });
      expect(logged.map(l => l[0])).toEqual(["[grayboard] auth LISTEN failed; the auth cache stays off and the LISTEN is retried:"]);
      expect(timers.delays).toEqual([1000]);
      expect(a.listener.instances[0]!.closed).toBe(true);
      // Closing it rejected the hung listen() (as Bun does): that late failure of an instance no longer current changes
      // nothing, no second retry, no longer backoff.
      await flush();
      expect(timers.delays).toEqual([1000]);
      expect(timers.pending).toBe(1);
      timers.fire();
      await on(a, "the retried LISTEN");
    } finally { await a.close(); }
  });

  test("T-C9-8 a hung first LISTEN's rejection landing after the retry's LISTEN is on changes nothing; a failed attempt leaves the cache off", async () => {
    await using db = await pgDatabase({ max: 3 });
    const a = await within(pgAuthPod(db, "a", { allowOff: true, startTimeoutMs: 50, prepare: l => { l.hangListens = 1; l.holdingHung = true; } }),
      MOVE_MS, "start() with a LISTEN that never answers");
    try {
      const timers = a.timers!;
      const u = await seed(a, "u8h@example.com");
      const [first] = a.listener.instances;
      // An acknowledgement on an attempt whose listen() then never settles (Bun acknowledges just before it resolves):
      // the cache is on, and the attempt failing must still turn it off.
      first!.onlisten!();
      expect(a.gen.read()).toBeDefined();
      await capturingErrors(async () => { timers.tick(); timers.tick(); });
      expect(a.gen.read()).toBeUndefined();
      expect(first!.closed).toBe(true);
      expect(a.listener.instances).toHaveLength(1);
      expect(timers.delays).toEqual([1000]);
      // The retry opens instance B and it listens; only then does A's listen() reject.
      timers.fire();
      await on(a, "the retried LISTEN");
      const second = a.listener.instances[1]!;
      const g = a.gen.read();
      await capturingErrors(() => a.listener.releaseHung());
      expect(a.gen.read()).toBe(g);
      expect(second.closed).toBe(false);
      expect(timers.pending).toBe(0);
      expect(timers.delays).toEqual([1000]);
      // B is still the current instance: an outside write reaches the generation through it.
      await db.sql`UPDATE users SET display_name = 'after' WHERE id = ${u}`;
      await moved(a, g, "an outside write on the retried instance");
    } finally { await a.close(); }
  });

  withPods("T-C9-9 re-listen ordering: a disable committed while the new LISTEN's callback is held is refused once it runs; the generation only grows; each acknowledged LISTEN bumps", 1, async (db, a) => {
    const u = await seed(a, "u9@example.com");
    await a.settle();
    expect(await a.auth.isDisabled(a.tx.read, u)).toBe(false); // cached
    const g0 = a.auth.authGeneration()!;
    a.listener.holdingListen = true;
    try {
      await capturingErrors(async () => {
        await db.sql`SELECT pg_terminate_backend(${await a.listenerPid()})`;
        await until(() => a.listener.heldListen, 3000, "pod A's listener to reconnect and its LISTEN to be acknowledged");
      });
      // Bun has the new LISTEN; the source hasn't run its callback. A disable now is delivered on the new connection.
      await db.sql`UPDATE users SET disabled_at = ${Date.now()} WHERE id = ${u}`;
      await a.settle();
      expect(a.auth.authGeneration()).toBeUndefined();
    } finally { a.listener.holdingListen = false; a.listener.releaseListen(); }
    const g1 = a.auth.authGeneration()!;
    expect(Number(g1)).toBeGreaterThan(Number(g0));
    expect(a.auth.authPeek()?.user(u)).toBeUndefined(); // nothing keyed before the drop answers
    expect(await a.auth.isDisabled(a.tx.read, u)).toBe(true);
    expect(a.auth.authPeek()?.user(u)).toBeDefined(); // cached under g1
    // A notification after the re-listen bumps past it.
    await db.sql`UPDATE users SET display_name = 'after' WHERE id = ${u}`;
    await moved(a, g1, "an outside write after the re-listen");
    expect(Number(a.auth.authGeneration())).toBeGreaterThan(Number(g1));
    // A LISTEN acknowledged again on the current instance with no close before it (Bun runs onlisten on every
    // acknowledgement): it bumps too, so no entry keyed before it answers after it.
    expect(await a.auth.isDisabled(a.tx.read, u)).toBe(true); // cached
    const g2 = a.auth.authGeneration()!;
    a.listener.instances.at(-1)!.onlisten!();
    expect(Number(a.auth.authGeneration())).toBeGreaterThan(Number(g2));
    expect(a.auth.authPeek()?.user(u)).toBeUndefined();
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
