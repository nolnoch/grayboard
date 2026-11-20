// #807 P3 C4b: the OAuth store's races on Postgres (c4-scope §5.2, docs/future/postgres-server.md D3), each in T-P12's
// shape (tx.pg.test.ts, identity.pg.test.ts): two stores on one database, the first body runs to a gate and holds its
// transaction open, the second starts, and the test waits until the second is either blocked on a lock
// (pg_stat_activity) or done, then releases the first and checks the end state. The end state is asserted before the
// wait, so a race whose lock or guard is gone fails on what it broke (a second live grant, an eleventh request, a
// grant minted for a disabled user), not on a timeout. Without GRAYBOARD_TEST_PG_URL they skip.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { describePg } from "../../../../tests/support/pg.ts";
import { hostedRecorder, type HostedRecorder } from "../../../../tests/support/pg_hosted.ts";
import { BLOCK_WAIT_MS, blockedOrSettled, gate, pgPair, race, settle, type PgPair, type Settled } from "../../../../tests/support/pg_race.ts";
import { until } from "../../../../tests/support/until.ts";
import { OAUTH_SCOPES } from "../../oauth-config.ts";
import { BROWSER_SESSIONS, REQUESTS_PER_BROWSER, REQUESTS_TOTAL } from "../../oauth-rules.ts";
import { OAUTH_TTL, type OAuthAuthorization, type OAuthCode, type OAuthRequest, type OAuthStore, type OAuthTokenPair, type ServiceTokenLimits } from "../../oauth-types.ts";
import type { Tx } from "../tx_base.ts";
import type { PgHostedEnds } from "./hosted_port.ts";
import { makePgIdentity, type PgIdentity } from "./identity.ts";
import { makePgOAuth } from "./oauth.ts";
import { makePgTransactions, pgOf } from "./tx.ts";

const start = 1_800_000_000_000;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const grantAuth: OAuthAuthorization = { clientId: "native", resource: "https://example.com/mcp", scopes: ["grayboard:tools"], redirectUri: "http://127.0.0.1/callback", codeChallenge: "A".repeat(43) };
const loginAuth: OAuthAuthorization = { ...grantAuth, scopes: ["grayboard:login"] };
const pairOf = (tag: string, auth = grantAuth, now = start): OAuthTokenPair => ({ ...auth, accessHash: sha(`access-${tag}`), refreshHash: sha(`refresh-${tag}`),
  accessExpiresAt: now + OAUTH_TTL.access, refreshExpiresAt: now + OAUTH_TTL.refresh });

type Pair = PgPair & { o: OAuthStore; g: PgIdentity; rec: HostedRecorder };

// `hosted` replaces the recorder's port in both stores (the lock-order race's C8-shaped port).
async function pair(hosted?: PgHostedEnds): Promise<Pair> {
  const base = await pgPair();
  const rec = hostedRecorder();
  const port = hosted ?? rec.port;
  return {
    ...base, rec, o: makePgOAuth({ hosted: port }), g: makePgIdentity({ now: Date.now, hosted: port }),
    async [Symbol.asyncDispose]() {
      await base[Symbol.asyncDispose]();
      expect(rec.problems).toEqual([]);
    },
  };
}

// A settled store call's status, or its error's message.
const st = (s: Settled<unknown>) => s.ok ? (s.value as { status?: string } | undefined)?.status ?? s.value : `threw ${s.error?.message}`;
const count = async (p: Pair, table: string, where = p.db.sql`TRUE`) => Number((await p.db.sql`SELECT count(*) AS n FROM ${p.db.sql(table)} WHERE ${where}`)[0].n);

// The CLI session minted for this token: its revoked_at, or undefined when there is none.
const revokedAt = async (p: Pair, token: string) => (await p.db.sql`SELECT revoked_at::float8 AS r FROM sessions WHERE token_hash = ${sha(token)}`)[0]?.r as number | null | undefined;

