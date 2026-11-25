// The OAuth store's contract (#807 P3 C4, docs/future/postgres-server.md D9): every OAuthStore method, written once over
// a harness so both stores run the same rows. Not a *.test.ts file, so Bun doesn't discover it: a backend's test file
// registers it under a describe() (oauth-store.test.ts for SQLite, pg/oauth.contract.pg.test.ts for Postgres).
//
// Portability rules the rows follow:
// - Each row opens a fresh store and asserts no absolute id: ids are compared to the rows the row itself made.
// - Every time is a fixed epoch passed as `now`; nothing reads a clock the store's answers depend on.
// - The rows are serial. An interleaving (a spend racing a spend, a mint racing a disable, two boots claiming the
//   cutover key) is a backend's own test: SQLite forces it with a trigger or a second process (oauth-store.test.ts),
//   Postgres with two connections (C4b's pg/oauth.pg.test.ts). So reverting a claim-first or locked form to its
//   read-then-write form passes here on every backend; what these rows pin is each method's serial answer.
// - Fixture writes the store doesn't offer (a bulk of browser sessions) and the raw reads (a table's rows, an action's
//   audit rows) are the harness's. A row's columns come back with integers as numbers and `data` parsed, with
//   `data_type` the stored JSON's type as the database computes it (SQLite json_type, Postgres jsonb_typeof): a
//   double-stringified object reads "text"/"string", not "object", whatever the harness's parse makes of it.
// - The disable and revoke-all a mint must lose to are the harness's (users.setDisabled, sessions.revokeAllForUser),
//   which C4b ports beside the store (c4-scope decision 3).
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { OAUTH_SCOPES } from "../oauth-config.ts";
import { OAUTH_TTL, type OAuthAuthorization, type OAuthBinding, type OAuthCode, type OAuthRequest, type OAuthStore, type OAuthTokenPair,
  type ServiceTokenLimits } from "../oauth-types.ts";
import type { ServicesStore, SessionsStore, UsersStore } from "./identity.ts";
import type { Read, Tx } from "./tx_base.ts";

export type OAuthTable = "oauth_requests" | "oauth_browsers" | "oauth_codes" | "oauth_grants" | "oauth_tokens" |
  "service_credentials" | "service_credential_secrets" | "server_state" | "sessions";
export type Row = Record<string, unknown>;

// One store, fresh per row.
export type OAuthHarness = {
  oauth: OAuthStore;
  users: Pick<UsersStore, "upsertByEmail">;
  sessions: Pick<SessionsStore, "create" | "revoke" | "revokeOwn" | "findById" | "findByTokenHash">;
  services: Pick<ServicesStore, "create">;
  write<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  read: Read;
  // Each in its own transaction. setDisabled and revokeAllForUser are the users and sessions groups' own; `disable`
  // sets disabled_at alone, as a disable looks to a mint whose earlier reads (its browser session, its code) predate it.
  setDisabled(userId: number, disabled: boolean): Promise<void>;
  disable(userId: number): Promise<void>;
  revokeAllForUser(userId: number): Promise<void>;
  // n browser sessions for the user, expiring at `expiresAt`, in one statement (the 10,000 cap's fixture).
  fillBrowsers(userId: number, n: number, expiresAt: number): Promise<void>;
  // Raw reads: a table's rows (any order); an action's access_log rows in write order, detail parsed.
  rows(table: OAuthTable): Promise<Row[]>;
  audits(action: string): Promise<{ actor: string | null; target: string | null; detail: unknown; detail_type: string | null }[]>;
  close(): void | Promise<void>;
};

export type OAuthBackend = { kind: "sqlite" | "postgres"; open(): Promise<OAuthHarness> };

const EMAIL = "you@example.com";
const start = 1_800_000_000_000;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const binding: OAuthAuthorization = { clientId: "native", resource: "https://example.com/mcp", scopes: ["grayboard:tools"], redirectUri: "http://127.0.0.1/callback", codeChallenge: "A".repeat(43) };
const login: OAuthAuthorization = { ...binding, scopes: ["grayboard:login"] };
const full = ["grayboard:delivery", "grayboard:tools"];
let serial = 0;
const pair = (b: OAuthBinding = binding, now = start, cap = now + OAUTH_TTL.grant): OAuthTokenPair => ({ ...b,
  accessHash: sha(`access-${++serial}`), refreshHash: sha(`refresh-${serial}`),
  accessExpiresAt: Math.min(now + OAUTH_TTL.access, cap), refreshExpiresAt: Math.min(now + OAUTH_TTL.refresh, cap) });
const status = async (p: Promise<{ status: string }>) => (await p).status;

// A user with a browser session, and a consent request and code for `auth` ready to issue. `tag` keeps two worlds'
// hashes apart in one store; they share the user.
async function world(h: OAuthHarness, tag = "", auth: OAuthAuthorization = binding) {
  const userId = (await h.write(tx => h.users.upsertByEmail(tx, EMAIL, null))).id;
  const sessionHash = sha(`browser-session${tag}`);
  expect(await status(h.write(tx => h.oauth.createBrowserSession(tx, { sessionHash, userId, createdAt: start, expiresAt: start + OAUTH_TTL.browser }, start)))).toBe("ok");
  const w = {
    userId, sessionHash, auth,
    request: { ...auth, requestHash: sha(`request${tag}`), browserHash: sha(`browser${tag}`), csrfHash: sha(`csrf${tag}`), stateHash: sha(`state${tag}`),
      consentSessionHash: null, createdAt: start, expiresAt: start + OAUTH_TTL.request } as OAuthRequest,
    code: { ...auth, userId, codeHash: sha(`code${tag}`), createdAt: start, expiresAt: start + OAUTH_TTL.code } as OAuthCode,
    decision: () => ({ requestHash: w.request.requestHash, browserHash: w.request.browserHash, csrfHash: w.request.csrfHash, sessionHash, approve: true, code: w.code }),
    async issueCode() {
      await h.write(async tx => {
        expect((await h.oauth.createRequest(tx, w.request, start)).status).toBe("ok");
        expect((await h.oauth.bindRequestSession(tx, w.request.requestHash, w.request.browserHash, sessionHash, start)).status).toBe("ok");
        expect((await h.oauth.decideRequest(tx, w.decision(), start)).status).toBe("ok");
      });
    },
    redemption: (tokens = pair(w.auth), grantId = `grant_${tag.replace(/\W/g, "")}0123456789abcdef`) =>
      ({ ...w.auth, codeHash: w.code.codeHash, grantId, grantExpiresAt: start + OAUTH_TTL.grant, tokens }),
    async issue() {
      await w.issueCode();
      const input = w.redemption();
      expect(await status(h.write(tx => h.oauth.redeemCode(tx, input, start)))).toBe("ok");
      return input;
    },
  };
  return w;
}

export function oauthContract(backend: OAuthBackend): void {
  const it = (name: string, fn: (h: OAuthHarness) => Promise<void>, timeout?: number) => test(name, async () => {
    const h = await backend.open();
    try { await fn(h); } finally { await h.close(); }
  }, timeout);
  consent(it);
  codes(it);
  refresh(it);
  access(it);
  browsersAndCaps(it);
  loginCodes(it);
  cutover(it);
  serviceCredentials(it);
  userGrants(it);
}

type It = (name: string, fn: (h: OAuthHarness) => Promise<void>, timeout?: number) => void;

