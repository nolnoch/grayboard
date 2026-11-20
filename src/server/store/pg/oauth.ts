// The OAuth store on Postgres (#807 P3 C4b, docs/future/postgres-server.md D3, D6): oauth-types.ts's OAuthStore,
// each method on its caller's handle through pgOf, with the input rules oauth-rules.ts holds for both backends. The
// SQLite store (db.ts oauthOps) is the reference; what differs, and why:
// - Under READ COMMITTED each statement sees a new snapshot, and one that waits on a row lock re-checks only that
//   row's WHERE. The spends (a code's grant_id or session_id, a refresh token's spent_at), the consent request's bind
//   and consume, and the cutover's key claim are each one conditional statement, as on SQLite: the loser waits on the
//   winner's row, matches nothing after its commit, and its re-read (a new statement) sees the winner's row.
// - Each capacity count runs after a transaction-scoped advisory lock for its cap (the *_LOCK classes below), taken at
//   the top of the method and never in a savepoint (ROLLBACK TO frees it): two creators at cap-1 would otherwise both
//   count cap-1 and both insert.
// - Every write that mints for a user (a grant, a code, a browser session, a CLI session, a service credential) reads
//   the user FOR SHARE (activeUser with `lock`). users.setDisabled's UPDATE and sessions.revokeAllForUser's FOR NO KEY
//   UPDATE (pg/identity.ts) conflict with it, so a disable or revoke-all either waits for the mint and then sees its row,
//   or the mint waits and finds the user disabled. A plain FK insert takes only KEY SHARE, which neither blocks.
// - No savepoints. No caller catches an OAuth error inside its body and commits (a refusal is a returned
//   OAuthFailure; oauth.ts's fail() throws and rolls the whole body back), so a store throw rolls back with the
//   caller's transaction, which the SQLite savepoint gives only per method. A caller that ever catches and commits
//   needs one here first.
// - A revoked grant's hosted sessions end through the injected port (pg/hosted_port.ts, makePgHostedEnds), after the
//   UPDATE that revoked it.
// - `data` columns are jsonb and take the object itself; oauth_tokens.access_scopes stays text (D6), written as
//   JSON.stringify of the scopes and parsed on read.
// - SQLite's synchronous testPause points (oauth:refresh:in-txn, hosted:revoke:in-txn) aren't carried: the Postgres
//   race tests hold a transaction open at a gate in the body (pg/oauth.pg.test.ts).
//
// Runtime imports stay off bun:sqlite and db.ts (pg/isolation.test.ts).
import { LOGIN_SCOPE, OAUTH_SCOPES } from "../../oauth-config.ts";
import {
  accessFits, accessLookup, browserData, browserSessionInput, BROWSER_SESSIONS, clampPair, clientLookup, codeData, codeInput,
  grantInput, isLogin, LIVE_SECRETS, loginInput, lookup, MINT_WINDOW_MS, mintInput, REQUESTS_PER_BROWSER, REQUESTS_TOTAL,
  requestData, requestInput, rotationBinding, sameAuthorization, secretLookup, serviceCredentialInput, serviceSecretInput,
  successorInput, time,
} from "../../oauth-rules.ts";
import type {
  CredentialSource, OAuthAccess, OAuthAuthorization, OAuthBrowserSession, OAuthCode, OAuthFailure, OAuthGrant, OAuthRequest,
  OAuthStore, OAuthTokenPair, ServiceCredential,
} from "../../oauth-types.ts";
import type { AuditAction } from "../../audit.ts";
import type { Tx } from "../tx_base.ts";
import { insertAudit } from "./audit_row.ts";
import type { PgHostedEnds } from "./hosted_port.ts";
import { int8, int8OrNull, type AuditDetail } from "./sql.ts";
import { pgOf, type PgSql } from "./tx.ts";

// pg_advisory_xact_lock(class, key) for each capacity cap (decision 1): the two-int4 form, so no class collides with a
// one-bigint key (ROLE_WRITE_LOCK, the migration lock). The consent requests' caps (per browser and in total) share one
// class and key: the total's count needs every creator serialized, which already serializes each browser's.
export const OAUTH_REQUESTS_LOCK = 0x67627271; // "gbrq": createRequest, both caps
export const OAUTH_BROWSERS_LOCK = 0x67626273; // "gbbs": createBrowserSession, the live-session cap
// Per service credential, keyed by hashtext(client_id) (a collision only serializes two credentials).
export const CREDENTIAL_SECRETS_LOCK = 0x67627373; // "gbss": rotate's two live secrets, revokeSecret's last one
export const CREDENTIAL_MINT_LOCK = 0x67626d74; // "gbmt": mintServiceToken's bucket and unexpired cap

