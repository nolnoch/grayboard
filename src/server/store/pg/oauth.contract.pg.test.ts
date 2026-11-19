// #807 P3 C4b: the OAuth contract (oauth.contract.ts) on Postgres: the same rows SQLite runs from oauth-store.test.ts,
// over makePgOAuth and the identity groups (pg/identity.ts) whose setDisabled and revokeAllForUser a mint must lose to.
// Each row gets its own database (rows() and audits() read whole tables). Below the contract, the rows only Postgres
// has: the injected hosted port (pg/hosted_port.ts) runs inside the body that revoked, and its throw rolls the caller
// back (no savepoints, c4-scope decision 7). The races are oauth.pg.test.ts's. Without GRAYBOARD_TEST_PG_URL it skips
// (tests/support/pg.ts).
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { describePg, pgDatabase } from "../../../../tests/support/pg.ts";
import { hostedRecorder } from "../../../../tests/support/pg_hosted.ts";
import { OAUTH_TTL, type OAuthCode, type OAuthTokenPair } from "../../oauth-types.ts";
import { oauthContract, type OAuthBackend, type OAuthHarness, type OAuthTable, type Row } from "../oauth.contract.ts";
import type { PgHostedEnds } from "./hosted_port.ts";
import { makePgIdentity } from "./identity.ts";
import { makePgOAuth } from "./oauth.ts";
import { makePgTransactions } from "./tx.ts";

const WITH_DATA = new Set<OAuthTable>(["oauth_requests", "oauth_browsers", "oauth_codes", "oauth_grants"]);
const KEY: Record<OAuthTable, string> = {
  oauth_requests: "hash", oauth_browsers: "hash", oauth_codes: "hash", oauth_grants: "id", oauth_tokens: "hash",
  service_credentials: "id", service_credential_secrets: "id", server_state: "key", sessions: "id",
};

async function openPgOAuth(hosted: PgHostedEnds): Promise<OAuthHarness> {
  const db = await pgDatabase({ max: 2 });
  const s = makePgTransactions(db.url, { max: 4, applicationName: "gb-test-oauth" });
  const g = makePgIdentity({ now: Date.now, hosted });
  // Fixture writes and raw reads on the database's own read-write pool, each its own transaction.
  const sql = db.sql;
  return {
    oauth: makePgOAuth({ hosted }), users: g.users, sessions: g.sessions, services: g.services,
    write: fn => s.write(fn),
    read: s.read,
    setDisabled: (userId, disabled) => s.write(tx => g.users.setDisabled(tx, userId, disabled)),
    // disabled_at alone, so a row about activeUser can't pass on setDisabled's revokes.
    async disable(userId) { await sql`UPDATE users SET disabled_at = ${Date.now()} WHERE id = ${userId}`; },
    revokeAllForUser: userId => s.write(tx => g.sessions.revokeAllForUser(tx, userId)),
    async fillBrowsers(userId, n, expiresAt) {
      await sql`INSERT INTO oauth_browsers (hash, user_id, expires_at, data)
        SELECT 'fill-' || i, ${userId}::int8, ${expiresAt}::int8,
          jsonb_build_object('sessionHash', 'fill-' || i, 'userId', ${userId}::int8, 'createdAt', 0, 'expiresAt', ${expiresAt}::int8)
        FROM generate_series(1, ${n}::int) i`;
    },
    // to_jsonb renders int8 as JSON numbers and keeps `data` an object; data_type is the database's jsonb_typeof.
    async rows(table) {
      const typed = WITH_DATA.has(table) ? sql`, jsonb_typeof(t.data) AS data_type` : sql``;
      return (await sql`SELECT to_jsonb(t) AS row ${typed} FROM ${sql(table)} t ORDER BY ${sql(KEY[table])}`)
        .map((r: { row: Row; data_type?: string }) => WITH_DATA.has(table) ? { ...r.row, data_type: r.data_type } : r.row);
    },
    async audits(action) {
      return [...await sql`SELECT actor, target, detail, jsonb_typeof(detail) AS detail_type FROM access_log WHERE action = ${action} ORDER BY id`];
    },
    async close() {
      await s.close();
      await db[Symbol.asyncDispose]();
    },
  };
}

const pgOAuthBackend: OAuthBackend = { kind: "postgres", open: () => openPgOAuth(hostedRecorder().port) };

describePg("OAuth contract (Postgres)", () => oauthContract(pgOAuthBackend));

const start = 1_800_000_000_000;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const auth = { clientId: "native", resource: "https://example.com/mcp", scopes: ["grayboard:tools"], redirectUri: "http://127.0.0.1/callback", codeChallenge: "A".repeat(43) };
const tokens = (tag: string): OAuthTokenPair => ({ ...auth, accessHash: sha(`access-${tag}`), refreshHash: sha(`refresh-${tag}`),
  accessExpiresAt: start + OAUTH_TTL.access, refreshExpiresAt: start + OAUTH_TTL.refresh });