function consent(it: It): void {
  it("consent is one-use, browser/CSRF/session/account bound, including denial", async h => {
    const w = await world(h);
    const o = h.oauth;
    await h.write(tx => o.createRequest(tx, w.request, start));
    // Unbound: no decision yet.
    expect(await status(h.write(tx => o.decideRequest(tx, w.decision(), start)))).toBe("invalid");
    expect(await status(h.write(tx => o.bindRequestSession(tx, w.request.requestHash, w.request.browserHash, w.sessionHash, start)))).toBe("ok");
    const alternate = sha("another-session");
    await h.write(tx => o.createBrowserSession(tx, { sessionHash: alternate, userId: w.userId, createdAt: start, expiresAt: start + 1000 }, start));
    expect(await status(h.write(tx => o.bindRequestSession(tx, w.request.requestHash, w.request.browserHash, alternate, start)))).toBe("invalid");
    expect(await status(h.write(tx => o.decideRequest(tx, { ...w.decision(), sessionHash: alternate }, start)))).toBe("invalid");
    expect(await o.findRequest(h.read, w.request.requestHash, sha("other"), start)).toBeUndefined();
    expect(await o.findRequest(h.read, w.request.requestHash, w.request.browserHash, start)).toMatchObject({ consentSessionHash: w.sessionHash });
    for (const change of [{ browserHash: sha("other") }, { csrfHash: sha("other") }, { sessionHash: sha("other") }, { code: { ...w.code, userId: w.userId + 1 } },
      { code: { ...w.code, resource: "wrong" } }, { code: { ...w.code, codeHash: "raw-code" } }, { code: { ...w.code, expiresAt: start + OAUTH_TTL.code + 1 } }]) {
      expect(await status(h.write(tx => o.decideRequest(tx, { ...w.decision(), ...change }, start)))).not.toBe("ok");
    }
    expect(await h.write(tx => o.decideRequest(tx, { ...w.decision(), approve: false }, start))).toEqual({ status: "ok", value: null });
    // The denial consumed the request: no second decision, and no code was stored.
    expect(await status(h.write(tx => o.decideRequest(tx, w.decision(), start)))).toBe("not_found");
    expect(await h.rows("oauth_requests")).toEqual([]);
    expect(await h.rows("oauth_codes")).toEqual([]);
    expect(await status(h.write(tx => o.redeemCode(tx, w.redemption(), start)))).toBe("not_found");
  });

  it("bindRequestSession binds once: the same session rebinds, another is refused, an unknown request or session is not_found", async h => {
    const w = await world(h);
    const o = h.oauth;
    const bind = (session: string, request = w.request.requestHash, browser = w.request.browserHash) =>
      h.write(tx => o.bindRequestSession(tx, request, browser, session, start));
    expect(await status(bind(w.sessionHash))).toBe("not_found");
    await h.write(tx => o.createRequest(tx, w.request, start));
    expect(await status(bind(sha("no-such-session")))).toBe("not_found");
    expect(await status(bind(w.sessionHash, w.request.requestHash, sha("other-browser")))).toBe("invalid");
    expect(await bind(w.sessionHash)).toEqual({ status: "ok", value: { ...w.request, consentSessionHash: w.sessionHash } });
    expect(await bind(w.sessionHash)).toEqual({ status: "ok", value: { ...w.request, consentSessionHash: w.sessionHash } });
    const other = sha("other-session");
    await h.write(tx => o.createBrowserSession(tx, { sessionHash: other, userId: w.userId, createdAt: start, expiresAt: start + 1000 }, start));
    expect(await status(bind(other))).toBe("invalid");
    expect((await h.rows("oauth_requests")).map(r => (r.data as OAuthRequest).consentSessionHash)).toEqual([w.sessionHash]);
  });

  it("createRequest capacity: ten pending per browser and a thousand in all, with expired requests reclaimed", async h => {
    const w = await world(h);
    const create = (r: OAuthRequest, now = start) => status(h.write(tx => h.oauth.createRequest(tx, r, now)));
    for (let i = 0; i < 10; i++) expect(await create({ ...w.request, requestHash: sha(`request-${i}`) })).toBe("ok");
    expect(await create(w.request)).toBe("capacity");
    // Another browser isn't held by this one's ten, up to the total.
    await h.write(async tx => {
      for (let b = 1; b < 100; b++) for (let i = 0; i < 10; i++) {
        expect((await h.oauth.createRequest(tx, { ...w.request, browserHash: sha(`browser-${b}`), requestHash: sha(`request-${b}-${i}`) }, start)).status).toBe("ok");
      }
    });
    expect(await create({ ...w.request, browserHash: sha("browser-100"), requestHash: sha("request-100") })).toBe("capacity");
    expect(await h.rows("oauth_requests")).toHaveLength(1000);
    // At their expiry every one is reclaimed by the next create.
    const now = w.request.expiresAt;
    expect(await create({ ...w.request, createdAt: now, expiresAt: now + 1 }, now)).toBe("ok");
    expect(await h.rows("oauth_requests")).toHaveLength(1);
  }, 30_000);

  it("persistence whitelists fields and rejects un-hashed capability material; every data column holds a JSON object", async h => {
    const w = await world(h);
    const raw = "must-not-persist-secret";
    expect(await status(h.write(tx => h.oauth.createRequest(tx, { ...w.request, requestHash: raw }, start)))).toBe("invalid");
    expect(await status(h.write(tx => h.oauth.createBrowserSession(tx, { sessionHash: raw, userId: w.userId, createdAt: start, expiresAt: start + 1 }, start)))).toBe("invalid");
    await h.write(tx => h.oauth.createRequest(tx, { ...w.request, rawState: raw } as OAuthRequest, start));
    expect(JSON.stringify(await h.rows("oauth_requests"))).not.toContain(raw);
    await h.write(tx => h.oauth.bindRequestSession(tx, w.request.requestHash, w.request.browserHash, w.sessionHash, start));
    await h.write(tx => h.oauth.decideRequest(tx, { ...w.decision(), code: { ...w.code, rawCode: raw } as OAuthCode }, start));
    expect(JSON.stringify(await h.rows("oauth_codes"))).not.toContain(raw);
    expect(await status(h.write(tx => h.oauth.redeemCode(tx, w.redemption(), start)))).toBe("ok");
    for (const table of ["oauth_requests", "oauth_browsers", "oauth_codes", "oauth_grants", "oauth_tokens"] as const) {
      expect(JSON.stringify(await h.rows(table))).not.toContain(raw);
    }
    await h.write(tx => h.oauth.createRequest(tx, { ...w.request, requestHash: sha("pending") }, start));
    const [browser] = await h.rows("oauth_browsers");
    expect(browser).toMatchObject({ data_type: "object", data: { sessionHash: w.sessionHash, userId: w.userId, createdAt: start, expiresAt: start + OAUTH_TTL.browser } });
    expect(Object.keys(browser!.data as object).sort()).toEqual(["createdAt", "expiresAt", "sessionHash", "userId"]);
    const [request] = await h.rows("oauth_requests");
    expect(request).toMatchObject({ data_type: "object" });
    expect(Object.keys(request!.data as object).sort()).toEqual(["browserHash", "clientId", "codeChallenge", "consentSessionHash", "createdAt", "csrfHash",
      "expiresAt", "redirectUri", "requestHash", "resource", "scopes", "stateHash"]);
    const [code] = await h.rows("oauth_codes");
    expect(code).toMatchObject({ data_type: "object" });
    expect(Object.keys(code!.data as object).sort()).toEqual(["clientId", "codeChallenge", "codeHash", "createdAt", "expiresAt", "redirectUri", "resource", "scopes", "userId"]);
    expect((await h.rows("oauth_grants")).map(g => g.data_type)).toEqual(["object"]);
  });

  it("state, session and code expiry boundaries and canonical scopes are enforced", async h => {
    const w = await world(h);
    for (const r of [{ ...w.request, scopes: ["z", "a"] }, { ...w.request, scopes: ["a", "a"] }, { ...w.request, scopes: [] }, { ...w.request, expiresAt: w.request.expiresAt + 1 },
      { ...w.request, createdAt: start - 1 }, { ...w.request, codeChallenge: "short" }, { ...w.request, consentSessionHash: w.sessionHash }]) {
      expect(await status(h.write(tx => h.oauth.createRequest(tx, r, start)))).toBe("invalid");
    }
    await h.write(tx => h.oauth.createRequest(tx, w.request, start));
    await h.write(tx => h.oauth.bindRequestSession(tx, w.request.requestHash, w.request.browserHash, w.sessionHash, start));
    expect(await h.oauth.findRequest(h.read, w.request.requestHash, w.request.browserHash, w.request.expiresAt)).toBeUndefined();
    expect(await h.oauth.findBrowserSession(h.read, w.sessionHash, start + OAUTH_TTL.browser)).toBeUndefined();
    expect(await h.oauth.findBrowserSession(h.read, w.sessionHash, start)).toEqual({ sessionHash: w.sessionHash, userId: w.userId, createdAt: start, expiresAt: start + OAUTH_TTL.browser });
    expect(await status(h.write(tx => h.oauth.decideRequest(tx, w.decision(), start)))).toBe("ok");
    expect(await status(h.write(tx => h.oauth.redeemCode(tx, w.redemption(), w.code.expiresAt)))).toBe("not_found");
  });

  it("a write body that throws after a store call commits none of it", async h => {
    const w = await world(h);
    await w.issueCode();
    const input = w.redemption();
    await expect(h.write(async tx => {
      expect((await h.oauth.redeemCode(tx, input, start)).status).toBe("ok");
      throw new Error("body failed");
    })).rejects.toThrow("body failed");
    expect(await h.rows("oauth_grants")).toEqual([]);
    expect(await h.rows("oauth_tokens")).toEqual([]);
    expect(await h.audits("oauth.grant_issued")).toEqual([]);
    expect(await status(h.write(tx => h.oauth.redeemCode(tx, input, start)))).toBe("ok");
  });
}