type Row = Record<string, unknown>;
const invalid = { status: "invalid" } as const;
const missing = { status: "not_found" } as const;
const capacity = { status: "capacity" } as const;
const replay = { status: "replay" } as const;
const ok = <T>(value: T) => ({ status: "ok" as const, value });

const grantOf = (r: Row): OAuthGrant => ({ ...(r.data as OAuthGrant), revokedAt: int8OrNull(r.revoked_at) });

export function makePgOAuth({ hosted }: { hosted: PgHostedEnds }): OAuthStore {
  const lock = async (sql: PgSql, cls: number, key: string | null = null) => {
    await (key === null ? sql`SELECT pg_advisory_xact_lock(${cls}::int4, 0)` : sql`SELECT pg_advisory_xact_lock(${cls}::int4, hashtext(${key}))`);
  };
  // Whether the user exists and is enabled (and, for `service`, is a service principal). `lock` in every write that
  // mints for the user takes FOR SHARE on the users row (see the header); a read passes false (the read pool is
  // read-only, where FOR SHARE fails 25006).
  const activeUser = async (sql: PgSql, id: number, lock: boolean, kind: "service" | null = null) => {
    const share = lock ? sql.fragment`FOR SHARE OF u` : sql.fragment``;
    const rows = kind === "service"
      ? await sql`SELECT 1 FROM users u JOIN principals p ON p.user_id = u.id AND p.kind = 'service' WHERE u.id = ${id} AND u.disabled_at IS NULL ${share}`
      : await sql`SELECT 1 FROM users u WHERE u.id = ${id} AND u.disabled_at IS NULL ${share}`;
    return rows.length > 0;
  };
  const audit = async (sql: PgSql, action: AuditAction, g: OAuthGrant, now: number, detail: AuditDetail = {}) => {
    const [user] = await sql`SELECT email FROM users WHERE id = ${g.userId}`;
    await insertAudit(sql, now, (user?.email as string | undefined) ?? null, action, g.id, { client_id: g.clientId, ...detail });
  };
  const sessionAudit = async (sql: PgSql, action: AuditAction, c: OAuthCode, sessionId: number, now: number, detail: AuditDetail = {}) => {
    const [user] = await sql`SELECT email FROM users WHERE id = ${c.userId}`;
    await insertAudit(sql, now, (user?.email as string | undefined) ?? null, action, null, { client_id: c.clientId, token_session: sessionId, ...detail });
  };
  const read = async <T>(sql: PgSql, table: "oauth_requests" | "oauth_browsers" | "oauth_codes", h: string, now: number): Promise<T | undefined> => {
    if (!lookup(h, now)) return undefined;
    const [row] = await sql`SELECT data FROM ${sql(table)} WHERE hash = ${h} AND expires_at > ${now}`;
    return row ? row.data as T : undefined;
  };
  const grant = async (sql: PgSql, id: string, lock = false): Promise<OAuthGrant | undefined> => {
    const [row] = lock
      ? await sql`SELECT data, revoked_at FROM oauth_grants WHERE id = ${id} FOR SHARE`
      : await sql`SELECT data, revoked_at FROM oauth_grants WHERE id = ${id}`;
    return row ? grantOf(row) : undefined;
  };
  // Mints nothing for the user: a rotation's pair goes under an existing grant, which a disable's revoke sees.
  const live = async (sql: PgSql, g: OAuthGrant | undefined, now: number): Promise<boolean> =>
    !!g && time(now) && g.revokedAt === null && g.expiresAt > now && await activeUser(sql, g.userId, false);
  const insertPair = async (sql: PgSql, p: OAuthTokenPair, id: string, now: number) => {
    await sql`INSERT INTO oauth_tokens (hash, grant_id, kind, expires_at, created_at, access_scopes)
      VALUES (${p.accessHash}, ${id}, 'access', ${p.accessExpiresAt}, ${now}, ${JSON.stringify(p.scopes)}),
             (${p.refreshHash}, ${id}, 'refresh', ${p.refreshExpiresAt}, ${now}, NULL)`;
  };
  // The grant's revoke, then its hosted sessions' end (the hosted port), in the caller's transaction.
  const revokeGrant = async (tx: Tx, id: string, now: number) => {
    await pgOf(tx)`UPDATE oauth_grants SET revoked_at = ${now} WHERE id = ${id} AND revoked_at IS NULL`;
    await hosted.endForGrant(tx, id, now);
  };
  // A credential whose grant is live and whose service is enabled (#270 D2).
  const liveCredential = async (sql: PgSql, clientId: string, now: number) => {
    if (!clientLookup(clientId, now)) return undefined;
    const [r] = await sql`SELECT c.id, c.user_id, c.grant_id, c.source, c.token_seconds FROM service_credentials c
      JOIN oauth_grants g ON g.id = c.grant_id JOIN users u ON u.id = c.user_id
      WHERE c.client_id = ${clientId} AND g.revoked_at IS NULL AND g.expires_at > ${now} AND u.disabled_at IS NULL`;
    return r ? { id: int8(r.id), userId: int8(r.user_id), grantId: r.grant_id as string, source: r.source as CredentialSource, tokenSeconds: int8(r.token_seconds) } : undefined;
  };
  type Token = { kind: string; grant_id: string; spent_at: number | null; revoked_at: number | null; expires_at: number };
  const token = async (sql: PgSql, h: string): Promise<Token | undefined> => {
    const [r] = await sql`SELECT kind, grant_id, spent_at, revoked_at, expires_at FROM oauth_tokens WHERE hash = ${h}`;
    return r ? { kind: r.kind as string, grant_id: r.grant_id as string, spent_at: int8OrNull(r.spent_at), revoked_at: int8OrNull(r.revoked_at), expires_at: int8(r.expires_at) } : undefined;
  };
  const browser = async (sql: PgSql, h: string, now: number, lock: boolean) => {
    const b = await read<OAuthBrowserSession>(sql, "oauth_browsers", h, now);
    return b && await activeUser(sql, b.userId, lock) ? b : undefined;
  };
  // A code row and the checks both redeemers share (#928 D8), as db.ts.
  type CodeRow = { c: OAuthCode; expires_at: number; grant_id: string | null; session_id: number | null };
  const codeRow = async (sql: PgSql, h: string): Promise<CodeRow | undefined> => {
    const [r] = await sql`SELECT data, expires_at, grant_id, session_id FROM oauth_codes WHERE hash = ${h}`;
    return r ? { c: r.data as OAuthCode, expires_at: int8(r.expires_at), grant_id: r.grant_id as string | null, session_id: int8OrNull(r.session_id) } : undefined;
  };
  const presented = async (sql: PgSql, input: OAuthAuthorization & { codeHash: string }, now: number): Promise<CodeRow | OAuthFailure> => {
    if (!lookup(input.codeHash, now)) return invalid;
    const row = await codeRow(sql, input.codeHash);
    if (!row) return missing;
    return sameAuthorization(row.c, input) ? row : invalid;
  };
  // Both redeemers mint for the code's user (a grant, a CLI session), so the user read locks.
  const usable = async (sql: PgSql, row: CodeRow, now: number): Promise<OAuthFailure | undefined> =>
    row.expires_at <= now ? missing : await activeUser(sql, row.c.userId, true) ? undefined : invalid;
  const liveSession = async (sql: PgSql, id: number) => (await sql`SELECT 1 FROM sessions WHERE id = ${id} AND revoked_at IS NULL`).length > 0;
  // Spends a code by naming what it minted; false when another redeemer spent it first (it waited on that one's row
  // lock and re-checked this WHERE after its commit).
  const spendCode = async (sql: PgSql, column: "grant_id" | "session_id", minted: string | number, h: string) =>
    (await sql`UPDATE oauth_codes SET ${sql(column)} = ${minted} WHERE hash = ${h} AND grant_id IS NULL AND session_id IS NULL RETURNING hash`).length > 0;
  // A replayed code revokes what it minted: the code leaked, so the grant or session may have too.
  const grantCodeReplay = async (tx: Tx, id: string, now: number) => {
    const sql = pgOf(tx);
    const g = await grant(sql, id);
    if (!g || g.expiresAt <= now) return missing;
    await revokeGrant(tx, g.id, now);
    await audit(sql, "oauth.code_replay_revoked", g, now, { level: "warning" });
    return replay;
  };
  const loginCodeReplay = async (sql: PgSql, c: OAuthCode, sessionId: number, now: number) => {
    await sql`UPDATE sessions SET revoked_at = ${now} WHERE id = ${sessionId} AND revoked_at IS NULL`;
    await sessionAudit(sql, "oauth.code_replay_revoked", c, sessionId, now, { level: "warning" });
    return replay;
  };
  const refreshReplay = async (tx: Tx, g: OAuthGrant, now: number) => {
    await revokeGrant(tx, g.id, now);
    await audit(pgOf(tx), "oauth.refresh_replay_revoked", g, now, { level: "warning" });
    return replay;
  };
  const count = async (rows: Promise<Row[]>) => int8((await rows)[0]!.n);

  return {
    async createRequest(tx, input, now) {
      if (!requestInput(input, now)) return invalid;
      const sql = pgOf(tx);
      await lock(sql, OAUTH_REQUESTS_LOCK);
      await sql`DELETE FROM oauth_requests WHERE expires_at <= ${now}`;
      const n = await count(sql`SELECT count(*) AS n FROM oauth_requests WHERE browser_hash = ${input.browserHash}`);
      const total = await count(sql`SELECT count(*) AS n FROM oauth_requests`);
      if (n >= REQUESTS_PER_BROWSER || total >= REQUESTS_TOTAL) return capacity;
      await sql`INSERT INTO oauth_requests (hash, browser_hash, expires_at, data) VALUES (${input.requestHash}, ${input.browserHash}, ${input.expiresAt}, ${requestData(input)})`;
      return ok(input);
    },
    async findRequest(r, requestHash, browserHash, now) {
      const req = await read<OAuthRequest>(pgOf(r), "oauth_requests", requestHash, now);
      return req?.browserHash === browserHash ? req : undefined;
    },
    async bindRequestSession(tx, requestHash, browserHash, sessionHash, now) {
      const sql = pgOf(tx);
      const r = await read<OAuthRequest>(sql, "oauth_requests", requestHash, now);
      // Binding mints nothing: decideRequest re-reads the session's user, locked, before it inserts the code.
      const b = await browser(sql, sessionHash, now, false);
      if (!r || !b) return missing;
      if (r.browserHash !== browserHash || (r.consentSessionHash !== null && r.consentSessionHash !== sessionHash)) return invalid;
      const bound = { ...r, consentSessionHash: sessionHash };
      // Binds once in one statement (D3): a binder racing another browser session waits on this row and, after the
      // other's commit, finds it bound elsewhere.
      const set = await sql`UPDATE oauth_requests SET data = ${bound} WHERE hash = ${requestHash}
        AND coalesce(data->>'consentSessionHash', ${sessionHash}) = ${sessionHash} RETURNING hash`;
      return set.length ? ok(bound) : missing;
    },
    async createBrowserSession(tx, input, now, replaceHash) {
      if (!browserSessionInput(input, now)) return invalid;
      const sql = pgOf(tx);
      if (!await activeUser(sql, input.userId, true)) return invalid;
      await lock(sql, OAUTH_BROWSERS_LOCK);
      await sql`DELETE FROM oauth_browsers WHERE expires_at <= ${now}`;
      if (await count(sql`SELECT count(*) AS n FROM oauth_browsers`) >= BROWSER_SESSIONS) return capacity;
      if (replaceHash) await sql`DELETE FROM oauth_browsers WHERE hash = ${replaceHash}`;
      await sql`INSERT INTO oauth_browsers (hash, user_id, expires_at, data) VALUES (${input.sessionHash}, ${input.userId}, ${input.expiresAt}, ${browserData(input)})`;
      return ok(input);
    },
    findBrowserSession: (r, h, now) => browser(pgOf(r), h, now, false),
    async revokeBrowserSession(tx, h) {
      await pgOf(tx)`DELETE FROM oauth_browsers WHERE hash = ${h}`;
    },
    async decideRequest(tx, input, now) {
      const sql = pgOf(tx);
      const r = await read<OAuthRequest>(sql, "oauth_requests", input.requestHash, now);
      const b = await browser(sql, input.sessionHash, now, true);
      if (!r || !b) return missing;
      if (r.browserHash !== input.browserHash || r.csrfHash !== input.csrfHash || r.consentSessionHash !== input.sessionHash) return invalid;
      const c = input.code;
      if (input.approve && !codeInput(r, c, b.userId, now)) return invalid;
      // The delete consumes the request (D3): a second decider waits on the row and then deletes nothing.
      if (!(await sql`DELETE FROM oauth_requests WHERE hash = ${input.requestHash} RETURNING hash`).length) return missing;
      if (!input.approve) return ok(null);
      await sql`INSERT INTO oauth_codes (hash, user_id, expires_at, data) VALUES (${c.codeHash}, ${c.userId}, ${c.expiresAt}, ${codeData(c)})`;
      return ok(c);
    },
    async findCodeScopes(r, h, clientId, resource, redirectUri, now) {
      if (!lookup(h, now)) return undefined;
      const sql = pgOf(r);
      const row = await codeRow(sql, h);
      if (!row) return undefined;
      const { c } = row;
      if (c.clientId !== clientId || c.resource !== resource || c.redirectUri !== redirectUri || !await activeUser(sql, c.userId, false)) return undefined;
      // A spent code stays findable while what it minted lives, so a replay reaches its redeemer and revokes it.
      if (row.grant_id !== null ? !await live(sql, await grant(sql, row.grant_id), now)
        : row.session_id !== null ? !await liveSession(sql, row.session_id) : row.expires_at <= now) return undefined;
      return [...c.scopes];
    },
    async redeemCode(tx, input, now) {
      const sql = pgOf(tx);
      const row = await presented(sql, input, now);
      if ("status" in row) return row;
      const { c } = row;
      // A login code, spent or not, never becomes a grant (#928 D8).
      if (row.session_id !== null || c.scopes.includes(LOGIN_SCOPE)) return invalid;
      if (row.grant_id !== null) return grantCodeReplay(tx, row.grant_id, now);
      const unusable = await usable(sql, row, now);
      if (unusable) return unusable;
      if (!grantInput(input, c, now)) return invalid;
      const g: OAuthGrant = { id: input.grantId, userId: c.userId, clientId: c.clientId, resource: c.resource,
        scopes: c.scopes, createdAt: now, expiresAt: input.grantExpiresAt, revokedAt: null };
      await sql`INSERT INTO oauth_grants (id, user_id, expires_at, data) VALUES (${g.id}, ${g.userId}, ${g.expiresAt}, ${g})`;
      // The statement that sets grant_id spends the code (D3). A loser withdraws its grant and answers as a replay, or
      // not_found when the code or the winner's grant is gone.
      if (!await spendCode(sql, "grant_id", g.id, input.codeHash)) {
        await sql`DELETE FROM oauth_grants WHERE id = ${g.id}`;
        const winner = (await codeRow(sql, input.codeHash))?.grant_id;
        return winner ? grantCodeReplay(tx, winner, now) : missing;
      }
      await insertPair(sql, input.tokens, g.id, now);
      await audit(sql, "oauth.grant_issued", g, now);
      return ok({ grant: g, tokens: input.tokens });
    },
    async redeemLoginCode(tx, input, now) {
      const sql = pgOf(tx);
      const row = await presented(sql, input, now);
      if ("status" in row) return row;
      const { c } = row;
      if (row.grant_id !== null || !isLogin(c)) return invalid;
      if (row.session_id !== null) return loginCodeReplay(sql, c, row.session_id, now);
      const unusable = await usable(sql, row, now);
      if (unusable) return unusable;
      if (!loginInput(input)) return invalid;
      const [s] = await sql`INSERT INTO sessions (user_id, token_hash, created_at, last_used_at, label)
        VALUES (${c.userId}, ${input.tokenHash}, ${now}, ${now}, ${input.label}) RETURNING id`;
      const sessionId = int8(s!.id);
      // As redeemCode: setting session_id spends the code; a loser withdraws its session and answers as a replay.
      if (!await spendCode(sql, "session_id", sessionId, input.codeHash)) {
        await sql`DELETE FROM sessions WHERE id = ${sessionId}`;
        const winner = (await codeRow(sql, input.codeHash))?.session_id;
        return winner ? loginCodeReplay(sql, c, winner, now) : missing;
      }
      await sessionAudit(sql, "oauth.session_issued", c, sessionId, now);
      return ok({ sessionId, userId: c.userId });
    },
    async findRefreshGrant(r, h, clientId, resource, now) {
      if (!lookup(h, now)) return undefined;
      const [row] = await pgOf(r)`SELECT g.data FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id JOIN users u ON u.id = g.user_id
        WHERE t.hash = ${h} AND t.kind = 'refresh' AND g.revoked_at IS NULL AND g.expires_at > ${now} AND u.disabled_at IS NULL`;
      if (!row) return undefined;
      const g = row.data as OAuthGrant;
      return g.clientId === clientId && g.resource === resource ? g : undefined;
    },
    async rotateRefresh(tx, input, now) {
      if (!lookup(input.refreshHash, now)) return invalid;
      const sql = pgOf(tx);
      const t = await token(sql, input.refreshHash);
      if (!t || t.kind !== "refresh") return missing;
      // FOR SHARE (#1066): a grant revoke's UPDATE waits for this rotation to commit, and a rotation behind a revoke
      // reads the revoked row once it commits, so a rotation never answers ok under a grant revoked before it.
      const g = await grant(sql, t.grant_id, true);
      if (!g || !rotationBinding(g, input)) return invalid;
      if (!await live(sql, g, now)) return invalid;
      // A recognized ancestor revokes even after its sliding expiry; tombstones outlive it.
      if (t.spent_at !== null) return refreshReplay(tx, g, now);
      if (t.revoked_at !== null || t.expires_at <= now || !successorInput(input, now)) return invalid;
      const tokens = clampPair(input.tokens, g.expiresAt);
      await insertPair(sql, tokens, g.id, now);
      // The statement that sets spent_at spends the token (D3): a second rotation waits on the row and, after the first
      // commits, matches nothing; it withdraws its pair and its re-read sees spent_at.
      const spent = await sql`UPDATE oauth_tokens SET spent_at = ${now}
        WHERE hash = ${input.refreshHash} AND kind = 'refresh' AND spent_at IS NULL AND revoked_at IS NULL AND expires_at > ${now} RETURNING hash`;
      if (!spent.length) {
        await sql`DELETE FROM oauth_tokens WHERE hash IN (${tokens.accessHash}, ${tokens.refreshHash})`;
        return (await token(sql, input.refreshHash))?.spent_at != null ? refreshReplay(tx, g, now) : invalid;
      }
      await audit(sql, "oauth.refreshed", g, now);
      return ok({ grant: g, tokens });
    },
    async revokeToken(tx, h, clientId, now) {
      if (!lookup(h, now)) return;
      const sql = pgOf(tx);
      const t = await token(sql, h);
      if (!t) return;
      const g = await grant(sql, t.grant_id);
      if (!g || g.clientId !== clientId) return;
      if (t.kind === "refresh") await revokeGrant(tx, g.id, now);
      else await sql`UPDATE oauth_tokens SET revoked_at = ${now} WHERE hash = ${h} AND revoked_at IS NULL`;
      await audit(sql, "oauth.revoked", g, now, { kind: t.kind });
    },
    async findActiveAccess(r, h, resource, requiredScopes, now) {
      if (!accessLookup(h, requiredScopes, now)) return undefined;
      // One statement, so one snapshot binds token, grant, user and (for a run token) secret liveness. The secret join
      // is what refuses a run token minted while its secret's revoke ran: the revoke's token UPDATE can't see a mint
      // that commits after it (D3).
      const [row] = await pgOf(r)`SELECT g.data, t.created_at, t.expires_at AS token_expiry, t.access_scopes, g.expires_at AS grant_expiry, c.source
        FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id JOIN users u ON u.id = g.user_id
        LEFT JOIN service_credentials c ON c.grant_id = g.id LEFT JOIN service_credential_secrets s ON s.id = t.secret_id
        WHERE t.hash = ${h} AND t.kind = 'access' AND t.revoked_at IS NULL AND t.expires_at > ${now} AND (t.secret_id IS NULL OR s.revoked_at IS NULL)
          AND g.revoked_at IS NULL AND g.expires_at > ${now} AND u.disabled_at IS NULL`;
      if (!row) return undefined;
      const g = row.data as OAuthGrant;
      // Pre-downscope rows were issued with exactly the full grant scope.
      const accessScopes: string[] = row.access_scopes === null ? g.scopes : JSON.parse(row.access_scopes as string);
      if (!accessFits(g, accessScopes, resource, requiredScopes)) return undefined;
      const a: OAuthAccess = { tokenHash: h, grantId: g.id, userId: g.userId, clientId: g.clientId, resource: g.resource, scopes: accessScopes,
        createdAt: int8(row.created_at), expiresAt: int8(row.token_expiry), grantExpiresAt: int8(row.grant_expiry), source: row.source as CredentialSource | null };
      return a;
    },
    async isGrantActive(r, id, now) {
      if (!time(now)) return false;
      return (await pgOf(r)`SELECT 1 FROM oauth_grants g JOIN users u ON u.id = g.user_id
        WHERE g.id = ${id} AND g.revoked_at IS NULL AND g.expires_at > ${now} AND u.disabled_at IS NULL`).length > 0;
    },
    async revokePreBuiltinGrants(tx, clientIds, now, key = "builtin_clients") {
      if (!time(now)) throw new RangeError("invalid OAuth cutover time");
      const sql = pgOf(tx);
      // The key is claimed first (D3): a second pod booting at once waits on this uncommitted row, then inserts nothing
      // and returns 0 without revoking or auditing. Its value is the time of the first run.
      if (!(await sql`INSERT INTO server_state (key, value) VALUES (${key}, ${now}) ON CONFLICT (key) DO NOTHING RETURNING key`).length) return 0;
      const ids = [...clientIds];
      // An operator client could use these IDs before #429; its grants and codes must not become a built-in's. Counted
      // from what this UPDATE revoked, so a grant another writer revoked meanwhile is neither counted nor audited.
      const revoked = await sql`UPDATE oauth_grants SET revoked_at = ${now}
        WHERE revoked_at IS NULL AND data->>'clientId' = ANY(${ids}::text[]) RETURNING data, revoked_at`;
      for (const row of revoked) {
        const g = grantOf(row);
        await hosted.endForGrant(tx, g.id, now);
        await audit(sql, "oauth.builtin_client_grant_revoked", g, now);
      }
      await sql`DELETE FROM oauth_codes WHERE grant_id IS NULL AND data->>'clientId' = ANY(${ids}::text[])`;
      return revoked.length;
    },
    async cleanup(tx, now) {
      if (!time(now)) throw new RangeError("invalid OAuth cleanup time");
      const sql = pgOf(tx);
      await sql`DELETE FROM oauth_requests WHERE expires_at <= ${now}`;
      await sql`DELETE FROM oauth_browsers WHERE expires_at <= ${now}`;
      // A spent login code is kept while its session lives, as a grant code is while its grant does (replay).
      await sql`DELETE FROM oauth_codes WHERE grant_id IS NULL AND expires_at <= ${now}
        AND (session_id IS NULL OR session_id NOT IN (SELECT id FROM sessions WHERE revoked_at IS NULL))`;
      await sql`DELETE FROM oauth_tokens WHERE kind = 'access' AND expires_at <= ${now}`;
      // A revoked service secret once its last token is gone (#270 D2); an expired credential goes with its grant.
      await sql`DELETE FROM service_credential_secrets s WHERE s.revoked_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.secret_id = s.id)`;
      // Keep refresh tombstones until the absolute family deadline, including revoked families.
      await sql`DELETE FROM oauth_grants WHERE expires_at <= ${now}`;
    },
    async addServiceCredential(tx, input, now) {
      const { userId, clientId, grantId, resource, source, tokenSeconds, expiresAt, secretHash } = input;
      if (!serviceCredentialInput(input, now)) return invalid;
      const sql = pgOf(tx);
      // Only an enabled service holds a credential (D1): a person's grant comes from consent, never from here.
      if (!await activeUser(sql, userId, true, "service")) return invalid;
      const g: OAuthGrant = { id: grantId, userId, clientId, resource, scopes: [...OAUTH_SCOPES], createdAt: now, expiresAt, revokedAt: null };
      await sql`INSERT INTO oauth_grants (id, user_id, expires_at, data) VALUES (${g.id}, ${g.userId}, ${g.expiresAt}, ${g})`;
      const [c] = await sql`INSERT INTO service_credentials (client_id, user_id, grant_id, source, token_seconds, created_at)
        VALUES (${clientId}, ${userId}, ${grantId}, ${source}, ${tokenSeconds}, ${now}) RETURNING id`;
      const [s] = await sql`INSERT INTO service_credential_secrets (credential_id, hash, created_at) VALUES (${c!.id}, ${secretHash}, ${now}) RETURNING id`;
      return ok({ secretId: int8(s!.id) });
    },
    async rotateServiceCredential(tx, { clientId, secretHash }, now) {
      if (!serviceSecretInput({ clientId, secretHash }, now)) return invalid;
      const sql = pgOf(tx);
      // At most two live secrets (D2), counted after the credential's secrets lock, so two rotations at one live secret
      // don't both count one.
      await lock(sql, CREDENTIAL_SECRETS_LOCK, clientId);
      const c = await liveCredential(sql, clientId, now);
      if (!c) return missing;
      const [s] = await sql`INSERT INTO service_credential_secrets (credential_id, hash, created_at)
        SELECT ${c.id}::int8, ${secretHash}, ${now}::int8
        WHERE (SELECT count(*) FROM service_credential_secrets WHERE credential_id = ${c.id} AND revoked_at IS NULL) < ${LIVE_SECRETS}
        RETURNING id`;
      return s ? ok({ secretId: int8(s.id), userId: c.userId }) : capacity;
    },
    async revokeServiceCredential(tx, clientId, now) {
      if (!clientLookup(clientId, now)) return invalid;
      const sql = pgOf(tx);
      // FOR NO KEY UPDATE on the grant: a second revoke waits here, re-checks the grant after this one commits and
      // answers missing, as on SQLite (one revoke, one audit row). A mint's FK insert takes only KEY SHARE on it.
      const [c] = await sql`SELECT c.grant_id, c.user_id FROM service_credentials c
        JOIN oauth_grants g ON g.id = c.grant_id WHERE c.client_id = ${clientId} AND g.revoked_at IS NULL FOR NO KEY UPDATE OF g`;
      if (!c) return missing;
      // The grant's revocation ends every session attached to it, in this transaction (D2, #226 §3.4). A mint or
      // rotation racing it lands under a revoked grant, which findActiveAccess and liveCredential refuse.
      await revokeGrant(tx, c.grant_id as string, now);
      return ok({ userId: int8(c.user_id) });
    },
    async revokeServiceSecret(tx, secretId, now) {
      if (!secretLookup(secretId, now)) return invalid;
      const sql = pgOf(tx);
      // The secrets lock first (keyed by the secret's credential, which never changes): two revokes of a credential's
      // two secrets would otherwise each count the other live and leave it none.
      await sql`SELECT pg_advisory_xact_lock(${CREDENTIAL_SECRETS_LOCK}::int4, hashtext(c.client_id))
        FROM service_credential_secrets s JOIN service_credentials c ON c.id = s.credential_id WHERE s.id = ${secretId}`;
      const [s] = await sql`SELECT s.credential_id, c.client_id, c.user_id, g.revoked_at AS grant_revoked
        FROM service_credential_secrets s JOIN service_credentials c ON c.id = s.credential_id JOIN oauth_grants g ON g.id = c.grant_id
        WHERE s.id = ${secretId} AND s.revoked_at IS NULL`;
      if (!s || s.grant_revoked !== null) return missing;
      // The last live secret stays: revoking it would leave a live grant no one can mint under; revoke the credential.
      if (await count(sql`SELECT count(*) AS n FROM service_credential_secrets WHERE credential_id = ${s.credential_id} AND id <> ${secretId} AND revoked_at IS NULL`) === 0) return invalid;
      await sql`UPDATE service_credential_secrets SET revoked_at = ${now} WHERE id = ${secretId}`;
      // A mint racing this commits a token this UPDATE can't see; findActiveAccess's secret join refuses it (D3), and
      // the secret UPDATE above moves every process's auth generation (0001's triggers, D5), so no cache keeps it live.
      await sql`UPDATE oauth_tokens SET revoked_at = ${now} WHERE secret_id = ${secretId} AND revoked_at IS NULL`;
      return ok({ clientId: s.client_id as string, userId: int8(s.user_id) });
    },
    async findServiceCredential(r, clientId, now) {
      const sql = pgOf(r);
      const c = await liveCredential(sql, clientId, now);
      if (!c) return undefined;
      const secrets = (await sql`SELECT id, hash FROM service_credential_secrets WHERE credential_id = ${c.id} AND revoked_at IS NULL ORDER BY id`)
        .map((s: Row) => ({ id: int8(s.id), hash: s.hash as string }));
      const found: ServiceCredential = { clientId, userId: c.userId, grantId: c.grantId, source: c.source, tokenSeconds: c.tokenSeconds, secrets };
      return found;
    },
    async mintServiceToken(tx, { clientId, secretId, tokenHash, scopes: selected, limits }, now) {
      if (!mintInput({ secretId, tokenHash, scopes: selected, limits }, now)) return invalid;
      const sql = pgOf(tx);
      // The bucket and the cap are counted after the credential's mint lock: two mints at cap-1 would otherwise both
      // count cap-1. The INSERT ... SELECT starts after the lock is granted, so its counts see the previous mint.
      await lock(sql, CREDENTIAL_MINT_LOCK, clientId);
      // The expiry is the credential's lifetime, clamped to the ceiling and to the grant's expiry.
      const [row] = await sql`INSERT INTO oauth_tokens (hash, grant_id, kind, expires_at, created_at, access_scopes, secret_id)
        SELECT ${tokenHash}, g.id, 'access', LEAST(${now}::int8 + LEAST(c.token_seconds, ${limits.maxSeconds}::int8) * 1000, g.expires_at), ${now}::int8, ${JSON.stringify(selected)}, s.id
        FROM service_credentials c JOIN oauth_grants g ON g.id = c.grant_id JOIN users u ON u.id = c.user_id
        JOIN service_credential_secrets s ON s.credential_id = c.id
        WHERE c.client_id = ${clientId} AND s.id = ${secretId} AND s.revoked_at IS NULL AND g.revoked_at IS NULL AND g.expires_at > ${now} AND u.disabled_at IS NULL
          AND (SELECT count(*) FROM oauth_tokens t WHERE t.grant_id = g.id AND t.created_at > ${now}::int8 - ${MINT_WINDOW_MS}::int8) < ${limits.mintsPerMinute}
          AND (SELECT count(*) FROM oauth_tokens t WHERE t.grant_id = g.id AND t.revoked_at IS NULL AND t.expires_at > ${now}) < ${limits.unexpired}
        RETURNING expires_at, grant_id`;
      if (!row) {
        const live = await liveCredential(sql, clientId, now);
        const secret = live && (await sql`SELECT 1 FROM service_credential_secrets WHERE id = ${secretId} AND credential_id = ${live.id} AND revoked_at IS NULL`).length > 0;
        return secret ? capacity : invalid;
      }
      const expiresAt = int8(row.expires_at);
      const g = (await grant(sql, row.grant_id as string))!;
      await audit(sql, "oauth.token_issued", g, now, { secret_id: secretId, expires_at: expiresAt });
      return ok({ expiresAt });
    },
  };
}