// A user with a browser session and a consent request for `auth`; `tag` keeps worlds' hashes apart.
async function world(p: Pair, tag = "", auth = grantAuth) {
  const userId = (await p.a.write(tx => p.g.users.upsertByEmail(tx, "you@example.com", null))).id;
  const sessionHash = sha(`browser-session${tag}`);
  const request: OAuthRequest = { ...auth, requestHash: sha(`request${tag}`), browserHash: sha(`browser${tag}`), csrfHash: sha(`csrf${tag}`), stateHash: sha(`state${tag}`),
    consentSessionHash: null, createdAt: start, expiresAt: start + OAUTH_TTL.request };
  const code = (n = ""): OAuthCode => ({ ...auth, userId, codeHash: sha(`code${tag}${n}`), createdAt: start, expiresAt: start + OAUTH_TTL.code });
  const browser = (h = sessionHash) => ({ sessionHash: h, userId, createdAt: start, expiresAt: start + OAUTH_TTL.browser });
  const w = {
    userId, sessionHash, request, code, browser,
    decision: (c = code()) => ({ requestHash: request.requestHash, browserHash: request.browserHash, csrfHash: request.csrfHash, sessionHash, approve: true, code: c }),
    redemption: (grantId = `grant${tag}_a_0123456789abcdef`, tokens = pairOf(`${tag}${grantId}`, auth)) =>
      ({ ...auth, codeHash: code().codeHash, grantId, grantExpiresAt: start + OAUTH_TTL.grant, tokens }),
    login: (token: string) => ({ ...auth, codeHash: code().codeHash, tokenHash: sha(token), label: null }),
    // Up to the stage named: the request exists (and is bound), or the code is issued.
    async until(stage: "request" | "bound" | "code") {
      await p.a.write(async tx => {
        expect((await p.o.createBrowserSession(tx, browser(), start)).status).toBe("ok");
        expect((await p.o.createRequest(tx, request, start)).status).toBe("ok");
        if (stage === "request") return;
        expect((await p.o.bindRequestSession(tx, request.requestHash, request.browserHash, sessionHash, start)).status).toBe("ok");
        if (stage === "bound") return;
        expect((await p.o.decideRequest(tx, w.decision(), start)).status).toBe("ok");
      });
    },
  };
  return w;
}

const SVC = `svc_${"a".repeat(32)}`;
const LIMITS: ServiceTokenLimits = { maxSeconds: 600, mintsPerMinute: 100, unexpired: 100 };
const credentialOf = (userId: number) => ({ userId, clientId: SVC, grantId: "svcgrant_0123456789", resource: grantAuth.resource, source: "generic" as const,
  tokenSeconds: 3600, expiresAt: start + OAUTH_TTL.grant, secretHash: sha("secret-1") });

async function service(p: Pair, secrets = 1) {
  return p.a.write(async tx => {
    const svc = await p.g.services.create(tx, "ingest");
    const r = await p.o.addServiceCredential(tx, credentialOf(svc.id), start);
    if (r.status !== "ok") throw new Error(`addServiceCredential answered ${r.status}`);
    const ids = [r.value.secretId];
    for (let i = 2; i <= secrets; i++) {
      const s = await p.o.rotateServiceCredential(tx, { clientId: SVC, secretHash: sha(`secret-${i}`) }, start);
      if (s.status !== "ok") throw new Error(`rotate answered ${s.status}`);
      ids.push(s.value.secretId);
    }
    return { svcId: svc.id, secretIds: ids };
  });
}
const mint = (p: Pair, secretId: number, token: string, limits = LIMITS) => (tx: Tx) =>
  p.o.mintServiceToken(tx, { clientId: SVC, secretId, tokenHash: sha(token), scopes: [...OAUTH_SCOPES], limits }, start);