function codes(it: It): void {
  it("redeemCode: invalid bindings and replacements don't consume; a second redemption is a replay that revokes the family", async h => {
    const w = await world(h);
    await w.issueCode();
    const input = w.redemption();
    for (const change of [{ clientId: "foreign" }, { resource: "wrong" }, { scopes: ["grayboard:delivery"] }, { redirectUri: "https://evil.example/cb" }, { codeChallenge: "B".repeat(43) },
      { codeHash: sha("wrong") }, { grantId: "short" }, { grantExpiresAt: start + OAUTH_TTL.grant + 1 }, { tokens: { ...input.tokens, scopes: ["grayboard:delivery"] } },
      { tokens: { ...input.tokens, accessHash: "raw-secret" } }, { tokens: { ...input.tokens, refreshHash: input.tokens.accessHash } },
      { tokens: { ...input.tokens, refreshExpiresAt: start + OAUTH_TTL.refresh + 1 } }]) {
      expect(await status(h.write(tx => h.oauth.redeemCode(tx, { ...input, ...change }, start)))).not.toBe("ok");
    }
    expect(await h.rows("oauth_grants")).toEqual([]);
    const issued = await h.write(tx => h.oauth.redeemCode(tx, input, start));
    expect(issued).toEqual({ status: "ok", value: { grant: { id: input.grantId, userId: w.userId, clientId: binding.clientId, resource: binding.resource, scopes: binding.scopes,
      createdAt: start, expiresAt: input.grantExpiresAt, revokedAt: null }, tokens: input.tokens } });
    expect(await h.audits("oauth.grant_issued")).toEqual([{ actor: EMAIL, target: input.grantId, detail: { client_id: binding.clientId }, detail_type: "object" }]);
    expect((await h.rows("oauth_codes"))[0]).toMatchObject({ grant_id: input.grantId, session_id: null });
    expect(await h.oauth.findActiveAccess(h.read, input.tokens.accessHash, binding.resource, binding.scopes, start)).toEqual({ clientId: binding.clientId, resource: binding.resource, scopes: binding.scopes,
      tokenHash: input.tokens.accessHash, grantId: input.grantId, userId: w.userId, createdAt: start, expiresAt: input.tokens.accessExpiresAt, grantExpiresAt: input.grantExpiresAt, source: null });
    const replay = { ...input, grantId: "grant_2222222222222222", tokens: pair() };
    expect(await h.write(tx => h.oauth.redeemCode(tx, replay, start))).toEqual({ status: "replay" });
    // The replay's own grant was never kept; the winner's is revoked, with its tokens.
    expect((await h.rows("oauth_grants")).map(g => g.id)).toEqual([input.grantId]);
    expect(await h.oauth.findActiveAccess(h.read, input.tokens.accessHash, binding.resource, binding.scopes, start)).toBeUndefined();
    expect(await h.oauth.isGrantActive(h.read, input.grantId, start)).toBe(false);
    expect(await h.audits("oauth.code_replay_revoked")).toEqual([{ actor: EMAIL, target: input.grantId, detail: { client_id: binding.clientId, level: "warning" }, detail_type: "object" }]);
  });

  it("code replay validates every binding before committing family revocation", async h => {
    const w = await world(h);
    const input = await w.issue();
    for (const changed of [{ clientId: "foreign" }, { resource: "wrong" }, { scopes: ["grayboard:delivery"] },
      { redirectUri: "https://evil.example/cb" }, { codeChallenge: "B".repeat(43) }, { codeHash: sha("unknown") }]) {
      expect(await status(h.write(tx => h.oauth.redeemCode(tx, { ...input, ...changed }, start + 1)))).not.toBe("ok");
      expect(await h.oauth.isGrantActive(h.read, input.grantId, start + 1)).toBe(true);
    }
    expect(await status(h.write(tx => h.oauth.redeemCode(tx, input, start + 1)))).toBe("replay");
    expect(await h.oauth.findActiveAccess(h.read, input.tokens.accessHash, binding.resource, [], start + 1)).toBeUndefined();
    expect(await status(h.write(tx => h.oauth.rotateRefresh(tx, { ...binding, refreshHash: input.tokens.refreshHash, tokens: pair(binding, start + 1) }, start + 1)))).toBe("invalid");
  });

  it("findCodeScopes is bound to client, resource and redirect, and finds a spent code while its grant lives", async h => {
    const w = await world(h);
    await w.issueCode();
    const get = (now = start) => h.oauth.findCodeScopes(h.read, w.code.codeHash, binding.clientId, binding.resource, binding.redirectUri, now);
    expect(await get()).toEqual(binding.scopes);
    for (const [client, resource, redirect] of [["wrong", binding.resource, binding.redirectUri], [binding.clientId, "wrong", binding.redirectUri], [binding.clientId, binding.resource, "wrong"]]) {
      expect(await h.oauth.findCodeScopes(h.read, w.code.codeHash, client!, resource!, redirect!, start)).toBeUndefined();
    }
    expect(await h.oauth.findCodeScopes(h.read, "raw-code", binding.clientId, binding.resource, binding.redirectUri, start)).toBeUndefined();
    expect(await get(start + OAUTH_TTL.code)).toBeUndefined();
    expect(await status(h.write(tx => h.oauth.redeemCode(tx, w.redemption(), start)))).toBe("ok");
    expect(await get(start + OAUTH_TTL.code)).toEqual(binding.scopes);
    expect(await get(start + OAUTH_TTL.grant)).toBeUndefined();
    await h.disable(w.userId);
    expect(await get()).toBeUndefined();
  });

  it("a spent code's tombstone survives expiry, revoke-all, disable and cleanup until the family deadline", async h => {
    const w = await world(h);
    const input = await w.issue();
    const later = w.code.expiresAt + 1;
    await h.write(tx => h.oauth.cleanup(tx, later));
    expect(await status(h.write(tx => h.oauth.redeemCode(tx, input, later)))).toBe("replay");
    await h.revokeAllForUser(w.userId);
    await h.setDisabled(w.userId, true);
    expect((await h.rows("oauth_codes")).map(c => c.grant_id)).toEqual([input.grantId]);
    expect(await status(h.write(tx => h.oauth.redeemCode(tx, input, input.grantExpiresAt)))).toBe("not_found");
    await h.write(tx => h.oauth.cleanup(tx, input.grantExpiresAt));
    expect(await h.rows("oauth_codes")).toEqual([]);
    expect(await h.rows("oauth_grants")).toEqual([]);
  });

  it("an expired unspent code never mints and cleanup reclaims it", async h => {
    const w = await world(h);
    await w.issueCode();
    expect(await status(h.write(tx => h.oauth.redeemCode(tx, w.redemption(), w.code.expiresAt)))).toBe("not_found");
    await h.write(tx => h.oauth.cleanup(tx, w.code.expiresAt - 1));
    expect(await h.rows("oauth_codes")).toHaveLength(1);
    await h.write(tx => h.oauth.cleanup(tx, w.code.expiresAt));
    expect(await h.rows("oauth_codes")).toEqual([]);
    expect(await h.rows("oauth_grants")).toEqual([]);
  });
}

function refresh(it: It): void {
  it("rotateRefresh: the grant is stable, binding failures neither burn nor revoke, an ancestor's replay revokes the family", async h => {
    const w = await world(h);
    const input = await w.issue();
    const next = { ...binding, refreshHash: input.tokens.refreshHash, tokens: pair(binding, start + 1) };
    expect((await h.oauth.findRefreshGrant(h.read, input.tokens.refreshHash, binding.clientId, binding.resource, start))?.id).toBe(input.grantId);
    expect(await h.oauth.findRefreshGrant(h.read, input.tokens.refreshHash, "foreign", binding.resource, start)).toBeUndefined();
    expect(await h.oauth.findRefreshGrant(h.read, input.tokens.refreshHash, binding.clientId, "wrong", start)).toBeUndefined();
    expect(await h.oauth.findRefreshGrant(h.read, input.tokens.accessHash, binding.clientId, binding.resource, start)).toBeUndefined();
    // findRefreshUser (#930): the same bindings, and only while the token is unspent.
    expect(await h.oauth.findRefreshUser(h.read, input.tokens.refreshHash, binding.clientId, binding.resource, start)).toBe(w.userId);
    expect(await h.oauth.findRefreshUser(h.read, input.tokens.refreshHash, "foreign", binding.resource, start)).toBeUndefined();
    expect(await h.oauth.findRefreshUser(h.read, input.tokens.refreshHash, binding.clientId, "wrong", start)).toBeUndefined();
    expect(await h.oauth.findRefreshUser(h.read, input.tokens.accessHash, binding.clientId, binding.resource, start)).toBeUndefined();
    for (const change of [{ clientId: "foreign" }, { resource: "wrong" }, { scopes: ["grayboard:delivery"] }, { tokens: { ...next.tokens, resource: "wrong" } },
      { tokens: { ...next.tokens, refreshHash: next.refreshHash } }, { tokens: { ...next.tokens, accessHash: next.refreshHash } }, { refreshHash: "raw-refresh" }]) {
      expect(await status(h.write(tx => h.oauth.rotateRefresh(tx, { ...next, ...change }, start + 1)))).toBe("invalid");
      expect(await h.oauth.isGrantActive(h.read, input.grantId, start + 1)).toBe(true);
    }
    // An access token presented as the refresh token is no refresh token at all.
    expect(await status(h.write(tx => h.oauth.rotateRefresh(tx, { ...next, refreshHash: input.tokens.accessHash }, start + 1)))).toBe("not_found");
    expect(await h.oauth.isGrantActive(h.read, input.grantId, start + 1)).toBe(true);
    expect(await status(h.write(tx => h.oauth.rotateRefresh(tx, { ...next, refreshHash: sha("unknown") }, start + 1)))).toBe("not_found");
    const rotated = await h.write(tx => h.oauth.rotateRefresh(tx, next, start + 1));
    expect(rotated).toMatchObject({ status: "ok", value: { grant: { id: input.grantId }, tokens: next.tokens } });
    expect((await h.rows("oauth_tokens")).find(t => t.hash === input.tokens.refreshHash)).toMatchObject({ spent_at: start + 1, revoked_at: null });
    // A spent token still finds its grant (a replay resolves its scopes), but no user to re-check.
    expect(await h.oauth.findRefreshGrant(h.read, input.tokens.refreshHash, binding.clientId, binding.resource, start + 1)).toBeDefined();
    expect(await h.oauth.findRefreshUser(h.read, input.tokens.refreshHash, binding.clientId, binding.resource, start + 1)).toBeUndefined();
    expect(await h.oauth.findRefreshUser(h.read, next.tokens.refreshHash, binding.clientId, binding.resource, start + 1)).toBe(w.userId);
    const newest = { ...binding, refreshHash: next.tokens.refreshHash, tokens: pair(binding, start + 2) };
    expect(await status(h.write(tx => h.oauth.rotateRefresh(tx, newest, start + 2)))).toBe("ok");
    expect(await status(h.write(tx => h.oauth.rotateRefresh(tx, { ...next, clientId: "foreign" }, start + 3)))).toBe("invalid");
    expect(await status(h.write(tx => h.oauth.rotateRefresh(tx, { ...next, tokens: pair(binding, start + 3) }, start + 3)))).toBe("replay");
    expect(await h.oauth.isGrantActive(h.read, input.grantId, start + 3)).toBe(false);
    for (const p of [input.tokens, next.tokens, newest.tokens]) expect(await h.oauth.findActiveAccess(h.read, p.accessHash, binding.resource, [], start + 3)).toBeUndefined();
    expect(await status(h.write(tx => h.oauth.rotateRefresh(tx, { ...binding, refreshHash: newest.tokens.refreshHash, tokens: pair(binding, start + 4) }, start + 4)))).toBe("invalid");
    expect((await h.audits("oauth.refreshed")).map(a => a.target)).toEqual([input.grantId, input.grantId]);
    expect(await h.audits("oauth.refresh_replay_revoked")).toEqual([{ actor: EMAIL, target: input.grantId, detail: { client_id: binding.clientId, level: "warning" }, detail_type: "object" }]);
  });

  it("rotateRefresh: the second rotation of one token is a replay that revokes the winner's grant", async h => {
    const w = await world(h);
    const input = await w.issue();
    const a = pair(binding, start + 1), b = pair(binding, start + 1);
    expect(await status(h.write(tx => h.oauth.rotateRefresh(tx, { ...binding, refreshHash: input.tokens.refreshHash, tokens: a }, start + 1)))).toBe("ok");
    expect(await status(h.write(tx => h.oauth.rotateRefresh(tx, { ...binding, refreshHash: input.tokens.refreshHash, tokens: b }, start + 1)))).toBe("replay");
    expect(await h.oauth.isGrantActive(h.read, input.grantId, start + 1)).toBe(false);
    expect((await h.rows("oauth_tokens")).map(t => t.hash)).not.toContain(b.accessHash);
  });

  it("rotateRefresh clamps a successor to the grant's absolute deadline", async h => {
    const w = await world(h);
    await w.issueCode();
    const input = w.redemption();
    input.grantExpiresAt = start + 100;
    input.tokens = pair(binding, start, input.grantExpiresAt);
    expect(await status(h.write(tx => h.oauth.redeemCode(tx, input, start)))).toBe("ok");
    const result = await h.write(tx => h.oauth.rotateRefresh(tx, { ...binding, refreshHash: input.tokens.refreshHash, tokens: pair(binding, start + 1) }, start + 1));
    if (result.status !== "ok") throw new Error(`rotation answered ${result.status}`);
    expect(result.value.tokens.accessExpiresAt).toBe(input.grantExpiresAt);
    expect(result.value.tokens.refreshExpiresAt).toBe(input.grantExpiresAt);
    expect((await h.rows("oauth_tokens")).filter(t => t.created_at === start + 1).map(t => t.expires_at)).toEqual([input.grantExpiresAt, input.grantExpiresAt]);
    expect(await h.oauth.isGrantActive(h.read, input.grantId, input.grantExpiresAt)).toBe(false);
  });

  it("refresh access scopes may narrow independently of the stable original refresh permission", async h => {
    const auth = { ...binding, scopes: full };
    const w = await world(h, "", auth);
    await w.issueCode();
    const input = w.redemption(pair(auth));
    expect(await status(h.write(tx => h.oauth.redeemCode(tx, input, start)))).toBe("ok");
    const narrow = { ...binding, scopes: ["grayboard:tools"], refreshHash: input.tokens.refreshHash, tokens: { ...pair(binding, start + 1), scopes: ["grayboard:tools"] } };
    for (const changed of [
      { ...narrow, scopes: ["grayboard:admin"], tokens: { ...narrow.tokens, scopes: ["grayboard:admin"] } },
      { ...narrow, scopes: [] },
      { ...narrow, scopes: ["grayboard:tools", "grayboard:tools"] },
      { ...narrow, scopes: ["grayboard:tools", "grayboard:delivery"] },
      { ...narrow, tokens: { ...narrow.tokens, scopes: full } },
      { ...narrow, tokens: { ...narrow.tokens, accessHash: "unhashed" } },
      { ...narrow, tokens: { ...narrow.tokens, refreshExpiresAt: start + OAUTH_TTL.refresh + 2 } },
    ]) expect(await status(h.write(tx => h.oauth.rotateRefresh(tx, changed, start + 1)))).toBe("invalid");
    expect((await h.rows("oauth_tokens")).find(t => t.hash === input.tokens.refreshHash)).toMatchObject({ spent_at: null });
    const result = await h.write(tx => h.oauth.rotateRefresh(tx, narrow, start + 1));
    if (result.status !== "ok") throw new Error(`narrow rotation answered ${result.status}`);
    expect(result.value.grant.scopes).toEqual(full);
    expect(result.value.tokens.scopes).toEqual(["grayboard:tools"]);
    expect(await h.oauth.findActiveAccess(h.read, narrow.tokens.accessHash, binding.resource, ["grayboard:delivery"], start + 1)).toBeUndefined();
    // The same inside a transaction, where a backend may read past any cache it keeps in front of the store.
    expect(await h.write(tx => h.oauth.findActiveAccess(tx, narrow.tokens.accessHash, binding.resource, ["grayboard:delivery"], start + 1))).toBeUndefined();
    expect((await h.write(tx => h.oauth.findActiveAccess(tx, narrow.tokens.accessHash, binding.resource, ["grayboard:tools"], start + 1)))?.scopes).toEqual(["grayboard:tools"]);
    expect((await h.oauth.findActiveAccess(h.read, narrow.tokens.accessHash, binding.resource, ["grayboard:tools"], start + 1))?.scopes).toEqual(["grayboard:tools"]);
    expect((await h.oauth.findRefreshGrant(h.read, narrow.tokens.refreshHash, binding.clientId, binding.resource, start + 2))!.scopes).toEqual(full);
    const other = { ...pair(binding, start + 2), scopes: ["grayboard:delivery"] };
    expect(await status(h.write(tx => h.oauth.rotateRefresh(tx, { ...binding, scopes: other.scopes, refreshHash: narrow.tokens.refreshHash, tokens: other }, start + 2)))).toBe("ok");
    expect(await h.oauth.findActiveAccess(h.read, other.accessHash, binding.resource, ["grayboard:tools"], start + 2)).toBeUndefined();
    // A service resolves an omitted scope from the full original refresh authorization.
    const defaults = (await h.oauth.findRefreshGrant(h.read, other.refreshHash, binding.clientId, binding.resource, start + 3))!;
    const restored = { ...pair(binding, start + 3), scopes: defaults.scopes };
    expect(await status(h.write(tx => h.oauth.rotateRefresh(tx, { ...defaults, refreshHash: other.refreshHash, tokens: restored }, start + 3)))).toBe("ok");
    expect((await h.oauth.findActiveAccess(h.read, restored.accessHash, binding.resource, full, start + 3))?.scopes).toEqual(full);
  });

  it("cleanup removes expired access, keeps refresh tombstones to the family deadline, then the family", async h => {
    const w = await world(h);
    const input = await w.issue();
    const later = start + OAUTH_TTL.refresh - 1;
    const next = pair(binding, later);
    expect(await status(h.write(tx => h.oauth.rotateRefresh(tx, { ...binding, refreshHash: input.tokens.refreshHash, tokens: next }, later)))).toBe("ok");
    await h.write(tx => h.oauth.cleanup(tx, start + OAUTH_TTL.refresh + 1));
    const hashes = (await h.rows("oauth_tokens")).map(t => t.hash);
    expect(hashes).toContain(input.tokens.refreshHash);
    expect(hashes).not.toContain(input.tokens.accessHash);
    expect(await status(h.write(tx => h.oauth.rotateRefresh(tx, { ...binding, refreshHash: input.tokens.refreshHash, tokens: pair(binding, start + OAUTH_TTL.refresh + 1) },
      start + OAUTH_TTL.refresh + 1)))).toBe("replay");
    await h.write(tx => h.oauth.cleanup(tx, input.grantExpiresAt));
    expect(await h.rows("oauth_tokens")).toEqual([]);
    expect(await h.rows("oauth_grants")).toEqual([]);
  });
}

