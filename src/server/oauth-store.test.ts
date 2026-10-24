import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db.ts";
import { OAUTH_TTL, type OAuthAuthorization, type OAuthCode, type OAuthRequest, type OAuthTokenPair } from "./oauth-types.ts";

const h = (s: string) => createHash("sha256").update(s).digest("hex");
const start = 1_800_000_000_000;
const binding: OAuthAuthorization = { clientId: "native", resource: "https://example.com/mcp", scopes: ["grayboard:tools"], redirectUri: "http://127.0.0.1/callback", codeChallenge: "A".repeat(43) };
let serial = 0;
const pair = (now = start, cap = now + OAUTH_TTL.grant): OAuthTokenPair => ({ ...binding,
  accessHash: h(`access-${++serial}`), refreshHash: h(`refresh-${serial}`),
  accessExpiresAt: Math.min(now + OAUTH_TTL.access, cap), refreshExpiresAt: Math.min(now + OAUTH_TTL.refresh, cap) });

describe("OAuth domain store", () => {
  let dir: string;
  let first: ReturnType<typeof openDatabase>;
  let second: ReturnType<typeof openDatabase>;
  let userId: number;
  let request: OAuthRequest;
  let code: OAuthCode;
  const sessionHash = h("browser-session");
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "grayboard-oauth-"));
    const opts = { blobDir: join(dir, "blobs") };
    first = openDatabase(join(dir, "db.sqlite"), opts);
    second = openDatabase(join(dir, "db.sqlite"), opts);
    userId = first.repo.users.upsertByEmail("you@example.com", null).id;
    request = { ...binding, requestHash: h("request"), browserHash: h("browser"), csrfHash: h("csrf"), stateHash: h("state"), consentSessionHash: null, createdAt: start, expiresAt: start + OAUTH_TTL.request };
    code = { ...binding, userId, codeHash: h("code"), createdAt: start, expiresAt: start + OAUTH_TTL.code };
    expect(first.repo.oauth.createBrowserSession({ sessionHash, userId, createdAt: start, expiresAt: start + OAUTH_TTL.browser }, start).status).toBe("ok");
  });
  afterEach(() => { second.db.close(); first.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const decision = () => ({ requestHash: request.requestHash, browserHash: request.browserHash, csrfHash: request.csrfHash, sessionHash, approve: true, code });
  function issueCode() {
    expect(first.repo.oauth.createRequest(request, start).status).toBe("ok");
    expect(first.repo.oauth.bindRequestSession(request.requestHash, request.browserHash, sessionHash, start).status).toBe("ok");
    expect(first.repo.oauth.decideRequest(decision(), start).status).toBe("ok");
  }
  function redemption(tokens = pair(), grantId = "grant_0123456789abcdef") {
    return { ...binding, codeHash: code.codeHash, grantId, grantExpiresAt: start + OAUTH_TTL.grant, tokens };
  }
  function issue() {
    issueCode();
    const input = redemption();
    expect(first.repo.oauth.redeemCode(input, start).status).toBe("ok");
    return input;
  }
  test("consent is one-use, browser/CSRF/session/account bound, including denial", () => {
    const o = first.repo.oauth;
    o.createRequest(request, start);
    expect(o.decideRequest(decision(), start).status).toBe("invalid");
    expect(o.bindRequestSession(request.requestHash, request.browserHash, sessionHash, start).status).toBe("ok");
    const alternate = h("another-session");
    o.createBrowserSession({ sessionHash: alternate, userId, createdAt: start, expiresAt: start + 1000 }, start);
    expect(o.bindRequestSession(request.requestHash, request.browserHash, alternate, start).status).toBe("invalid");
    expect(o.decideRequest({ ...decision(), sessionHash: alternate }, start).status).toBe("invalid");
    expect(o.findRequest(request.requestHash, h("other"), start)).toBeUndefined();
    for (const change of [{ browserHash: h("other") }, { csrfHash: h("other") }, { sessionHash: h("other") }, { code: { ...code, userId: userId + 1 } }, { code: { ...code, resource: "wrong" } }]) {
      expect(o.decideRequest({ ...decision(), ...change }, start).status).not.toBe("ok");
    }
    expect(o.decideRequest({ ...decision(), approve: false }, start)).toEqual({ status: "ok", value: null });
    expect(o.decideRequest(decision(), start).status).toBe("not_found");
    expect(o.redeemCode(redemption(), start).status).toBe("not_found");
  });
  test("invalid code bindings and replacements do not consume; two connections have one winner", async () => {
    issueCode();
    const input = redemption();
    for (const change of [{ clientId: "foreign" }, { resource: "wrong" }, { scopes: ["grayboard:delivery"] }, { redirectUri: "https://evil.example/cb" }, { codeChallenge: "B".repeat(43) }, { codeHash: h("wrong") }, { grantExpiresAt: start + OAUTH_TTL.grant + 1 }, { tokens: { ...input.tokens, scopes: ["grayboard:delivery"] } }, { tokens: { ...input.tokens, accessHash: "raw-secret" } }, { tokens: { ...input.tokens, refreshExpiresAt: start + OAUTH_TTL.refresh + 1 } }]) {
      expect(first.repo.oauth.redeemCode({ ...input, ...change }, start).status).not.toBe("ok");
    }
    const results = await Promise.all([Promise.resolve().then(() => first.repo.oauth.redeemCode(input, start)), Promise.resolve().then(() => second.repo.oauth.redeemCode({ ...input, grantId: "grant_2222222222222222", tokens: pair() }, start))]);
    expect(results.map(r => r.status).sort()).toEqual(["ok", "replay"]);
    expect(first.repo.oauth.findActiveAccess(input.tokens.accessHash, binding.resource, binding.scopes, start)).toBeUndefined();
    expect(first.repo.oauth.isGrantActive(input.grantId, start)).toBe(false);
  });
  test("failed insertion rolls back code consumption and half-grant", () => {
    issueCode();
    const input = redemption();
    first.db.exec("CREATE TRIGGER fail_oauth_token BEFORE INSERT ON oauth_tokens WHEN NEW.kind = 'refresh' BEGIN SELECT RAISE(ABORT, 'injected'); END");
    expect(() => first.repo.oauth.redeemCode(input, start)).toThrow("injected");
    expect(first.db.query("SELECT * FROM oauth_grants").all()).toHaveLength(0);
    expect(first.db.query("SELECT * FROM oauth_tokens").all()).toHaveLength(0);
    first.db.exec("DROP TRIGGER fail_oauth_token");
    expect(second.repo.oauth.redeemCode(input, start).status).toBe("ok");
  });
  test("refresh is stable, binding failures cannot burn or revoke; ancestor replay commits family revocation", () => {
    const input = issue();
    const next = { ...binding, refreshHash: input.tokens.refreshHash, tokens: pair(start + 1) };
    expect(first.repo.oauth.findRefreshGrant(input.tokens.refreshHash, binding.clientId, binding.resource, start)?.id).toBe(input.grantId);
    expect(first.repo.oauth.findRefreshGrant(input.tokens.refreshHash, "foreign", binding.resource, start)).toBeUndefined();
    expect(first.repo.oauth.findRefreshGrant(input.tokens.refreshHash, binding.clientId, "wrong", start)).toBeUndefined();
    for (const change of [{ clientId: "foreign" }, { resource: "wrong" }, { scopes: ["grayboard:delivery"] }, { tokens: { ...next.tokens, resource: "wrong" } }, { tokens: { ...next.tokens, refreshHash: next.refreshHash } }]) {
      expect(second.repo.oauth.rotateRefresh({ ...next, ...change }, start + 1).status).toBe("invalid");
      expect(first.repo.oauth.isGrantActive(input.grantId, start + 1)).toBe(true);
    }
    expect(second.repo.oauth.rotateRefresh(next, start + 1).status).toBe("ok");
    const newest = { ...binding, refreshHash: next.tokens.refreshHash, tokens: pair(start + 2) };
    expect(first.repo.oauth.rotateRefresh(newest, start + 2).status).toBe("ok");
    expect(first.repo.oauth.rotateRefresh({ ...next, clientId: "foreign" }, start + 3).status).toBe("invalid");
    expect(first.repo.oauth.rotateRefresh({ ...next, tokens: pair(start + 3) }, start + 3).status).toBe("replay");
    expect(second.repo.oauth.isGrantActive(input.grantId, start + 3)).toBe(false);
    for (const p of [input.tokens, next.tokens, newest.tokens]) expect(first.repo.oauth.findActiveAccess(p.accessHash, binding.resource, [], start + 3)).toBeUndefined();
    expect(first.repo.oauth.rotateRefresh({ ...binding, refreshHash: newest.tokens.refreshHash, tokens: pair(start + 4) }, start + 4).status).toBe("invalid");
  });
  test("refresh failure rollback leaves current refresh live and no successor", () => {
    const input = issue();
    const next = { ...binding, refreshHash: input.tokens.refreshHash, tokens: pair(start + 1) };
    first.db.exec("CREATE TRIGGER fail_refresh BEFORE INSERT ON oauth_tokens WHEN NEW.kind = 'refresh' BEGIN SELECT RAISE(ABORT, 'injected'); END");
    expect(() => first.repo.oauth.rotateRefresh(next, start + 1)).toThrow("injected");
    expect(first.db.query("SELECT * FROM oauth_tokens").all()).toHaveLength(2);
    first.db.exec("DROP TRIGGER fail_refresh");
    expect(second.repo.oauth.rotateRefresh(next, start + 1).status).toBe("ok");
  });
  test("refresh race winner is revoked by strict replay from the other connection", async () => {
    const input = issue();
    const a = pair(start + 1), b = pair(start + 1);
    const results = await Promise.all([Promise.resolve().then(() => first.repo.oauth.rotateRefresh({ ...binding, refreshHash: input.tokens.refreshHash, tokens: a }, start + 1)), Promise.resolve().then(() => second.repo.oauth.rotateRefresh({ ...binding, refreshHash: input.tokens.refreshHash, tokens: b }, start + 1))]);
    expect(results.map(r => r.status).sort()).toEqual(["ok", "replay"]);
    expect(first.repo.oauth.isGrantActive(input.grantId, start + 1)).toBe(false);
  });
  test("revoke access is individual, refresh revokes grant, foreign/unknown inputs are inert", () => {
    const input = issue();
    const o = first.repo.oauth;
    o.revokeToken(input.tokens.refreshHash, "foreign", start + 1);
    o.revokeToken(h("unknown"), binding.clientId, start + 1);
    o.revokeToken(input.tokens.accessHash, binding.clientId, start + 1);
    expect(o.isGrantActive(input.grantId, start + 1)).toBe(true);
    expect(o.findActiveAccess(input.tokens.accessHash, binding.resource, [], start + 1)).toBeUndefined();
    const next = pair(start + 1);
    expect(second.repo.oauth.rotateRefresh({ ...binding, refreshHash: input.tokens.refreshHash, tokens: next }, start + 1).status).toBe("ok");
    o.revokeToken(input.tokens.refreshHash, binding.clientId, start + 2);
    o.revokeToken(input.tokens.refreshHash, binding.clientId, start + 2);
    expect(second.repo.oauth.rotateRefresh({ ...binding, refreshHash: next.refreshHash, tokens: pair(start + 2) }, start + 2).status).toBe("invalid");
  });
  test("revoke and issue serial schedules never resurrect a grant", () => {
    const input = issue();
    first.repo.oauth.revokeToken(input.tokens.refreshHash, binding.clientId, start + 1);
    expect(second.repo.oauth.rotateRefresh({ ...binding, refreshHash: input.tokens.refreshHash, tokens: pair(start + 1) }, start + 1).status).toBe("invalid");
    expect(second.repo.oauth.isGrantActive(input.grantId, start + 1)).toBe(false);
  });
  test("access verifies resource, scopes, user, expiry; disable/reenable cannot resurrect", () => {
    const input = issue();
    const o = first.repo.oauth;
    expect(o.findActiveAccess(input.tokens.accessHash, "wrong", [], start)).toBeUndefined();
    expect(o.findActiveAccess(input.tokens.accessHash, binding.resource, ["grayboard:delivery"], start)).toBeUndefined();
    expect(o.findActiveAccess(input.tokens.accessHash, binding.resource, [], input.tokens.accessExpiresAt)).toBeUndefined();
    first.repo.users.setDisabled(userId, true);
    expect(o.findBrowserSession(sessionHash, start)).toBeUndefined();
    expect(o.isGrantActive(input.grantId, start)).toBe(false);
    first.repo.users.setDisabled(userId, false);
    expect(o.isGrantActive(input.grantId, start)).toBe(false);
  });
  test("admin revoke-all includes OAuth; single old-session logout and browser logout do not", () => {
    const input = issue();
    const s = first.repo.sessions.create(userId, "old-hash", null);
    first.repo.sessions.revoke(s.id);
    first.repo.oauth.revokeBrowserSession(sessionHash);
    expect(first.repo.oauth.isGrantActive(input.grantId, start)).toBe(true);
    first.repo.sessions.revokeAllForUser(userId);
    expect(first.repo.oauth.isGrantActive(input.grantId, start)).toBe(false);
  });
  test("expiry caps, cleanup and retained spent refresh tombstones", () => {
    const input = issue();
    const later = start + OAUTH_TTL.refresh - 1;
    const next = pair(later);
    expect(first.repo.oauth.rotateRefresh({ ...binding, refreshHash: input.tokens.refreshHash, tokens: next }, later).status).toBe("ok");
    first.repo.oauth.cleanup(start + OAUTH_TTL.refresh + 1);
    expect(first.db.query("SELECT * FROM oauth_tokens WHERE hash = ?").get(input.tokens.refreshHash)).not.toBeNull();
    expect(first.repo.oauth.rotateRefresh({ ...binding, refreshHash: input.tokens.refreshHash, tokens: pair(start + OAUTH_TTL.refresh + 1) }, start + OAUTH_TTL.refresh + 1).status).toBe("replay");
    first.repo.oauth.cleanup(input.grantExpiresAt);
    expect(first.db.query("SELECT * FROM oauth_tokens").all()).toHaveLength(0);
    expect(first.db.query("SELECT * FROM oauth_grants").all()).toHaveLength(0);
  });
  test("absolute family deadline cannot be extended or crossed by replacements", () => {
    issueCode();
    const input = redemption();
    input.grantExpiresAt = start + 100;
    input.tokens = pair(start, input.grantExpiresAt);
    expect(first.repo.oauth.redeemCode(input, start).status).toBe("ok");
    const result = first.repo.oauth.rotateRefresh({ ...binding, refreshHash: input.tokens.refreshHash, tokens: pair(start + 1) }, start + 1);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("rotation failed");
    expect(result.value.tokens.accessExpiresAt).toBe(input.grantExpiresAt);
    expect(result.value.tokens.refreshExpiresAt).toBe(input.grantExpiresAt);
    expect(first.repo.oauth.isGrantActive(input.grantId, input.grantExpiresAt)).toBe(false);
  });
  test("state/session/code expiry boundaries and canonical scopes are enforced", () => {
    expect(first.repo.oauth.createRequest({ ...request, scopes: ["z", "a"] }, start).status).toBe("invalid");
    expect(first.repo.oauth.createRequest({ ...request, scopes: ["a", "a"] }, start).status).toBe("invalid");
    expect(first.repo.oauth.createRequest({ ...request, expiresAt: request.expiresAt + 1 }, start).status).toBe("invalid");
    first.repo.oauth.createRequest(request, start);
    first.repo.oauth.bindRequestSession(request.requestHash, request.browserHash, sessionHash, start);
    expect(first.repo.oauth.findRequest(request.requestHash, request.browserHash, request.expiresAt)).toBeUndefined();
    expect(first.repo.oauth.findBrowserSession(sessionHash, start + OAUTH_TTL.browser)).toBeUndefined();
    expect(first.repo.oauth.decideRequest(decision(), start).status).toBe("ok");
    expect(first.repo.oauth.redeemCode(redemption(), code.expiresAt).status).toBe("not_found");
  });
  test("pending request capacity bounded and expired entries reclaimed", () => {
    for (let i = 0; i < 10; i++) expect(first.repo.oauth.createRequest({ ...request, requestHash: h(`request-${i}`) }, start).status).toBe("ok");
    expect(first.repo.oauth.createRequest(request, start).status).toBe("capacity");
    const now = request.expiresAt;
    expect(first.repo.oauth.createRequest({ ...request, createdAt: now, expiresAt: now + 1 }, now).status).toBe("ok");
  });
  test("persistence whitelists fields and rejects un-hashed capability material", () => {
    const raw = "must-not-persist-secret";
    expect(first.repo.oauth.createRequest({ ...request, requestHash: raw }, start).status).toBe("invalid");
    expect(first.repo.oauth.createBrowserSession({ sessionHash: raw, userId, createdAt: start, expiresAt: start + 1 }, start).status).toBe("invalid");
    first.repo.oauth.createRequest({ ...request, rawState: raw } as OAuthRequest, start);
    expect(JSON.stringify(first.db.query("SELECT * FROM oauth_requests").all())).not.toContain(raw);
    first.repo.oauth.bindRequestSession(request.requestHash, request.browserHash, sessionHash, start);
    first.repo.oauth.decideRequest({ ...decision(), code: { ...code, rawCode: raw } as OAuthCode }, start);
    expect(JSON.stringify(first.db.query("SELECT * FROM oauth_codes").all())).not.toContain(raw);
    const input = redemption();
    expect(first.repo.oauth.redeemCode(input, start).status).toBe("ok");
    for (const table of ["oauth_requests", "oauth_browsers", "oauth_codes", "oauth_grants", "oauth_tokens"]) {
      expect(JSON.stringify(first.db.query(`SELECT * FROM ${table}`).all())).not.toContain(raw);
    }
  });
  test("reopen preserves grants, hash-only capabilities and refresh lineage", () => {
    const input = issue();
    second.db.close();
    second = openDatabase(join(dir, "db.sqlite"), { blobDir: join(dir, "blobs") });
    expect(second.repo.oauth.findActiveAccess(input.tokens.accessHash, binding.resource, binding.scopes, start)?.userId).toBe(userId);
    const serialized = JSON.stringify(first.db.query("SELECT * FROM oauth_tokens").all());
    expect(serialized).toContain(input.tokens.refreshHash);
    expect(serialized).not.toContain(`refresh-${serial}\"`);
    expect(second.repo.oauth.rotateRefresh({ ...binding, refreshHash: input.tokens.refreshHash, tokens: pair(start + 1) }, start + 1).status).toBe("ok");
  });
  test("independent processes serialize simultaneous code and refresh consumption", async () => {
    issueCode();
    const input = redemption();
    const modulePath = new URL("./db.ts", import.meta.url).pathname;
    async function race(action: "redeemCode" | "rotateRefresh", inputs: unknown[]) {
      const due = Date.now() + 700;
      const script = `import { openDatabase } from ${JSON.stringify(modulePath)};
        const {db,repo}=openDatabase(process.argv[1], {blobDir:process.argv[2]});
        while(Date.now()<Number(process.argv[3])) {}
        const result=repo.oauth[process.argv[4]](JSON.parse(process.argv[5]), ${start + 1});
        console.log(JSON.stringify(result)); db.close();`;
      return await Promise.all(inputs.map(async value => {
        const child = Bun.spawn([process.execPath, "-e", script, join(dir, "db.sqlite"), join(dir, "blobs"), String(due), action, JSON.stringify(value)], { stdout: "pipe", stderr: "pipe" });
        const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
        return JSON.parse(stdout);
      }));
    }
    const codes = await race("redeemCode", [input, { ...input, grantId: "grant_second_22222222", tokens: pair() }]);
    expect(codes.map(r => r.status).sort()).toEqual(["ok", "replay"]);
    const codeWinner = codes.find(r => r.status === "ok").value;
    expect(first.repo.oauth.isGrantActive(codeWinner.grant.id, start + 1)).toBe(false);
    expect(first.repo.oauth.findActiveAccess(codeWinner.tokens.accessHash, binding.resource, [], start + 1)).toBeUndefined();
    expect(first.repo.oauth.rotateRefresh({ ...binding, refreshHash: codeWinner.tokens.refreshHash, tokens: pair(start + 1) }, start + 1).status).toBe("invalid");
    request = { ...request, requestHash: h("second-request") };
    code = { ...code, codeHash: h("second-code") };
    issueCode();
    const fresh = redemption(pair(), "grant_refresh_3333333333");
    const issued = first.repo.oauth.redeemCode(fresh, start);
    if (issued.status !== "ok") throw new Error("fresh grant failed");
    const winner = issued.value;
    const rotations = await race("rotateRefresh", [
      { ...binding, refreshHash: winner.tokens.refreshHash, tokens: pair(start + 1) },
      { ...binding, refreshHash: winner.tokens.refreshHash, tokens: pair(start + 1) },
    ]);
    expect(rotations.map(r => r.status).sort()).toEqual(["ok", "replay"]);
    expect(first.repo.oauth.isGrantActive(winner.grant.id, start + 1)).toBe(false);
  });
  test("consent insert failure rolls back one-use request", () => {
    first.repo.oauth.createRequest(request, start);
    first.repo.oauth.bindRequestSession(request.requestHash, request.browserHash, sessionHash, start);
    first.db.exec("CREATE TRIGGER fail_code BEFORE INSERT ON oauth_codes BEGIN SELECT RAISE(ABORT, 'injected'); END");
    expect(() => first.repo.oauth.decideRequest(decision(), start)).toThrow("injected");
    expect(second.repo.oauth.findRequest(request.requestHash, request.browserHash, start)).toBeDefined();
    first.db.exec("DROP TRIGGER fail_code");
    expect(second.repo.oauth.decideRequest(decision(), start).status).toBe("ok");
  });
  test("refresh access scopes may narrow independently of stable original refresh permission", () => {
    const full = ["grayboard:delivery", "grayboard:tools"];
    request = { ...request, scopes: full };
    code = { ...code, scopes: full };
    issueCode();
    const input = { ...redemption(), scopes: full, tokens: { ...pair(), scopes: full } };
    expect(first.repo.oauth.redeemCode(input, start).status).toBe("ok");
    const narrow = { ...binding, scopes: ["grayboard:tools"], refreshHash: input.tokens.refreshHash,
      tokens: { ...pair(start + 1), scopes: ["grayboard:tools"] } };
    for (const changed of [
      { ...narrow, scopes: ["grayboard:admin"], tokens: { ...narrow.tokens, scopes: ["grayboard:admin"] } },
      { ...narrow, scopes: [] },
      { ...narrow, scopes: ["grayboard:tools", "grayboard:tools"] },
      { ...narrow, scopes: ["grayboard:tools", "grayboard:delivery"] },
      { ...narrow, tokens: { ...narrow.tokens, scopes: full } },
      { ...narrow, tokens: { ...narrow.tokens, accessHash: "unhashed" } },
      { ...narrow, tokens: { ...narrow.tokens, refreshExpiresAt: start + OAUTH_TTL.refresh + 2 } },
    ]) expect(second.repo.oauth.rotateRefresh(changed, start + 1).status).toBe("invalid");
    expect(first.db.query("SELECT spent_at FROM oauth_tokens WHERE hash = ?").get(input.tokens.refreshHash)).toEqual({ spent_at: null });
    const result = second.repo.oauth.rotateRefresh(narrow, start + 1);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("narrow rotation failed");
    expect(result.value.grant.scopes).toEqual(full);
    expect(result.value.tokens.scopes).toEqual(["grayboard:tools"]);
    expect(first.repo.oauth.findActiveAccess(narrow.tokens.accessHash, binding.resource, ["grayboard:delivery"], start + 1)).toBeUndefined();
    expect(first.repo.oauth.findActiveAccess(narrow.tokens.accessHash, binding.resource, ["grayboard:tools"], start + 1)?.scopes).toEqual(["grayboard:tools"]);
    const original = first.repo.oauth.findRefreshGrant(narrow.tokens.refreshHash, binding.clientId, binding.resource, start + 2)!;
    expect(original.scopes).toEqual(full);
    const other = { ...pair(start + 2), scopes: ["grayboard:delivery"] };
    expect(second.repo.oauth.rotateRefresh({ ...binding, scopes: other.scopes, refreshHash: narrow.tokens.refreshHash, tokens: other }, start + 2).status).toBe("ok");
    expect(first.repo.oauth.findActiveAccess(other.accessHash, binding.resource, ["grayboard:tools"], start + 2)).toBeUndefined();
    // A service resolves an omitted scope from the full original refresh authorization.
    const defaults = first.repo.oauth.findRefreshGrant(other.refreshHash, binding.clientId, binding.resource, start + 3)!;
    const restored = { ...pair(start + 3), scopes: defaults.scopes };
    expect(first.repo.oauth.rotateRefresh({ ...defaults, refreshHash: other.refreshHash, tokens: restored }, start + 3).status).toBe("ok");
    expect(first.repo.oauth.findActiveAccess(restored.accessHash, binding.resource, full, start + 3)?.scopes).toEqual(full);
    second.db.close();
    second = openDatabase(join(dir, "db.sqlite"), { blobDir: join(dir, "blobs") });
    expect(second.repo.oauth.findActiveAccess(narrow.tokens.accessHash, binding.resource, ["grayboard:delivery"], start + 3)).toBeUndefined();
    expect(second.repo.oauth.findRefreshGrant(restored.refreshHash, binding.clientId, binding.resource, start + 3)?.scopes).toEqual(full);
  });
  test("code replay validates every binding before committing family revocation", () => {
    const input = issue();
    for (const changed of [{ clientId: "foreign" }, { resource: "wrong" }, { scopes: ["grayboard:delivery"] },
      { redirectUri: "https://evil.example/cb" }, { codeChallenge: "B".repeat(43) }, { codeHash: h("unknown") }]) {
      expect(second.repo.oauth.redeemCode({ ...input, ...changed }, start + 1).status).not.toBe("ok");
      expect(first.repo.oauth.isGrantActive(input.grantId, start + 1)).toBe(true);
    }
    expect(second.repo.oauth.redeemCode(input, start + 1).status).toBe("replay");
    expect(first.repo.oauth.findActiveAccess(input.tokens.accessHash, binding.resource, [], start + 1)).toBeUndefined();
    expect(first.repo.oauth.rotateRefresh({ ...binding, refreshHash: input.tokens.refreshHash, tokens: pair(start + 1) }, start + 1).status).toBe("invalid");
  });
  test("spent code tombstones survive expiry, reopen, disable/admin revoke and cleanup until family cap", () => {
    const input = issue();
    const later = code.expiresAt + 1;
    first.repo.oauth.cleanup(later);
    second.db.close();
    second = openDatabase(join(dir, "db.sqlite"), { blobDir: join(dir, "blobs") });
    expect(second.repo.oauth.redeemCode(input, later).status).toBe("replay");
    first.repo.sessions.revokeAllForUser(userId);
    first.repo.users.setDisabled(userId, true);
    expect(first.db.query("SELECT grant_id FROM oauth_codes WHERE hash = ?").get(code.codeHash)).toEqual({ grant_id: input.grantId });
    expect(second.repo.oauth.redeemCode(input, input.grantExpiresAt).status).toBe("not_found");
    first.repo.oauth.cleanup(input.grantExpiresAt);
    expect(first.db.query("SELECT * FROM oauth_codes").all()).toHaveLength(0);
    expect(first.db.query("SELECT * FROM oauth_grants").all()).toHaveLength(0);
  });
  test("pre-correction OAuth tables migrate additively and legacy access retains full grant scopes", () => {
    const input = issue();
    second.db.close();
    first.db.exec("DELETE FROM oauth_codes");
    first.db.exec("DROP INDEX idx_oauth_codes_grant");
    first.db.exec("ALTER TABLE oauth_codes DROP COLUMN grant_id");
    first.db.exec("ALTER TABLE oauth_tokens DROP COLUMN access_scopes");
    second = openDatabase(join(dir, "db.sqlite"), { blobDir: join(dir, "blobs") });
    expect(second.repo.oauth.findActiveAccess(input.tokens.accessHash, binding.resource, binding.scopes, start)?.scopes).toEqual(binding.scopes);
    expect(second.db.query("SELECT access_scopes FROM oauth_tokens WHERE hash = ?").get(input.tokens.accessHash)).toEqual({ access_scopes: null });
    expect(second.db.query("PRAGMA table_info(oauth_codes)").all().some((c: any) => c.name === "grant_id")).toBe(true);
    expect(second.repo.oauth.rotateRefresh({ ...binding, refreshHash: input.tokens.refreshHash, tokens: pair(start + 1) }, start + 1).status).toBe("ok");
  });
  test("expired unspent code never mints and is reclaimed", () => {
    issueCode();
    expect(first.repo.oauth.redeemCode(redemption(), code.expiresAt).status).toBe("not_found");
    first.repo.oauth.cleanup(code.expiresAt);
    expect(first.db.query("SELECT * FROM oauth_codes").all()).toHaveLength(0);
    expect(first.db.query("SELECT * FROM oauth_grants").all()).toHaveLength(0);
  });
  test("replay revocation errors propagate and a retry commits for code and refresh", () => {
    const input = issue();
    const next = { ...binding, refreshHash: input.tokens.refreshHash, tokens: pair(start + 1) };
    expect(first.repo.oauth.rotateRefresh(next, start + 1).status).toBe("ok");
    first.db.exec("CREATE TRIGGER fail_replay BEFORE UPDATE ON oauth_grants BEGIN SELECT RAISE(ABORT, 'replay failure'); END");
    expect(() => second.repo.oauth.redeemCode(input, start + 2)).toThrow("replay failure");
    expect(() => second.repo.oauth.rotateRefresh({ ...next, tokens: pair(start + 2) }, start + 2)).toThrow("replay failure");
    expect(first.repo.oauth.isGrantActive(input.grantId, start + 2)).toBe(true);
    first.db.exec("DROP TRIGGER fail_replay");
    expect(second.repo.oauth.rotateRefresh({ ...next, tokens: pair(start + 2) }, start + 2).status).toBe("replay");
    expect(second.repo.oauth.redeemCode(input, start + 2).status).toBe("replay");
    expect(first.repo.oauth.isGrantActive(input.grantId, start + 2)).toBe(false);
    expect(second.repo.oauth.redeemCode(input, start + 2).status).toBe("replay");
  });
  test("foreign writer contention fails closed in bounded time and retry succeeds after release", async () => {
    const input = issue();
    expect(first.db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 250 });
    const modulePath = new URL("./db.ts", import.meta.url).pathname;
    const script = `import { openDatabase } from ${JSON.stringify(modulePath)};
      const {db}=openDatabase(process.argv[1],{blobDir:process.argv[2]});
      db.exec('BEGIN IMMEDIATE');console.log('locked');await Bun.sleep(1200);db.exec('ROLLBACK');db.close();`;
    const child = Bun.spawn([process.execPath, "-e", script, join(dir, "db.sqlite"), join(dir, "blobs")], { stdout: "pipe", stderr: "pipe" });
    const reader = child.stdout.getReader();
    try {
      const ready = await reader.read();
      expect(new TextDecoder().decode(ready.value)).toContain("locked");
      const began = performance.now();
      expect(() => first.repo.oauth.rotateRefresh({ ...binding, refreshHash: input.tokens.refreshHash, tokens: pair(start + 1) }, start + 1)).toThrow(/locked|busy/i);
      const elapsed = performance.now() - began;
      expect(elapsed).toBeGreaterThanOrEqual(200);
      expect(elapsed).toBeLessThan(1000);
      expect(first.repo.oauth.isGrantActive(input.grantId, start + 1)).toBe(true);
      expect(await child.exited).toBe(0);
      expect(await new Response(child.stderr).text()).toBe("");
      expect(first.repo.oauth.rotateRefresh({ ...binding, refreshHash: input.tokens.refreshHash, tokens: pair(start + 1) }, start + 1).status).toBe("ok");
    } finally {
      reader.releaseLock();
      child.kill();
      await child.exited;
    }
  });
  test("storage errors propagate for revocation and admin transactions", () => {
    const input = issue();
    first.db.exec("CREATE TRIGGER fail_revoke BEFORE UPDATE ON oauth_grants BEGIN SELECT RAISE(ABORT, 'storage failure'); END");
    expect(() => first.repo.oauth.revokeToken(input.tokens.refreshHash, binding.clientId, start)).toThrow("storage failure");
    expect(first.repo.oauth.isGrantActive(input.grantId, start)).toBe(true);
    expect(() => first.repo.sessions.revokeAllForUser(userId)).toThrow("storage failure");
    expect(() => first.repo.users.setDisabled(userId, true)).toThrow("storage failure");
    expect(first.repo.users.findById(userId)?.disabled_at).toBeNull();
  });
});