describePg("OAuth races (Postgres)", () => {
  test("T-C4-1 code race: a second redemption of one code is a replay that revokes the first's grant and leaves no grant of its own", async () => {
    await using p = await pair();
    const w = await world(p);
    await w.until("code");
    const r = await race(p, tx => p.o.redeemCode(tx, w.redemption("grant_first_0123456789"), start), tx => p.o.redeemCode(tx, w.redemption("grant_second_0123456789"), start));
    expect([st(r.a), st(r.b)]).toEqual(["ok", "replay"]);
    expect(await p.o.isGrantActive(p.a.read, "grant_first_0123456789", start)).toBe(false);
    expect(await count(p, "oauth_grants", p.db.sql`id = 'grant_second_0123456789'`)).toBe(0);
    expect((await p.db.sql`SELECT count(*)::int AS n FROM access_log WHERE action = 'oauth.code_replay_revoked'`)[0].n).toBe(1);
    expect(p.rec.ended).toEqual([{ kind: "grant", grantId: "grant_first_0123456789" }]);
    expect(r.waited).toBe(true);
  });

  test("T-C4-2 login code race: a second redemption is a replay that revokes the first's CLI session and leaves no session of its own", async () => {
    await using p = await pair();
    const w = await world(p, "", loginAuth);
    await w.until("code");
    const r = await race(p, tx => p.o.redeemLoginCode(tx, w.login("cli-1"), start), tx => p.o.redeemLoginCode(tx, w.login("cli-2"), start));
    expect([st(r.a), st(r.b)]).toEqual(["ok", "replay"]);
    const first = r.a.ok && r.a.value.status === "ok" ? r.a.value.value.sessionId : -1;
    expect((await p.g.sessions.findById(p.a.read, first))?.revoked_at).toEqual(expect.any(Number));
    expect(await revokedAt(p, "cli-2")).toBeUndefined();
    expect(r.waited).toBe(true);
  });

  test("T-C4-3 refresh race: the second rotation of one token is a replay that revokes the grant and leaves none of its pair", async () => {
    await using p = await pair();
    const w = await world(p);
    await w.until("code");
    const red = w.redemption();
    expect((await p.a.write(tx => p.o.redeemCode(tx, red, start))).status).toBe("ok");
    const rotate = (tag: string) => (tx: Tx) => p.o.rotateRefresh(tx, { ...grantAuth, refreshHash: red.tokens.refreshHash, tokens: pairOf(tag, grantAuth, start + 1) }, start + 1);
    const r = await race(p, rotate("one"), rotate("two"));
    expect([st(r.a), st(r.b)]).toEqual(["ok", "replay"]);
    expect(await p.o.isGrantActive(p.a.read, red.grantId, start + 1)).toBe(false);
    expect(await count(p, "oauth_tokens", p.db.sql`hash IN (${sha("access-two")}, ${sha("refresh-two")})`)).toBe(0);
    expect(r.waited).toBe(true);
  });

  // Mutation: rotateRefresh reading its grant without FOR SHARE: B's read doesn't wait on A's uncommitted revoke, sees
  // the grant live, spends the token (the revoke leaves it unrevoked) and answers ok with a pair that never authorizes.
  test("T-C4-3b a rotation behind an in-flight grant revoke waits for it, then refuses and mints no pair (#1066)", async () => {
    await using p = await pair();
    const w = await world(p);
    await w.until("code");
    const red = w.redemption();
    expect((await p.a.write(tx => p.o.redeemCode(tx, red, start))).status).toBe("ok");
    const r = await race(p,
      tx => p.o.revokeToken(tx, red.tokens.refreshHash, grantAuth.clientId, start + 1),
      tx => p.o.rotateRefresh(tx, { ...grantAuth, refreshHash: red.tokens.refreshHash, tokens: pairOf("next", grantAuth, start + 1) }, start + 1));
    expect(r.a.ok).toBe(true);
    expect(st(r.b)).toBe("invalid");
    expect(await count(p, "oauth_tokens", p.db.sql`hash IN (${sha("access-next")}, ${sha("refresh-next")})`)).toBe(0);
    expect(await p.o.isGrantActive(p.a.read, red.grantId, start + 1)).toBe(false);
    expect(r.waited).toBe(true);
  });

  // Three rotations of one token: A wins and holds its transaction open; two more on store B queue behind it. Mutation:
  // the grant read FOR SHARE: both losers hold SHARE on the grant while they wait on A's token row, then both replay
  // and revoke the grant, and the two lock upgrades deadlock (40P01). Locked FOR NO KEY UPDATE they queue on the grant
  // instead: the first replays and revokes, the second reads the revoked grant.
  test("T-C4-3c two rotations queued behind a winning one replay one at a time: no deadlock, the grant ends revoked (#1066)", async () => {
    await using p = await pair();
    const w = await world(p);
    await w.until("code");
    const red = w.redemption();
    expect((await p.a.write(tx => p.o.redeemCode(tx, red, start))).status).toBe("ok");
    const rotate = (tag: string) => (tx: Tx) => p.o.rotateRefresh(tx, { ...grantAuth, refreshHash: red.tokens.refreshHash, tokens: pairOf(tag, grantAuth, start + 1) }, start + 1);
    const c = makePgTransactions(p.db.url, { max: 2, applicationName: "gb-test-c" });
    p.onDispose(() => c.close());
    const held = gate(), release = gate();
    const a = settle(p.a.write(async tx => { const v = await rotate("one")(tx); held.open(); await release.wait; return v; }));
    let losers: Settled<unknown>[];
    try {
      await Promise.race([held.wait, a]);
      // A third store: one store's writes run one at a time (D4), so the two losers need two.
      const pending = [settle(p.b.write(rotate("two"))), settle(c.write(rotate("three")))];
      await until(async () => Number((await p.db.sql`SELECT count(*) AS n FROM pg_stat_activity
        WHERE datname = ${p.db.name} AND application_name IN ('gb-test-b', 'gb-test-c') AND wait_event_type = 'Lock'`)[0].n) === 2,
        BLOCK_WAIT_MS, "both queued rotations blocked on a lock behind A");
      release.open();
      losers = await Promise.all(pending);
    } finally { release.open(); }
    expect(st(await a)).toBe("ok");
    expect(losers.map(st).sort()).toEqual(["invalid", "replay"]);
    expect(await p.o.isGrantActive(p.a.read, red.grantId, start + 1)).toBe(false);
  });

  test("T-C4-4 a code deleted under its redeemer: the redeemer answers not_found and mints nothing", async () => {
    await using p = await pair();
    const w = await world(p);
    await w.until("code");
    const r = await race(p, tx => p.o.cleanup(tx, start + OAUTH_TTL.code), tx => p.o.redeemCode(tx, w.redemption(), start));
    expect(st(r.b)).toBe("not_found");
    expect(await count(p, "oauth_grants")).toBe(0);
    expect(await count(p, "oauth_tokens")).toBe(0);
    expect(r.waited).toBe(true);
  });

  test("T-C4-5a request capacity per browser: two creators at nine pending admit one", async () => {
    await using p = await pair();
    const w = await world(p);
    await p.a.write(async tx => {
      for (let i = 1; i < REQUESTS_PER_BROWSER; i++) expect((await p.o.createRequest(tx, { ...w.request, requestHash: sha(`pending-${i}`) }, start)).status).toBe("ok");
    });
    const create = (tag: string) => (tx: Tx) => p.o.createRequest(tx, { ...w.request, requestHash: sha(tag) }, start);
    const r = await race(p, create("tenth"), create("eleventh"));
    expect([st(r.a), st(r.b)]).toEqual(["ok", "capacity"]);
    expect(await count(p, "oauth_requests", p.db.sql`browser_hash = ${w.request.browserHash}`)).toBe(REQUESTS_PER_BROWSER);
    expect(r.waited).toBe(true);
  });

  test("T-C4-5b request capacity in all: two creators on two browsers at 999 pending admit one", async () => {
    await using p = await pair();
    const w = await world(p);
    await p.db.sql`INSERT INTO oauth_requests (hash, browser_hash, expires_at, data)
      SELECT 'fill-' || i, 'browser-' || i, ${start + OAUTH_TTL.request}::int8, '{}'::jsonb FROM generate_series(1, ${REQUESTS_TOTAL - 1}::int) i`;
    const create = (tag: string) => (tx: Tx) => p.o.createRequest(tx, { ...w.request, requestHash: sha(tag), browserHash: sha(`browser-${tag}`) }, start);
    const r = await race(p, create("one"), create("two"));
    expect([st(r.a), st(r.b)]).toEqual(["ok", "capacity"]);
    expect(await count(p, "oauth_requests")).toBe(REQUESTS_TOTAL);
    expect(r.waited).toBe(true);
  });

  test("T-C4-6 browser capacity: two creators at cap-1 live sessions admit one", async () => {
    await using p = await pair();
    const w = await world(p);
    await p.db.sql`INSERT INTO oauth_browsers (hash, user_id, expires_at, data)
      SELECT 'fill-' || i, ${w.userId}::int8, ${start + OAUTH_TTL.browser}::int8, '{}'::jsonb FROM generate_series(1, ${BROWSER_SESSIONS - 1}::int) i`;
    const r = await race(p, tx => p.o.createBrowserSession(tx, w.browser(sha("one")), start), tx => p.o.createBrowserSession(tx, w.browser(sha("two")), start));
    expect([st(r.a), st(r.b)]).toEqual(["ok", "capacity"]);
    expect(await count(p, "oauth_browsers")).toBe(BROWSER_SESSIONS);
    expect(r.waited).toBe(true);
  });

  // T-C4-7: each mint holds its FOR SHARE on the users row; the disable waits for it, then its revokes see what the
  // mint wrote. Re-enabling afterwards revives nothing.
  const mintFirst: [string, (p: Pair, w: Awaited<ReturnType<typeof world>>) => Promise<{ mint: (tx: Tx) => Promise<unknown>; dead: () => Promise<void>; userId?: number }>][] = [
    ["redeemCode", async (p, w) => {
      await w.until("code");
      return { mint: tx => p.o.redeemCode(tx, w.redemption(), start), dead: async () => expect(await p.o.isGrantActive(p.a.read, w.redemption().grantId, start)).toBe(false) };
    }],
    ["decideRequest", async (p, w) => {
      await w.until("bound");
      return { mint: tx => p.o.decideRequest(tx, w.decision(), start), dead: async () => expect(await count(p, "oauth_codes")).toBe(0) };
    }],
    ["createBrowserSession", async (p, w) => ({ mint: tx => p.o.createBrowserSession(tx, w.browser(sha("fresh")), start),
      dead: async () => expect(await count(p, "oauth_browsers")).toBe(0) })],
    ["addServiceCredential", async p => {
      const svc = await p.a.write(tx => p.g.services.create(tx, "ingest"));
      return { mint: tx => p.o.addServiceCredential(tx, credentialOf(svc.id), start), userId: svc.id,
        dead: async () => expect(await p.o.findServiceCredential(p.a.read, SVC, start)).toBeUndefined() };
    }],
  ];
  for (const [name, setup] of mintFirst) {
    test(`T-C4-7 mint-first ${name}: the disable waits for the mint and then ends what it minted`, async () => {
      await using p = await pair();
      const w = await world(p);
      const m = await setup(p, w);
      const userId = m.userId ?? w.userId;
      const r = await race(p, m.mint, tx => p.g.users.setDisabled(tx, userId, true));
      expect([st(r.a), st(r.b)]).toEqual(["ok", undefined]);
      await p.a.write(tx => p.g.users.setDisabled(tx, userId, false));
      await m.dead();
      expect(r.waited).toBe(true);
    });
  }

  test("T-C4-7 mint-first redeemLoginCode: the disable waits for the redemption and then revokes its CLI session", async () => {
    await using p = await pair();
    const w = await world(p, "", loginAuth);
    await w.until("code");
    const r = await race(p, tx => p.o.redeemLoginCode(tx, w.login("cli"), start), tx => p.g.users.setDisabled(tx, w.userId, true));
    expect(st(r.a)).toBe("ok");
    await p.a.write(tx => p.g.users.setDisabled(tx, w.userId, false));
    expect(await revokedAt(p, "cli")).toEqual(expect.any(Number));
    expect(r.waited).toBe(true);
  });

  // T-C4-8: the disable holds its UPDATE of the users row; each mint's FOR SHARE waits, then finds the user disabled.
  const disableFirst: [string, (p: Pair, w: Awaited<ReturnType<typeof world>>) => Promise<{ mint: (tx: Tx) => Promise<unknown>; userId?: number; table: string }>][] = [
    ["redeemCode", async (p, w) => { await w.until("code"); return { mint: tx => p.o.redeemCode(tx, w.redemption(), start), table: "oauth_grants" }; }],
    ["redeemLoginCode", async (p, w) => { await w.until("code"); return { mint: tx => p.o.redeemLoginCode(tx, w.login("cli"), start), table: "sessions" }; }],
    ["decideRequest", async (p, w) => { await w.until("bound"); return { mint: tx => p.o.decideRequest(tx, w.decision(), start), table: "oauth_codes" }; }],
    ["createBrowserSession", async (p, w) => ({ mint: tx => p.o.createBrowserSession(tx, w.browser(sha("fresh")), start), table: "oauth_browsers" })],
    ["addServiceCredential", async p => {
      const svc = await p.a.write(tx => p.g.services.create(tx, "ingest"));
      return { mint: tx => p.o.addServiceCredential(tx, credentialOf(svc.id), start), userId: svc.id, table: "service_credentials" };
    }],
  ];
  for (const [name, setup] of disableFirst) {
    test(`T-C4-8 disable-first ${name}: the mint waits for the disable, then refuses and writes nothing`, async () => {
      await using p = await pair();
      const w = await world(p, "", name === "redeemLoginCode" ? loginAuth : grantAuth);
      const m = await setup(p, w);
      const userId = m.userId ?? w.userId;
      const r = await race(p, tx => p.g.users.setDisabled(tx, userId, true), m.mint);
      // Refused because the user is disabled ("invalid"; decideRequest finds no live browser session, "not_found"),
      // not because the disable deleted what it read.
      expect(st(r.b)).toBe(name === "decideRequest" ? "not_found" : "invalid");
      expect(await count(p, m.table, name === "redeemLoginCode" || name === "addServiceCredential" ? p.db.sql`TRUE` : p.db.sql`user_id = ${userId}`)).toBe(0);
      expect(r.waited).toBe(true);
    });
  }

  test("T-C4-9 revoke-all waits for a login redemption, then revokes its CLI session", async () => {
    await using p = await pair();
    const w = await world(p, "", loginAuth);
    await w.until("code");
    const r = await race(p, tx => p.o.redeemLoginCode(tx, w.login("cli"), start), tx => p.g.sessions.revokeAllForUser(tx, w.userId));
    expect(st(r.a)).toBe("ok");
    expect(await revokedAt(p, "cli")).toEqual(expect.any(Number));
    expect(r.waited).toBe(true);
  });

  test("T-C4-10 cutover: two boots claim the key; one revokes and audits, the other returns 0 without error", async () => {
    await using p = await pair();
    const w = await world(p);
    await w.until("code");
    expect((await p.a.write(tx => p.o.redeemCode(tx, w.redemption(), start))).status).toBe("ok");
    const boot = (tx: Tx) => p.o.revokePreBuiltinGrants(tx, [grantAuth.clientId], start + 1);
    const r = await race(p, boot, boot);
    expect([r.a.ok ? r.a.value : r.a.error?.message, r.b.ok ? r.b.value : r.b.error?.message]).toEqual([1, 0]);
    expect((await p.db.sql`SELECT count(*)::int AS n FROM access_log WHERE action = 'oauth.builtin_client_grant_revoked'`)[0].n).toBe(1);
    expect(p.rec.ended).toEqual([{ kind: "grant", grantId: w.redemption().grantId }]);
    expect(r.waited).toBe(true);
  });

  test("T-C4-11 bind race: two browser sessions binding one request; the second finds it bound elsewhere", async () => {
    await using p = await pair();
    const w = await world(p);
    await w.until("request");
    await p.a.write(tx => p.o.createBrowserSession(tx, w.browser(sha("other")), start));
    const bind = (s: string) => (tx: Tx) => p.o.bindRequestSession(tx, w.request.requestHash, w.request.browserHash, s, start);
    const r = await race(p, bind(w.sessionHash), bind(sha("other")));
    expect([st(r.a), st(r.b)]).toEqual(["ok", "not_found"]);
    expect((await p.o.findRequest(p.a.read, w.request.requestHash, w.request.browserHash, start))?.consentSessionHash).toBe(w.sessionHash);
    expect(r.waited).toBe(true);
  });

  test("T-C4-12 decide race: two decisions on one request issue one code", async () => {
    await using p = await pair();
    const w = await world(p);
    await w.until("bound");
    const r = await race(p, tx => p.o.decideRequest(tx, w.decision(w.code("1")), start), tx => p.o.decideRequest(tx, w.decision(w.code("2")), start));
    expect([st(r.a), st(r.b)]).toEqual(["ok", "not_found"]);
    expect(await count(p, "oauth_codes")).toBe(1);
    expect(r.waited).toBe(true);
  });

  test("mint bucket: two mints with one left in the minute admit one", async () => {
    await using p = await pair();
    const { secretIds: [s] } = await service(p);
    const limits = { ...LIMITS, mintsPerMinute: 2 };
    expect((await p.a.write(mint(p, s!, "t0", limits))).status).toBe("ok");
    const r = await race(p, mint(p, s!, "t1", limits), mint(p, s!, "t2", limits));
    expect([st(r.a), st(r.b)]).toEqual(["ok", "capacity"]);
    expect(await count(p, "oauth_tokens")).toBe(2);
    expect(r.waited).toBe(true);
  });

  test("mint cap: two mints with one unexpired slot left admit one", async () => {
    await using p = await pair();
    const { secretIds: [s] } = await service(p);
    const limits = { ...LIMITS, unexpired: 2 };
    expect((await p.a.write(mint(p, s!, "t0", limits))).status).toBe("ok");
    const r = await race(p, mint(p, s!, "t1", limits), mint(p, s!, "t2", limits));
    expect([st(r.a), st(r.b)]).toEqual(["ok", "capacity"]);
    expect(await count(p, "oauth_tokens")).toBe(2);
    expect(r.waited).toBe(true);
  });

  test("rotate cap: two rotations at one live secret leave two live", async () => {
    await using p = await pair();
    await service(p);
    const rotate = (tag: string) => (tx: Tx) => p.o.rotateServiceCredential(tx, { clientId: SVC, secretHash: sha(tag) }, start);
    const r = await race(p, rotate("two"), rotate("three"));
    expect([st(r.a), st(r.b)]).toEqual(["ok", "capacity"]);
    expect(await count(p, "service_credential_secrets", p.db.sql`revoked_at IS NULL`)).toBe(2);
    expect(r.waited).toBe(true);
  });

  test("two revokes of a credential's two secrets leave one live; the second is refused", async () => {
    await using p = await pair();
    const { secretIds: [s1, s2] } = await service(p, 2);
    const r = await race(p, tx => p.o.revokeServiceSecret(tx, s1!, start), tx => p.o.revokeServiceSecret(tx, s2!, start));
    expect([st(r.a), st(r.b)]).toEqual(["ok", "invalid"]);
    expect(await count(p, "service_credential_secrets", p.db.sql`revoked_at IS NULL`)).toBe(1);
    expect(r.waited).toBe(true);
  });

  test("mint lock is per credential, not per secret: two mints on a credential's two secrets with one left in the minute admit one", async () => {
    await using p = await pair();
    const { secretIds: [s1, s2] } = await service(p, 2);
    const limits = { ...LIMITS, mintsPerMinute: 2 };
    expect((await p.a.write(mint(p, s1!, "t0", limits))).status).toBe("ok");
    const r = await race(p, mint(p, s1!, "t1", limits), mint(p, s2!, "t2", limits));
    expect([st(r.a), st(r.b)]).toEqual(["ok", "capacity"]);
    expect(await count(p, "oauth_tokens")).toBe(2);
    expect(r.waited).toBe(true);
  });

  test("two revokes of one service credential: one revokes it, the second answers not_found", async () => {
    await using p = await pair();
    await service(p);
    const revoke = (tx: Tx) => p.o.revokeServiceCredential(tx, SVC, start);
    const r = await race(p, revoke, revoke);
    expect([st(r.a), st(r.b)]).toEqual(["ok", "not_found"]);
    expect(p.rec.ended).toEqual([{ kind: "grant", grantId: credentialOf(0).grantId }]);
    expect(r.waited).toBe(true);
  });

  test("lock order: a token revoke and a disable of its user both end hosted sessions, grant row before hosted row, without a deadlock", async () => {
    // A C8-shaped port: each end updates hosted rows (here a scratch table) after the grant revoke. The token revoke
    // pauses inside its grant end, holding the grant row, until the disable is blocked; a disable that ended the
    // user's hosted rows before revoking the grants would hold the hosted row and wait on the grant: 40P01.
    const atGate = gate(), release = gate();
    let pause = false;
    const port: PgHostedEnds = {
      async endForGrant(tx, grantId) {
        if (pause) { pause = false; atGate.open(); await release.wait; }
        await pgOf(tx)`UPDATE hosted_scratch SET ended = true WHERE grant_id = ${grantId}`;
      },
      async endForUser(tx, userId) { await pgOf(tx)`UPDATE hosted_scratch SET ended = true WHERE user_id = ${userId}`; },
    };
    await using p = await pair(port);
    await p.db.sql`CREATE TABLE hosted_scratch (grant_id text, user_id int8, ended boolean NOT NULL DEFAULT false)`;
    const w = await world(p);
    await w.until("code");
    const redemption = w.redemption();
    expect((await p.a.write(tx => p.o.redeemCode(tx, redemption, start))).status).toBe("ok");
    await p.db.sql`INSERT INTO hosted_scratch (grant_id, user_id) VALUES (${redemption.grantId}, ${w.userId})`;
    pause = true;
    const a = settle(p.a.write(tx => p.o.revokeToken(tx, redemption.tokens.refreshHash, grantAuth.clientId, start)));
    await Promise.race([atGate.wait, a]);
    let done = false, waited = false;
    const b = settle(p.b.write(tx => p.g.users.setDisabled(tx, w.userId, true))).finally(() => { done = true; });
    try {
      waited = await blockedOrSettled(p, () => done, "the disable blocked on a lock, or settled") !== null;
    } finally {
      release.open();
    }
    const out = (s: Settled<unknown>) => s.ok ? "ok" : `threw ${s.error?.message}`;
    expect([out(await a), out(await b)]).toEqual(["ok", "ok"]);
    expect((await p.db.sql`SELECT ended FROM hosted_scratch`)[0].ended).toBe(true);
    expect(await p.o.isGrantActive(p.a.read, redemption.grantId, start)).toBe(false);
    expect(waited).toBe(true);
  });

  test("the secret join: a run token minted while its secret's revoke ran is refused, though the revoke couldn't see it", async () => {
    await using p = await pair();
    const { secretIds: [s1] } = await service(p, 2);
    const r = await race(p, tx => p.o.revokeServiceSecret(tx, s1!, start), mint(p, s1!, "late"));
    // The mint neither waits nor fails: it reads the secret live in its snapshot and commits a token the revoke's
    // UPDATE never saw.
    expect([st(r.a), st(r.b)]).toEqual(["ok", "ok"]);
    expect((await p.db.sql`SELECT revoked_at FROM oauth_tokens WHERE hash = ${sha("late")}`)[0]?.revoked_at).toBeNull();
    expect(await p.o.findActiveAccess(p.a.read, sha("late"), grantAuth.resource, [], start)).toBeUndefined();
  });
});