function access(it: It): void {
  it("revokeToken: access is individual, refresh is family-wide, foreign and unknown tokens are inert", async h => {
    const w = await world(h);
    const input = await w.issue();
    const o = h.oauth;
    await h.write(tx => o.revokeToken(tx, input.tokens.refreshHash, "foreign", start + 1));
    await h.write(tx => o.revokeToken(tx, sha("unknown"), binding.clientId, start + 1));
    await h.write(tx => o.revokeToken(tx, "raw-token", binding.clientId, start + 1));
    expect(await h.audits("oauth.revoked")).toEqual([]);
    await h.write(tx => o.revokeToken(tx, input.tokens.accessHash, binding.clientId, start + 1));
    expect(await o.isGrantActive(h.read, input.grantId, start + 1)).toBe(true);
    expect(await o.findActiveAccess(h.read, input.tokens.accessHash, binding.resource, [], start + 1)).toBeUndefined();
    const next = pair(binding, start + 1);
    expect(await status(h.write(tx => o.rotateRefresh(tx, { ...binding, refreshHash: input.tokens.refreshHash, tokens: next }, start + 1)))).toBe("ok");
    await h.write(tx => o.revokeToken(tx, input.tokens.refreshHash, binding.clientId, start + 2));
    expect(await o.isGrantActive(h.read, input.grantId, start + 2)).toBe(false);
    // Revoking a revoked family again resolves and is audited again (RFC 7009: revocation is idempotent).
    await h.write(tx => o.revokeToken(tx, input.tokens.refreshHash, binding.clientId, start + 2));
    expect(await o.findActiveAccess(h.read, next.accessHash, binding.resource, [], start + 2)).toBeUndefined();
    expect(await status(h.write(tx => o.rotateRefresh(tx, { ...binding, refreshHash: next.refreshHash, tokens: pair(binding, start + 2) }, start + 2)))).toBe("invalid");
    expect((await h.audits("oauth.revoked")).map(a => a.detail)).toEqual([{ client_id: binding.clientId, kind: "access" }, { client_id: binding.clientId, kind: "refresh" },
      { client_id: binding.clientId, kind: "refresh" }]);
  });

  // The entry guards (oauth-rules.ts lookup, accessLookup): a bad time or an unhashed capability is refused before any
  // read, so it can neither find a live row nor reach a replay's or a revoke's write.
  it("an invalid time or an unhashed capability finds nothing and writes nothing", async h => {
    const w = await world(h);
    const input = await w.issue();
    const o = h.oauth;
    const bad = -1;
    expect(await o.findBrowserSession(h.read, w.sessionHash, bad)).toBeUndefined();
    expect(await o.findCodeScopes(h.read, w.code.codeHash, binding.clientId, binding.resource, binding.redirectUri, bad)).toBeUndefined();
    expect(await o.findRefreshGrant(h.read, input.tokens.refreshHash, binding.clientId, binding.resource, bad)).toBeUndefined();
    // In a transaction: a backend's cache in front of the store may answer a hit without the guard.
    expect(await h.write(tx => o.findActiveAccess(tx, input.tokens.accessHash, binding.resource, [], bad))).toBeUndefined();
    expect(await status(h.write(tx => o.rotateRefresh(tx, { ...binding, refreshHash: input.tokens.refreshHash, tokens: pair(binding, start + 1) }, bad)))).toBe("invalid");
    expect(await status(h.write(tx => o.redeemCode(tx, input, bad)))).toBe("invalid");
    expect(await status(h.write(tx => o.redeemCode(tx, { ...input, codeHash: "raw-code" }, start)))).toBe("invalid");
    expect(await status(h.write(tx => o.redeemLoginCode(tx, { ...login, codeHash: "raw-code", tokenHash: sha("cli"), label: null }, start)))).toBe("invalid");
    await h.write(tx => o.revokeToken(tx, input.tokens.refreshHash, binding.clientId, bad));
    expect(await o.isGrantActive(h.read, input.grantId, start)).toBe(true);
    expect(await h.audits("oauth.revoked")).toEqual([]);
    expect(await h.audits("oauth.code_replay_revoked")).toEqual([]);
  });

  it("revokeToken then rotateRefresh never resurrects a grant", async h => {
    const w = await world(h);
    const input = await w.issue();
    await h.write(tx => h.oauth.revokeToken(tx, input.tokens.refreshHash, binding.clientId, start + 1));
    expect(await status(h.write(tx => h.oauth.rotateRefresh(tx, { ...binding, refreshHash: input.tokens.refreshHash, tokens: pair(binding, start + 1) }, start + 1)))).toBe("invalid");
    expect(await h.oauth.isGrantActive(h.read, input.grantId, start + 1)).toBe(false);
  });

  it("findActiveAccess checks resource, scopes, user and expiry; disable then re-enable revives no grant or browser session", async h => {
    const w = await world(h);
    const input = await w.issue();
    const o = h.oauth;
    expect(await o.findActiveAccess(h.read, input.tokens.accessHash, "wrong", [], start)).toBeUndefined();
    expect(await o.findActiveAccess(h.read, input.tokens.accessHash, binding.resource, ["grayboard:delivery"], start)).toBeUndefined();
    expect(await o.findActiveAccess(h.read, input.tokens.accessHash, binding.resource, [], input.tokens.accessExpiresAt)).toBeUndefined();
    expect(await o.findActiveAccess(h.read, input.tokens.refreshHash, binding.resource, [], start)).toBeUndefined();
    // Required scopes that aren't an array find nothing, and don't throw.
    expect(await o.findActiveAccess(h.read, input.tokens.accessHash, binding.resource, "grayboard:tools" as unknown as string[], start)).toBeUndefined();
    expect(await h.write(tx => o.findActiveAccess(tx, input.tokens.accessHash, binding.resource, "grayboard:tools" as unknown as string[], start))).toBeUndefined();
    expect((await o.findActiveAccess(h.read, input.tokens.accessHash, binding.resource, binding.scopes, start))?.grantId).toBe(input.grantId);
    expect(await o.isGrantActive(h.read, input.grantId, input.grantExpiresAt)).toBe(false);
    // A disabled user's token, grant, refresh and browser session read as dead even before anything is revoked.
    await h.disable(w.userId);
    expect(await o.findActiveAccess(h.read, input.tokens.accessHash, binding.resource, [], start)).toBeUndefined();
    expect(await o.isGrantActive(h.read, input.grantId, start)).toBe(false);
    expect(await o.findRefreshGrant(h.read, input.tokens.refreshHash, binding.clientId, binding.resource, start)).toBeUndefined();
    expect(await status(h.write(tx => o.rotateRefresh(tx, { ...binding, refreshHash: input.tokens.refreshHash, tokens: pair(binding, start + 1) }, start + 1)))).toBe("invalid");
    expect(await o.findBrowserSession(h.read, w.sessionHash, start)).toBeUndefined();
    await h.setDisabled(w.userId, false);
    expect((await o.findActiveAccess(h.read, input.tokens.accessHash, binding.resource, [], start))?.grantId).toBe(input.grantId);
    // The real disable revokes, so re-enabling revives nothing.
    await h.setDisabled(w.userId, true);
    expect(await o.findActiveAccess(h.read, input.tokens.accessHash, binding.resource, [], start)).toBeUndefined();
    expect(await o.findBrowserSession(h.read, w.sessionHash, start)).toBeUndefined();
    expect(await o.isGrantActive(h.read, input.grantId, start)).toBe(false);
    await h.setDisabled(w.userId, false);
    expect(await o.isGrantActive(h.read, input.grantId, start)).toBe(false);
    expect(await o.findActiveAccess(h.read, input.tokens.accessHash, binding.resource, [], start)).toBeUndefined();
    expect(await o.findBrowserSession(h.read, w.sessionHash, start)).toBeUndefined();
  });

  it("revoke-all revokes OAuth grants and ends browser sessions; a single session revoke and browser logout don't revoke grants", async h => {
    const w = await world(h);
    const input = await w.issue();
    // A second browser session, so the revoke-all below has one to end (#1552); the logout ends only its own.
    const live = sha("live-browser");
    expect(await status(h.write(tx => h.oauth.createBrowserSession(tx, { sessionHash: live, userId: w.userId, createdAt: start, expiresAt: start + 1000 }, start)))).toBe("ok");
    const s = await h.write(tx => h.sessions.create(tx, w.userId, sha("old-token"), null));
    await h.write(tx => h.sessions.revoke(tx, s.id));
    await h.write(tx => h.oauth.revokeBrowserSession(tx, w.sessionHash));
    expect(await h.oauth.findBrowserSession(h.read, w.sessionHash, start)).toBeUndefined();
    expect(await h.oauth.isGrantActive(h.read, input.grantId, start)).toBe(true);
    expect(await h.oauth.findBrowserSession(h.read, live, start)).toBeDefined();
    await h.revokeAllForUser(w.userId);
    expect(await h.oauth.isGrantActive(h.read, input.grantId, start)).toBe(false);
    expect(await h.oauth.findBrowserSession(h.read, live, start)).toBeUndefined();
  });

  // The serial half of the disable race (postgres-server.md D3; C4b's T-C4-8 is the concurrent half): each write that
  // mints for a user reads the user as enabled (activeUser with its lock), so once the user is disabled it refuses and
  // leaves no row, even where the rows it read first (a browser session, a code) are still there.
  it("every mint for a user refuses a disabled user and writes nothing", async h => {
    const w = await world(h);
    const l = await world(h, "-login", login);
    await w.issueCode();
    await l.issueCode();
    await h.write(tx => h.oauth.createRequest(tx, { ...w.request, requestHash: sha("pending") }, start));
    await h.write(tx => h.oauth.bindRequestSession(tx, sha("pending"), w.request.browserHash, w.sessionHash, start));
    await h.write(tx => h.oauth.createRequest(tx, { ...w.request, requestHash: sha("unbound") }, start));
    const svc = await h.write(tx => h.services.create(tx, "ingest"));
    const added = await h.write(tx => h.oauth.addServiceCredential(tx, credential(svc.id), start));
    if (added.status !== "ok") throw new Error(`addServiceCredential answered ${added.status}`);
    const codeScopes = () => h.oauth.findCodeScopes(h.read, w.code.codeHash, binding.clientId, binding.resource, binding.redirectUri, start);
    expect(await codeScopes()).toEqual(binding.scopes);
    await h.disable(w.userId);
    await h.disable(svc.id);
    const tables = ["oauth_grants", "oauth_codes", "sessions", "oauth_browsers", "oauth_tokens", "service_credentials", "service_credential_secrets"] as const;
    const snapshot = async () => Promise.all(tables.map(t => h.rows(t)));
    const before = await snapshot();
    // The reads a mint starts from see the disable too: an unspent code's scopes, and a bind's browser session.
    expect(await codeScopes()).toBeUndefined();
    expect(await status(h.write(tx => h.oauth.bindRequestSession(tx, sha("unbound"), w.request.browserHash, w.sessionHash, start)))).toBe("not_found");
    expect(await status(h.write(tx => h.oauth.createBrowserSession(tx, { sessionHash: sha("fresh"), userId: w.userId, createdAt: start, expiresAt: start + 1000 }, start)))).toBe("invalid");
    expect(await status(h.write(tx => h.oauth.decideRequest(tx, { ...w.decision(), requestHash: sha("pending"), code: { ...w.code, codeHash: sha("fresh-code") } }, start)))).toBe("not_found");
    expect(await status(h.write(tx => h.oauth.redeemCode(tx, w.redemption(), start)))).toBe("invalid");
    expect(await status(h.write(tx => h.oauth.redeemLoginCode(tx, { ...login, codeHash: l.code.codeHash, tokenHash: sha("cli"), label: null }, start)))).toBe("invalid");
    expect(await status(h.write(tx => h.oauth.addServiceCredential(tx, credential(svc.id, { clientId: `svc_${"b".repeat(32)}`, grantId: "svcgrant_second_0123",
      secretHash: sha("secret-other") }), start)))).toBe("invalid");
    // A credential added before the disable: no run token, no new secret, and it reads as gone.
    expect(await status(h.write(tx => h.oauth.mintServiceToken(tx, { clientId: SVC_CLIENT, secretId: added.value.secretId, tokenHash: sha("run-token"),
      scopes: [...OAUTH_SCOPES], limits: LIMITS }, start)))).toBe("invalid");
    expect(await status(h.write(tx => h.oauth.rotateServiceCredential(tx, { clientId: SVC_CLIENT, secretHash: sha("secret-2") }, start)))).toBe("not_found");
    expect(await h.oauth.findServiceCredential(h.read, SVC_CLIENT, start)).toBeUndefined();
    expect(await snapshot()).toEqual(before);
    expect(await h.rows("oauth_tokens")).toEqual([]);
    expect(await h.rows("service_credential_secrets")).toHaveLength(1);
  });
}