// A user with a grant issued through consent; returns its redemption.
async function issued(h: OAuthHarness, tag = "") {
  const o = h.oauth;
  const userId = (await h.write(tx => h.users.upsertByEmail(tx, "you@example.com", null))).id;
  const sessionHash = sha(`browser-session${tag}`);
  const request = { ...auth, requestHash: sha(`request${tag}`), browserHash: sha(`browser${tag}`), csrfHash: sha(`csrf${tag}`), stateHash: sha(`state${tag}`),
    consentSessionHash: null, createdAt: start, expiresAt: start + OAUTH_TTL.request };
  const code: OAuthCode = { ...auth, userId, codeHash: sha(`code${tag}`), createdAt: start, expiresAt: start + OAUTH_TTL.code };
  const redemption = { ...auth, codeHash: code.codeHash, grantId: `grant_${tag}0123456789abcdef`, grantExpiresAt: start + OAUTH_TTL.grant, tokens: tokens(tag) };
  await h.write(async tx => {
    expect((await o.createBrowserSession(tx, { sessionHash, userId, createdAt: start, expiresAt: start + OAUTH_TTL.browser }, start)).status).toBe("ok");
    expect((await o.createRequest(tx, request, start)).status).toBe("ok");
    expect((await o.bindRequestSession(tx, request.requestHash, request.browserHash, sessionHash, start)).status).toBe("ok");
    expect((await o.decideRequest(tx, { requestHash: request.requestHash, browserHash: request.browserHash, csrfHash: request.csrfHash, sessionHash, approve: true, code }, start)).status).toBe("ok");
    expect((await o.redeemCode(tx, redemption, start)).status).toBe("ok");
  });
  return { userId, redemption };
}

describePg("OAuth store (Postgres): the hosted port", () => {
  const withStore = (name: string, fn: (h: OAuthHarness, rec: ReturnType<typeof hostedRecorder>) => Promise<void>) => test(name, async () => {
    const rec = hostedRecorder();
    const h = await openPgOAuth(rec.port);
    try {
      await fn(h, rec);
      expect(rec.problems).toEqual([]);
    } finally { await h.close(); }
  });

  withStore("every grant revoke ends its hosted sessions in the same transaction, after the revoke", async (h, rec) => {
    const a = await issued(h, "a");
    // A refresh-token revoke, a code replay, a refresh replay.
    await h.write(tx => h.oauth.revokeToken(tx, a.redemption.tokens.refreshHash, auth.clientId, start));
    const b = await issued(h, "b");
    expect((await h.write(tx => h.oauth.redeemCode(tx, { ...b.redemption, grantId: "grant_b_again_0123456789" }, start))).status).toBe("replay");
    const c = await issued(h, "c");
    const next = { ...tokens("c2"), accessExpiresAt: start + 1 + OAUTH_TTL.access, refreshExpiresAt: start + 1 + OAUTH_TTL.refresh };
    expect((await h.write(tx => h.oauth.rotateRefresh(tx, { ...auth, refreshHash: c.redemption.tokens.refreshHash, tokens: next }, start + 1))).status).toBe("ok");
    expect((await h.write(tx => h.oauth.rotateRefresh(tx, { ...auth, refreshHash: c.redemption.tokens.refreshHash, tokens: tokens("c3") }, start + 2))).status).toBe("replay");
    // The boot cutover, over every live grant of the client (d's; a, b and c are already revoked).
    const d = await issued(h, "d");
    expect(await h.write(tx => h.oauth.revokePreBuiltinGrants(tx, [auth.clientId], start + 3))).toBe(1);
    expect(rec.ended).toEqual(["a", "b", "c", "d"].map(t => ({ kind: "grant", grantId: `grant_${t}0123456789abcdef` })));
    void d;
  });

  withStore("revoke-all and disable end the user's hosted sessions with their reasons, holding the users row", async (h, rec) => {
    const { userId } = await issued(h);
    await h.revokeAllForUser(userId);
    await h.setDisabled(userId, true);
    // Re-enabling ends nothing.
    await h.setDisabled(userId, false);
    expect(rec.ended).toEqual([{ kind: "user", userId, reason: "revoked" }, { kind: "user", userId, reason: "disabled" }]);
  });

  withStore("a throw inside the store (the hosted port) rolls back with the caller: no savepoint keeps a partial revoke", async (h, rec) => {
    const a = await issued(h, "a");
    rec.failNext();
    await expect(h.write(tx => h.oauth.revokeToken(tx, a.redemption.tokens.refreshHash, auth.clientId, start))).rejects.toThrow("hosted end failed");
    expect(await h.oauth.isGrantActive(h.read, a.redemption.grantId, start)).toBe(true);
    expect(await h.audits("oauth.revoked")).toEqual([]);
    // And the user-wide end: the sessions, grants and codes it revoked before the port threw come back.
    const s = await h.write(tx => h.sessions.create(tx, a.userId, sha("cli-token"), null));
    rec.failNext();
    await expect(h.revokeAllForUser(a.userId)).rejects.toThrow("hosted end failed");
    expect((await h.sessions.findById(h.read, s.id))?.revoked_at).toBeNull();
    expect(await h.oauth.isGrantActive(h.read, a.redemption.grantId, start)).toBe(true);
    rec.failNext();
    await expect(h.setDisabled(a.userId, true)).rejects.toThrow("hosted end failed");
    expect(await h.oauth.isGrantActive(h.read, a.redemption.grantId, start)).toBe(true);
    expect(await h.oauth.findBrowserSession(h.read, sha("browser-sessiona"), start)).toBeDefined();
    expect(rec.ended).toEqual([]);
  });
});