function browsersAndCaps(it: It): void {
  it("createBrowserSession replaces replaceHash and caps live sessions at 10,000, reclaiming expired ones; revokeBrowserSession ends one", async h => {
    const w = await world(h);
    const create = (hash: string, now = start, replace?: string) =>
      h.write(tx => h.oauth.createBrowserSession(tx, { sessionHash: hash, userId: w.userId, createdAt: now, expiresAt: now + 1000 }, now, replace));
    expect(await status(create(sha("second"), start, w.sessionHash))).toBe("ok");
    expect(await h.oauth.findBrowserSession(h.read, w.sessionHash, start)).toBeUndefined();
    expect((await h.oauth.findBrowserSession(h.read, sha("second"), start))?.userId).toBe(w.userId);
    expect(await status(h.write(tx => h.oauth.createBrowserSession(tx, { sessionHash: sha("third"), userId: w.userId, createdAt: start, expiresAt: start + 1000 }, start + 1)))).toBe("invalid");
    expect(await status(create(sha("third")))).toBe("ok");
    await h.write(tx => h.oauth.revokeBrowserSession(tx, sha("third")));
    expect(await h.oauth.findBrowserSession(h.read, sha("third"), start)).toBeUndefined();
    // 9,999 live with "second": the next one fills the cap, and the one after is refused, a replacement included.
    await h.fillBrowsers(w.userId, 9_998, start + 500);
    expect(await status(create(sha("fill-last")))).toBe("ok");
    expect(await status(create(sha("over")))).toBe("capacity");
    expect(await status(create(sha("over"), start, sha("second")))).toBe("capacity");
    expect((await h.oauth.findBrowserSession(h.read, sha("second"), start))?.userId).toBe(w.userId);
    // Once the fill expires, the next create reclaims it.
    expect(await status(create(sha("over"), start + 500))).toBe("ok");
    expect(await h.rows("oauth_browsers")).toHaveLength(3);
  }, 30_000);
}

function loginCodes(it: It): void {
  it("redeemLoginCode issues a CLI session once; a replay revokes it; neither redeemer takes the other's code", async h => {
    const l = await world(h, "-login", login);
    const g = await world(h, "-grant");
    await l.issueCode();
    await g.issueCode();
    const redeem = (over: Partial<{ codeHash: string; tokenHash: string; label: string | null; codeChallenge: string; redirectUri: string; clientId: string; scopes: string[] }> = {}) =>
      h.write(tx => h.oauth.redeemLoginCode(tx, { ...login, codeHash: l.code.codeHash, tokenHash: sha("cli-token"), label: "ua", ...over }, start));
    // A login code never becomes a grant, and a grant code never a session.
    expect(await status(h.write(tx => h.oauth.redeemCode(tx, { ...l.redemption(pair(login)) }, start)))).toBe("invalid");
    expect(await status(redeem({ codeHash: g.code.codeHash }))).toBe("invalid");
    // Even presented with the grant code's own binding: only a code whose scopes are exactly the login scope signs in.
    expect(await status(redeem({ codeHash: g.code.codeHash, scopes: binding.scopes }))).toBe("invalid");
    for (const bad of [{ label: 5 as unknown as string }, { tokenHash: "raw-token" }, { codeChallenge: "B".repeat(43) }, { redirectUri: "https://evil.example/cb" }, { clientId: "foreign" }]) {
      expect(await status(redeem(bad))).toBe("invalid");
    }
    expect(await status(redeem({ codeHash: sha("unknown") }))).toBe("not_found");
    expect(await h.rows("sessions")).toEqual([]);
    const issued = await redeem();
    if (issued.status !== "ok") throw new Error(`login redemption answered ${issued.status}`);
    expect(issued.value.userId).toBe(l.userId);
    const id = issued.value.sessionId;
    expect(await h.sessions.findById(h.read, id)).toMatchObject({ user_id: l.userId, token_hash: sha("cli-token"), label: "ua", revoked_at: null });
    expect((await h.rows("oauth_codes")).find(c => c.hash === l.code.codeHash)).toMatchObject({ session_id: id, grant_id: null });
    expect(await h.audits("oauth.session_issued")).toEqual([{ actor: EMAIL, target: null, detail: { client_id: login.clientId, token_session: id }, detail_type: "object" }]);
    expect(await h.oauth.findCodeScopes(h.read, l.code.codeHash, login.clientId, login.resource, login.redirectUri, start + OAUTH_TTL.code)).toEqual(login.scopes);
    // A spent login code: redeemCode still refuses it; the replay revokes the session and mints none.
    expect(await status(h.write(tx => h.oauth.redeemCode(tx, l.redemption(pair(login)), start)))).toBe("invalid");
    expect(await redeem({ tokenHash: sha("replayed") })).toEqual({ status: "replay" });
    expect(await h.sessions.findByTokenHash(h.read, sha("replayed"))).toBeUndefined();
    expect((await h.sessions.findById(h.read, id))?.revoked_at).toBe(start);
    expect(await h.audits("oauth.code_replay_revoked")).toEqual([{ actor: EMAIL, target: null, detail: { client_id: login.clientId, token_session: id, level: "warning" }, detail_type: "object" }]);
    expect(await h.oauth.findCodeScopes(h.read, l.code.codeHash, login.clientId, login.resource, login.redirectUri, start)).toBeUndefined();
    // A spent grant code is no login code either.
    expect(await status(h.write(tx => h.oauth.redeemCode(tx, g.redemption(), start)))).toBe("ok");
    expect(await status(redeem({ codeHash: g.code.codeHash }))).toBe("invalid");
  });

  it("cleanup keeps a spent login code while its session lives, and drops it once the session is revoked", async h => {
    const l = await world(h, "-login", login);
    await l.issueCode();
    const issued = await h.write(tx => h.oauth.redeemLoginCode(tx, { ...login, codeHash: l.code.codeHash, tokenHash: sha("cli-token"), label: null }, start));
    if (issued.status !== "ok") throw new Error(`login redemption answered ${issued.status}`);
    await h.write(tx => h.oauth.cleanup(tx, l.code.expiresAt));
    expect((await h.rows("oauth_codes")).map(c => c.hash)).toEqual([l.code.codeHash]);
    await h.write(tx => h.sessions.revoke(tx, issued.value.sessionId));
    await h.write(tx => h.oauth.cleanup(tx, l.code.expiresAt));
    expect(await h.rows("oauth_codes")).toEqual([]);
  });
}

function cutover(it: It): void {
  it("revokePreBuiltinGrants revokes, audits and drops codes under the listed clients once per key; a second run returns 0 and writes no audit row", async h => {
    const pi = { ...binding, clientId: "grayboard-pi" };
    const old = await world(h, "-old", pi);
    const kept = await world(h, "-kept");
    const pending = await world(h, "-pending", pi);
    const pendingKept = await world(h, "-pending-kept");
    const oldInput = await old.issue();
    const keptInput = await kept.issue();
    await pending.issueCode();
    await pendingKept.issueCode();
    const ids = ["grayboard-pi", "grayboard-omp"];
    expect(await h.write(tx => h.oauth.revokePreBuiltinGrants(tx, ids, start + 1))).toBe(1);
    expect(await h.oauth.isGrantActive(h.read, oldInput.grantId, start + 1)).toBe(false);
    expect(await h.oauth.isGrantActive(h.read, keptInput.grantId, start + 1)).toBe(true);
    // Unredeemed codes under the listed clients go; a redeemed one stays as the replay tombstone.
    expect((await h.rows("oauth_codes")).map(c => c.hash).sort()).toEqual([old.code.codeHash, kept.code.codeHash, pendingKept.code.codeHash].sort());
    const audit = { actor: EMAIL, target: oldInput.grantId, detail: { client_id: "grayboard-pi" }, detail_type: "object" };
    expect(await h.audits("oauth.builtin_client_grant_revoked")).toEqual([audit]);
    expect(await h.rows("server_state")).toEqual([{ key: "builtin_clients", value: start + 1 }]);
    // Later grants under these IDs are the built-ins' own: the next run leaves them, and its codes, alone.
    const later = await world(h, "-later", pi);
    const laterInput = await later.issue();
    const laterPending = await world(h, "-later-pending", pi);
    await laterPending.issueCode();
    expect(await h.write(tx => h.oauth.revokePreBuiltinGrants(tx, ids, start + 2))).toBe(0);
    expect(await h.oauth.isGrantActive(h.read, laterInput.grantId, start + 2)).toBe(true);
    expect((await h.rows("oauth_codes")).map(c => c.hash)).toContain(laterPending.code.codeHash);
    expect(await h.audits("oauth.builtin_client_grant_revoked")).toEqual([audit]);
    expect(await h.rows("server_state")).toEqual([{ key: "builtin_clients", value: start + 1 }]);
    // Each key runs once on its own.
    expect(await h.write(tx => h.oauth.revokePreBuiltinGrants(tx, ["grayboard-pi"], start + 3, "builtin_clients_cli"))).toBe(1);
    expect(await h.oauth.isGrantActive(h.read, laterInput.grantId, start + 3)).toBe(false);
    expect(await h.write(tx => h.oauth.revokePreBuiltinGrants(tx, ["grayboard-pi"], start + 4, "builtin_clients_cli"))).toBe(0);
    expect(await h.audits("oauth.builtin_client_grant_revoked")).toHaveLength(2);
    expect((await h.rows("server_state")).sort((a, b) => String(a.key).localeCompare(String(b.key))))
      .toEqual([{ key: "builtin_clients", value: start + 1 }, { key: "builtin_clients_cli", value: start + 3 }]);
  });

  // A database with no grant to revoke (a fresh server) still claims the key on its first run: the built-in clients'
  // grants issued after that boot are theirs, and the next boot must leave them alone.
  it("revokePreBuiltinGrants with no grant to revoke still claims its key; a grant issued afterwards survives the next run", async h => {
    const pi = { ...binding, clientId: "grayboard-pi" };
    const pending = await world(h, "-pending", pi);
    await pending.issueCode();
    expect(await h.write(tx => h.oauth.revokePreBuiltinGrants(tx, ["grayboard-pi"], start + 1))).toBe(0);
    expect(await h.rows("server_state")).toEqual([{ key: "builtin_clients", value: start + 1 }]);
    // The claiming run drops the listed clients' unredeemed codes, as a run that revokes does.
    expect(await h.rows("oauth_codes")).toEqual([]);
    const later = await world(h, "-later", pi);
    const laterInput = await later.issue();
    expect(await h.write(tx => h.oauth.revokePreBuiltinGrants(tx, ["grayboard-pi"], start + 2))).toBe(0);
    expect(await h.oauth.isGrantActive(h.read, laterInput.grantId, start + 2)).toBe(true);
    expect(await h.audits("oauth.builtin_client_grant_revoked")).toEqual([]);
    expect(await h.rows("server_state")).toEqual([{ key: "builtin_clients", value: start + 1 }]);
  });

  it("revokePreBuiltinGrants and cleanup refuse an invalid time and write nothing", async h => {
    await expect(h.write(tx => h.oauth.revokePreBuiltinGrants(tx, ["grayboard-pi"], -1))).rejects.toThrow(RangeError);
    await expect(h.write(tx => h.oauth.cleanup(tx, 1.5))).rejects.toThrow(RangeError);
    expect(await h.rows("server_state")).toEqual([]);
  });
}

const SVC_CLIENT = `svc_${"a".repeat(32)}`;
const credential = (userId: number, over: Partial<{ clientId: string; grantId: string; resource: string; source: "generic" | "opencode"; tokenSeconds: number; expiresAt: number; secretHash: string }> = {}) => ({
  userId, clientId: SVC_CLIENT, grantId: "svcgrant_0123456789", resource: binding.resource, source: "generic" as const, tokenSeconds: 3600,
  expiresAt: start + OAUTH_TTL.grant, secretHash: sha("secret-1"), ...over });
const LIMITS: ServiceTokenLimits = { maxSeconds: 600, mintsPerMinute: 2, unexpired: 3 };

function serviceCredentials(it: It): void {
  async function added(h: OAuthHarness, over: Parameters<typeof credential>[1] = {}) {
    const svc = await h.write(tx => h.services.create(tx, "ingest"));
    const r = await h.write(tx => h.oauth.addServiceCredential(tx, credential(svc.id, over), start));
    if (r.status !== "ok") throw new Error(`addServiceCredential answered ${r.status}`);
    return { svc, secretId: r.value.secretId };
  }
  const mint = (h: OAuthHarness, secretId: number, token: string, now = start, over: Partial<{ clientId: string; scopes: string[]; limits: ServiceTokenLimits }> = {}) =>
    h.write(tx => h.oauth.mintServiceToken(tx, { clientId: SVC_CLIENT, secretId, tokenHash: sha(token), scopes: [...OAUTH_SCOPES], limits: LIMITS, ...over }, now));

  it("addServiceCredential writes a credential, its grant and first secret only for an enabled service with valid input", async h => {
    const person = (await h.write(tx => h.users.upsertByEmail(tx, EMAIL, null))).id;
    const svc = await h.write(tx => h.services.create(tx, "ingest"));
    const add = (userId: number, over: Parameters<typeof credential>[1] = {}, now = start) => status(h.write(tx => h.oauth.addServiceCredential(tx, credential(userId, over), now)));
    for (const over of [{ clientId: "svc_short" }, { clientId: `cli_${"a".repeat(32)}` }, { grantId: "short" }, { source: "pi" as "generic" }, { tokenSeconds: 59 },
      { tokenSeconds: 60.5 }, { expiresAt: start }, { secretHash: "raw-secret" }, { resource: "" }]) {
      expect(await add(svc.id, over)).toBe("invalid");
    }
    expect(await add(svc.id, {}, -1)).toBe("invalid");
    expect(await add(person)).toBe("invalid");
    await h.setDisabled(svc.id, true);
    expect(await add(svc.id)).toBe("invalid");
    expect([await h.rows("service_credentials"), await h.rows("oauth_grants"), await h.rows("service_credential_secrets")]).toEqual([[], [], []]);
    await h.setDisabled(svc.id, false);
    const r = await h.write(tx => h.oauth.addServiceCredential(tx, credential(svc.id, { tokenSeconds: 60, source: "opencode" }), start));
    if (r.status !== "ok") throw new Error(`addServiceCredential answered ${r.status}`);
    const c = credential(svc.id);
    expect(await h.oauth.findServiceCredential(h.read, SVC_CLIENT, start)).toEqual({ clientId: SVC_CLIENT, userId: svc.id, grantId: c.grantId, source: "opencode", tokenSeconds: 60,
      secrets: [{ id: r.value.secretId, hash: c.secretHash }] });
    const [grant] = await h.rows("oauth_grants");
    expect(grant).toMatchObject({ id: c.grantId, user_id: svc.id, expires_at: c.expiresAt, revoked_at: null, data_type: "object",
      data: { id: c.grantId, userId: svc.id, clientId: SVC_CLIENT, resource: binding.resource, scopes: [...OAUTH_SCOPES], createdAt: start, expiresAt: c.expiresAt, revokedAt: null } });
    expect(await h.oauth.isGrantActive(h.read, c.grantId, start)).toBe(true);
    expect(await h.oauth.findServiceCredential(h.read, SVC_CLIENT, c.expiresAt)).toBeUndefined();
    expect(await h.oauth.findServiceCredential(h.read, `svc_${"b".repeat(32)}`, start)).toBeUndefined();
    await h.setDisabled(svc.id, true);
    expect(await h.oauth.findServiceCredential(h.read, SVC_CLIENT, start)).toBeUndefined();
  });

  it("rotateServiceCredential adds a second live secret, refuses a third, a bad input and a dead credential", async h => {
    const { svc, secretId } = await added(h);
    const rotate = (secret: string, clientId = SVC_CLIENT, now = start + 1) => h.write(tx => h.oauth.rotateServiceCredential(tx, { clientId, secretHash: sha(secret) }, now));
    expect(await status(h.write(tx => h.oauth.rotateServiceCredential(tx, { clientId: SVC_CLIENT, secretHash: "raw" }, start + 1)))).toBe("invalid");
    expect(await status(rotate("secret-2", `svc_${"b".repeat(32)}`))).toBe("not_found");
    const second = await rotate("secret-2");
    if (second.status !== "ok") throw new Error(`rotate answered ${second.status}`);
    expect(second.value.userId).toBe(svc.id);
    expect(await status(rotate("secret-3"))).toBe("capacity");
    expect((await h.oauth.findServiceCredential(h.read, SVC_CLIENT, start + 1))!.secrets).toEqual([{ id: secretId, hash: sha("secret-1") }, { id: second.value.secretId, hash: sha("secret-2") }]);
    // A revoked secret frees its slot.
    expect(await status(h.write(tx => h.oauth.revokeServiceSecret(tx, secretId, start + 2)))).toBe("ok");
    expect(await status(rotate("secret-3", SVC_CLIENT, start + 2))).toBe("ok");
    expect(await status(h.write(tx => h.oauth.revokeServiceCredential(tx, SVC_CLIENT, start + 3)))).toBe("ok");
    expect(await status(rotate("secret-4", SVC_CLIENT, start + 3))).toBe("not_found");
  });

  it("revokeServiceSecret revokes one secret and its tokens, never the credential's last live secret", async h => {
    const { svc, secretId } = await added(h);
    expect(await status(h.write(tx => h.oauth.revokeServiceSecret(tx, secretId, start)))).toBe("invalid");
    const second = await h.write(tx => h.oauth.rotateServiceCredential(tx, { clientId: SVC_CLIENT, secretHash: sha("secret-2") }, start));
    if (second.status !== "ok") throw new Error(`rotate answered ${second.status}`);
    expect(await status(mint(h, secretId, "t1"))).toBe("ok");
    expect(await status(mint(h, second.value.secretId, "t2"))).toBe("ok");
    expect(await status(h.write(tx => h.oauth.revokeServiceSecret(tx, secretId, -1)))).toBe("invalid");
    expect(await h.write(tx => h.oauth.revokeServiceSecret(tx, secretId, start + 1))).toEqual({ status: "ok", value: { clientId: SVC_CLIENT, userId: svc.id } });
    expect(await h.oauth.findActiveAccess(h.read, sha("t1"), binding.resource, [], start + 1)).toBeUndefined();
    expect((await h.rows("oauth_tokens")).find(t => t.hash === sha("t1"))).toMatchObject({ revoked_at: start + 1 });
    expect((await h.oauth.findActiveAccess(h.read, sha("t2"), binding.resource, [], start + 1))?.clientId).toBe(SVC_CLIENT);
    expect(await h.oauth.isGrantActive(h.read, credential(svc.id).grantId, start + 1)).toBe(true);
    expect(await status(mint(h, secretId, "t3", start + 61_000))).toBe("invalid");
    expect(await status(h.write(tx => h.oauth.revokeServiceSecret(tx, secretId, start + 2)))).toBe("not_found");
    expect(await status(h.write(tx => h.oauth.revokeServiceSecret(tx, second.value.secretId, start + 2)))).toBe("invalid");
    expect(await status(h.write(tx => h.oauth.revokeServiceSecret(tx, 1.5, start + 2)))).toBe("invalid");
    expect((await h.oauth.findServiceCredential(h.read, SVC_CLIENT, start + 2))!.secrets.map(s => s.id)).toEqual([second.value.secretId]);
  });

  it("revokeServiceCredential revokes the grant: the credential, its tokens and its mints are dead", async h => {
    const { svc, secretId } = await added(h);
    expect(await status(mint(h, secretId, "t1"))).toBe("ok");
    expect(await status(h.write(tx => h.oauth.revokeServiceCredential(tx, 5 as unknown as string, start + 1)))).toBe("invalid");
    expect(await h.write(tx => h.oauth.revokeServiceCredential(tx, SVC_CLIENT, start + 1))).toEqual({ status: "ok", value: { userId: svc.id } });
    expect(await h.oauth.isGrantActive(h.read, credential(svc.id).grantId, start + 1)).toBe(false);
    expect(await h.oauth.findServiceCredential(h.read, SVC_CLIENT, start + 1)).toBeUndefined();
    expect(await h.oauth.findActiveAccess(h.read, sha("t1"), binding.resource, [], start + 1)).toBeUndefined();
    expect(await status(mint(h, secretId, "t2", start + 1))).toBe("invalid");
    expect(await status(h.write(tx => h.oauth.revokeServiceCredential(tx, SVC_CLIENT, start + 2)))).toBe("not_found");
    expect(await status(h.write(tx => h.oauth.revokeServiceCredential(tx, SVC_CLIENT, -1)))).toBe("invalid");
  });

  it("mintServiceToken clamps the expiry, audits the mint, carries the source, and holds the per-minute bucket and the unexpired cap", async h => {
    const { svc, secretId } = await added(h, { source: "opencode" });
    for (const over of [{ scopes: ["grayboard:admin"] }, { scopes: [...OAUTH_SCOPES].reverse() }, { scopes: [] }, { limits: { ...LIMITS, unexpired: 0 } }, { limits: { ...LIMITS, maxSeconds: 1.5 } },
      { clientId: `svc_${"b".repeat(32)}` }]) {
      expect(await status(mint(h, secretId, "bad", start, over))).toBe("invalid");
    }
    expect(await status(mint(h, secretId + 1000, "bad"))).toBe("invalid");
    expect(await status(h.write(tx => h.oauth.mintServiceToken(tx, { clientId: SVC_CLIENT, secretId, tokenHash: "raw", scopes: [...OAUTH_SCOPES], limits: LIMITS }, start)))).toBe("invalid");
    expect(await h.rows("oauth_tokens")).toEqual([]);
    // tokenSeconds 3600, ceiling 600: the ceiling wins.
    expect(await mint(h, secretId, "t1", start, { scopes: ["grayboard:tools"] })).toEqual({ status: "ok", value: { expiresAt: start + 600_000 } });
    expect(await h.audits("oauth.token_issued")).toEqual([{ actor: "ingest", target: credential(svc.id).grantId,
      detail: { client_id: SVC_CLIENT, secret_id: secretId, expires_at: start + 600_000 }, detail_type: "object" }]);
    expect(await h.oauth.findActiveAccess(h.read, sha("t1"), binding.resource, ["grayboard:tools"], start)).toEqual({ clientId: SVC_CLIENT, resource: binding.resource,
      scopes: ["grayboard:tools"], tokenHash: sha("t1"), grantId: credential(svc.id).grantId, userId: svc.id, createdAt: start, expiresAt: start + 600_000,
      grantExpiresAt: credential(svc.id).expiresAt, source: "opencode" });
    expect(await h.oauth.findActiveAccess(h.read, sha("t1"), binding.resource, ["grayboard:delivery"], start)).toBeUndefined();
    // The bucket: two mints in the minute, then capacity.
    expect(await status(mint(h, secretId, "t2"))).toBe("ok");
    expect(await status(mint(h, secretId, "t3"))).toBe("capacity");
    expect(await status(mint(h, secretId, "t3", start + 59_999))).toBe("capacity");
    // A minute on, the bucket is clear but three are unexpired: the cap.
    expect(await status(mint(h, secretId, "t3", start + 60_000))).toBe("ok");
    expect(await status(mint(h, secretId, "t4", start + 60_000))).toBe("capacity");
    // At the first two's expiry the cap frees.
    expect(await status(mint(h, secretId, "t4", start + 600_000))).toBe("ok");
    expect(await h.audits("oauth.token_issued")).toHaveLength(4);
  });

  it("mintServiceToken clamps a run token to its credential's lifetime and to the grant's expiry", async h => {
    const { secretId } = await added(h, { tokenSeconds: 120, expiresAt: start + 1_000_000 });
    expect(await mint(h, secretId, "t1")).toEqual({ status: "ok", value: { expiresAt: start + 120_000 } });
    expect(await mint(h, secretId, "t2", start + 950_000)).toEqual({ status: "ok", value: { expiresAt: start + 1_000_000 } });
    expect(await status(mint(h, secretId, "t3", start + 1_000_000))).toBe("invalid");
  });

  it("cleanup drops a revoked secret once its last token is gone, and keeps live ones", async h => {
    const { secretId } = await added(h);
    const second = await h.write(tx => h.oauth.rotateServiceCredential(tx, { clientId: SVC_CLIENT, secretHash: sha("secret-2") }, start));
    if (second.status !== "ok") throw new Error(`rotate answered ${second.status}`);
    expect(await status(mint(h, secretId, "t1"))).toBe("ok");
    await h.write(tx => h.oauth.revokeServiceSecret(tx, secretId, start + 1));
    await h.write(tx => h.oauth.cleanup(tx, start + 1));
    expect((await h.rows("service_credential_secrets")).map(s => s.id).sort()).toEqual([secretId, second.value.secretId].sort());
    await h.write(tx => h.oauth.cleanup(tx, start + 600_000));
    expect(await h.rows("oauth_tokens")).toEqual([]);
    expect((await h.rows("service_credential_secrets")).map(s => s.id)).toEqual([second.value.secretId]);
  });
}

// The per-grant list and revoke (#930).
function userGrants(it: It): void {
  async function two(h: OAuthHarness) {
    const a = await world(h, "a");
    const b = await world(h, "b");
    return { userId: a.userId, a: await a.issue(), b: await b.issue() };
  }

  it("listGrants lists the user's live grants newest use first, a credential's grant flagged, and nothing of another user's", async h => {
    const { userId, a, b } = await two(h);
    const svc = await h.write(tx => h.services.create(tx, "ingest"));
    expect(await status(h.write(tx => h.oauth.addServiceCredential(tx, credential(svc.id), start)))).toBe("ok");
    // Same last use: the grant id breaks the tie.
    expect(await h.oauth.listGrants(h.read, userId, start)).toEqual([
      { id: a.grantId, clientId: binding.clientId, createdAt: start, expiresAt: start + OAUTH_TTL.grant, lastUsedAt: start, credential: false },
      { id: b.grantId, clientId: binding.clientId, createdAt: start, expiresAt: start + OAUTH_TTL.grant, lastUsedAt: start, credential: false },
    ]);
    // A rotation of b's refresh token makes it the newest use.
    expect(await status(h.write(tx => h.oauth.rotateRefresh(tx, { ...binding, refreshHash: b.tokens.refreshHash, tokens: pair(binding, start + 5) }, start + 5)))).toBe("ok");
    expect((await h.oauth.listGrants(h.read, userId, start + 5)).map(g => [g.id, g.lastUsedAt])).toEqual([[b.grantId, start + 5], [a.grantId, start]]);
    // A grant with no token left lists its creation as its last use.
    expect(await h.oauth.listGrants(h.read, svc.id, start + 5)).toEqual([
      { id: credential(svc.id).grantId, clientId: SVC_CLIENT, createdAt: start, expiresAt: credential(svc.id).expiresAt, lastUsedAt: start, credential: true }]);
    expect(await status(h.write(tx => h.oauth.revokeUserGrant(tx, userId, a.grantId, start + 6)))).toBe("ok");
    expect((await h.oauth.listGrants(h.read, userId, start + 6)).map(g => g.id)).toEqual([b.grantId]);
    expect(await h.oauth.listGrants(h.read, userId, start + OAUTH_TTL.grant)).toEqual([]);
    expect(await h.oauth.listGrants(h.read, userId + 1000, start)).toEqual([]);
    expect(await h.oauth.listGrants(h.read, 1.5, start)).toEqual([]);
    expect(await h.oauth.listGrants(h.read, userId, -1)).toEqual([]);
  });

  it("revokeUserGrant revokes one of the user's grants and its tokens, leaves the others, refuses a credential's, another user's and a bad input", async h => {
    const { userId, a, b } = await two(h);
    const svc = await h.write(tx => h.services.create(tx, "ingest"));
    expect(await status(h.write(tx => h.oauth.addServiceCredential(tx, credential(svc.id), start)))).toBe("ok");
    const revoke = (uid: number, grantId: string, now = start + 1) => h.write(tx => h.oauth.revokeUserGrant(tx, uid, grantId, now));
    for (const [uid, gid, now] of [[1.5, a.grantId, start + 1], [userId, "", start + 1], [userId, 5 as unknown as string, start + 1], [userId, a.grantId, -1]] as const) {
      expect(await status(revoke(uid, gid, now))).toBe("invalid");
    }
    expect(await status(revoke(userId + 1000, a.grantId))).toBe("not_found");
    expect(await status(revoke(userId, "grant_unknown0123456789"))).toBe("not_found");
    // A credential's grant: its owner's revoke is refused, so its own revoke keeps service.credential_revoked.
    expect(await status(revoke(svc.id, credential(svc.id).grantId))).toBe("invalid");
    expect(await status(revoke(userId, credential(svc.id).grantId))).toBe("not_found");
    expect(await h.oauth.isGrantActive(h.read, credential(svc.id).grantId, start + 1)).toBe(true);
    for (const g of [a, b]) expect(await h.oauth.isGrantActive(h.read, g.grantId, start + 1)).toBe(true);

    expect(await revoke(userId, a.grantId)).toEqual({ status: "ok", value: { clientId: binding.clientId } });
    expect(await h.oauth.isGrantActive(h.read, a.grantId, start + 1)).toBe(false);
    expect(await h.oauth.findActiveAccess(h.read, a.tokens.accessHash, binding.resource, [], start + 1)).toBeUndefined();
    expect(await status(h.write(tx => h.oauth.rotateRefresh(tx, { ...binding, refreshHash: a.tokens.refreshHash, tokens: pair(binding, start + 2) }, start + 2)))).not.toBe("ok");
    // The other grant still serves and refreshes.
    expect((await h.oauth.findActiveAccess(h.read, b.tokens.accessHash, binding.resource, [], start + 2))?.grantId).toBe(b.grantId);
    expect(await status(h.write(tx => h.oauth.rotateRefresh(tx, { ...binding, refreshHash: b.tokens.refreshHash, tokens: pair(binding, start + 2) }, start + 2)))).toBe("ok");
    // A second revoke finds nothing live; an expired grant is not revocable either.
    expect(await status(revoke(userId, a.grantId, start + 3))).toBe("not_found");
    expect(await status(revoke(userId, b.grantId, start + OAUTH_TTL.grant))).toBe("not_found");
    // The caller audits: the store writes no row of its own.
    expect(await h.audits("auth.grant_revoked")).toEqual([]);
  });

  // A live browser session consents without the IdP, so the lost device could mint a replacement (#1552).
  it("revokeUserGrant and sessions.revokeOwn end the user's browser sessions and unspent codes, not another user's or a spent code", async h => {
    const a = await world(h, "a");
    const issued = await a.issue();
    const pending = await world(h, "p");
    await pending.issueCode();
    // A consent bound before the revoke and decided after it.
    const late = await world(h, "l");
    await h.write(async tx => {
      expect(await status(h.oauth.createRequest(tx, late.request, start))).toBe("ok");
      expect(await status(h.oauth.bindRequestSession(tx, late.request.requestHash, late.request.browserHash, late.sessionHash, start))).toBe("ok");
    });
    const other = (await h.write(tx => h.users.upsertByEmail(tx, "other@example.com", null))).id;
    expect(await status(h.write(tx => h.oauth.createBrowserSession(tx, { sessionHash: sha("other-browser"), userId: other, createdAt: start, expiresAt: start + 1000 }, start)))).toBe("ok");
    expect(await h.rows("oauth_browsers")).toHaveLength(4);

    expect(await status(h.write(tx => h.oauth.revokeUserGrant(tx, a.userId, issued.grantId, start + 1)))).toBe("ok");
    expect((await h.rows("oauth_browsers")).map(r => r.user_id)).toEqual([other]);
    // The spent code stays, so a replay still reaches its grant; the unspent one is gone.
    expect((await h.rows("oauth_codes")).map(r => r.hash)).toEqual([a.code.codeHash]);
    expect(await status(h.write(tx => h.oauth.redeemCode(tx, pending.redemption(), start + 1)))).not.toBe("ok");
    expect(await status(h.write(tx => h.oauth.decideRequest(tx, late.decision(), start + 1)))).not.toBe("ok");

    // A CLI token's revoke does the same; a refused one ends nothing.
    const cli = await h.write(tx => h.sessions.create(tx, a.userId, sha("cli-token"), "laptop"));
    expect(await status(h.write(tx => h.oauth.createBrowserSession(tx, { sessionHash: sha("again"), userId: a.userId, createdAt: start + 2, expiresAt: start + 1000 }, start + 2)))).toBe("ok");
    expect(await h.write(tx => h.sessions.revokeOwn(tx, other, cli.id))).toBe(false);
    expect(await h.rows("oauth_browsers")).toHaveLength(2);
    expect(await h.write(tx => h.sessions.revokeOwn(tx, a.userId, cli.id))).toBe(true);
    expect((await h.rows("oauth_browsers")).map(r => r.user_id)).toEqual([other]);
  });
}
