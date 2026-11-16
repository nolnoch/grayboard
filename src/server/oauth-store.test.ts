import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type Sync } from "./db.ts";
import { seed } from "../../tests/support/seed.ts";
import { transactionProcess } from "../../tests/support/transaction-process.ts";
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
  // The store's writes run in each connection's write queue, as a request's do.
  const w1 = <T>(fn: () => Sync<T>) => seed(first.repo, fn);
  const w2 = <T>(fn: () => Sync<T>) => seed(second.repo, fn);
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "grayboard-oauth-"));
    const opts = { blobDir: join(dir, "blobs") };
    first = openDatabase(join(dir, "db.sqlite"), opts);
    second = openDatabase(join(dir, "db.sqlite"), opts);
    await w1(() => {
      userId = first.repo.users.upsertByEmail("you@example.com", null).id;
      expect(first.repo.oauth.createBrowserSession({ sessionHash, userId, createdAt: start, expiresAt: start + OAUTH_TTL.browser }, start).status).toBe("ok");
    });
    request = { ...binding, requestHash: h("request"), browserHash: h("browser"), csrfHash: h("csrf"), stateHash: h("state"), consentSessionHash: null, createdAt: start, expiresAt: start + OAUTH_TTL.request };
    code = { ...binding, userId, codeHash: h("code"), createdAt: start, expiresAt: start + OAUTH_TTL.code };
  });
  afterEach(() => { second.db.close(); first.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const decision = () => ({ requestHash: request.requestHash, browserHash: request.browserHash, csrfHash: request.csrfHash, sessionHash, approve: true, code });
  function issueCode() {
    return w1(() => {
      expect(first.repo.oauth.createRequest(request, start).status).toBe("ok");
      expect(first.repo.oauth.bindRequestSession(request.requestHash, request.browserHash, sessionHash, start).status).toBe("ok");
      expect(first.repo.oauth.decideRequest(decision(), start).status).toBe("ok");
    });
  }
  function redemption(tokens = pair(), grantId = "grant_0123456789abcdef") {
    return { ...binding, codeHash: code.codeHash, grantId, grantExpiresAt: start + OAUTH_TTL.grant, tokens };
  }
  async function issue() {
    await issueCode();
    const input = redemption();
    expect((await w1(() => first.repo.oauth.redeemCode(input, start))).status).toBe("ok");
    return input;
  }
  test("consent is one-use, browser/CSRF/session/account bound, including denial", async () => {
    const o = first.repo.oauth;
    await w1(() => o.createRequest(request, start));
    expect((await w1(() => o.decideRequest(decision(), start))).status).toBe("invalid");
    expect((await w1(() => o.bindRequestSession(request.requestHash, request.browserHash, sessionHash, start))).status).toBe("ok");
    const alternate = h("another-session");
    await w1(() => o.createBrowserSession({ sessionHash: alternate, userId, createdAt: start, expiresAt: start + 1000 }, start));
    expect((await w1(() => o.bindRequestSession(request.requestHash, request.browserHash, alternate, start))).status).toBe("invalid");
    expect((await w1(() => o.decideRequest({ ...decision(), sessionHash: alternate }, start))).status).toBe("invalid");
    expect(o.findRequest(request.requestHash, h("other"), start)).toBeUndefined();
    for (const change of [{ browserHash: h("other") }, { csrfHash: h("other") }, { sessionHash: h("other") }, { code: { ...code, userId: userId + 1 } }, { code: { ...code, resource: "wrong" } }]) {
      expect((await w1(() => o.decideRequest({ ...decision(), ...change }, start))).status).not.toBe("ok");
    }
    expect(await w1(() => o.decideRequest({ ...decision(), approve: false }, start))).toEqual({ status: "ok", value: null });
    expect((await w1(() => o.decideRequest(decision(), start))).status).toBe("not_found");
    expect((await w1(() => o.redeemCode(redemption(), start))).status).toBe("not_found");
  });
  test("invalid code bindings and replacements do not consume; two connections have one winner", async () => {
    await issueCode();
    const input = redemption();
    for (const change of [{ clientId: "foreign" }, { resource: "wrong" }, { scopes: ["grayboard:delivery"] }, { redirectUri: "https://evil.example/cb" }, { codeChallenge: "B".repeat(43) }, { codeHash: h("wrong") }, { grantExpiresAt: start + OAUTH_TTL.grant + 1 }, { tokens: { ...input.tokens, scopes: ["grayboard:delivery"] } }, { tokens: { ...input.tokens, accessHash: "raw-secret" } }, { tokens: { ...input.tokens, refreshExpiresAt: start + OAUTH_TTL.refresh + 1 } }]) {
      expect((await w1(() => first.repo.oauth.redeemCode({ ...input, ...change }, start))).status).not.toBe("ok");
    }
    const results = await Promise.all([w1(() => first.repo.oauth.redeemCode(input, start)), w2(() => second.repo.oauth.redeemCode({ ...input, grantId: "grant_2222222222222222", tokens: pair() }, start))]);
    expect(results.map(r => r.status).sort()).toEqual(["ok", "replay"]);
    expect(first.repo.oauth.findActiveAccess(input.tokens.accessHash, binding.resource, binding.scopes, start)).toBeUndefined();
    expect(first.repo.oauth.isGrantActive(input.grantId, start)).toBe(false);
  });
  test("forced overlapping refresh transactions cannot mint two live successors", async () => {
    const input = await issue();
    const replacements = [pair(start + 1), pair(start + 1)];
    const release = join(dir, "release-refresh");
    const run = (index: number) => transactionProcess("tests/support/oauth-rotate.ts", [join(dir, "db.sqlite"), join(dir, "blobs"), JSON.stringify({ ...binding, refreshHash: input.tokens.refreshHash, tokens: replacements[index] }), String(start + 1)], index === 0 ? "oauth:refresh:in-txn" : "", release);
    const workers = [run(0), run(1)];
    try {
      await Promise.all(workers.map(w => w.wait("READY")));
      workers[0]!.proc.stdin.end();
      await workers[0]!.wait("test pause hit: oauth:refresh:in-txn");
      workers[1]!.proc.stdin.end();
      await workers[1]!.wait("ROTATING");
      expect(first.repo.oauth.isGrantActive(input.grantId, start + 1)).toBe(true);
      await Bun.write(release, "release");
      await Promise.all(workers.map(async w => { expect(await w.proc.exited).toBe(0); await w.done; }));
      expect(workers.map(w => JSON.parse(w.output().trim().split("\n").at(-1)!).status).sort()).toEqual(["ok", "replay"]);
      expect(first.repo.oauth.isGrantActive(input.grantId, start + 1)).toBe(false);
      for (const replacement of replacements) expect(first.repo.oauth.findActiveAccess(replacement.accessHash, binding.resource, binding.scopes, start + 1)).toBeUndefined();
    } finally {
      await Bun.write(release, "release");
      for (const w of workers) { w.proc.kill(); await w.proc.exited; }
    }
  }, 15_000);
  test("code scope lookup is bound, durable, and retains spent replay recognition without exposing PKCE", async () => {
    await issueCode();
    const get = (time = start) => second.repo.oauth.findCodeScopes(code.codeHash, binding.clientId, binding.resource, binding.redirectUri, time);
    expect(get()).toEqual(binding.scopes);
    for (const [client, resource, redirect] of [["wrong", binding.resource, binding.redirectUri], [binding.clientId, "wrong", binding.redirectUri], [binding.clientId, binding.resource, "wrong"]]) {
      expect(second.repo.oauth.findCodeScopes(code.codeHash, client!, resource!, redirect!, start)).toBeUndefined();
    }
    expect(get(start + OAUTH_TTL.code)).toBeUndefined();
    expect((await w1(() => first.repo.oauth.redeemCode(redemption(), start))).status).toBe("ok");
    expect(get(start + OAUTH_TTL.code)).toEqual(binding.scopes);
    expect(get(start + OAUTH_TTL.grant)).toBeUndefined();
    const reopened = openDatabase(join(dir, "db.sqlite"), { blobDir: join(dir, "blobs") });
    expect(reopened.repo.oauth.findCodeScopes(code.codeHash, binding.clientId, binding.resource, binding.redirectUri, start + OAUTH_TTL.code)).toEqual(binding.scopes);
    reopened.db.close();
    await w1(() => first.repo.users.setDisabled(userId, true));
    expect(get()).toBeUndefined();
  });
  test("failed insertion rolls back code consumption and half-grant", async () => {
    await issueCode();
    const input = redemption();
    first.db.exec("CREATE TRIGGER fail_oauth_token BEFORE INSERT ON oauth_tokens WHEN NEW.kind = 'refresh' BEGIN SELECT RAISE(ABORT, 'injected'); END");
    await expect(w1(() => first.repo.oauth.redeemCode(input, start))).rejects.toThrow("injected");
    expect(first.db.query("SELECT * FROM oauth_grants").all()).toHaveLength(0);
    expect(first.db.query("SELECT * FROM oauth_tokens").all()).toHaveLength(0);
    first.db.exec("DROP TRIGGER fail_oauth_token");
    expect((await w2(() => second.repo.oauth.redeemCode(input, start))).status).toBe("ok");
  });
  test("refresh is stable, binding failures cannot burn or revoke; ancestor replay commits family revocation", async () => {
    const input = await issue();
    const next = { ...binding, refreshHash: input.tokens.refreshHash, tokens: pair(start + 1) };
    expect(first.repo.oauth.findRefreshGrant(input.tokens.refreshHash, binding.clientId, binding.resource, start)?.id).toBe(input.grantId);
    expect(first.repo.oauth.findRefreshGrant(input.tokens.refreshHash, "foreign", binding.resource, start)).toBeUndefined();
    expect(first.repo.oauth.findRefreshGrant(input.tokens.refreshHash, binding.clientId, "wrong", start)).toBeUndefined();
    for (const change of [{ clientId: "foreign" }, { resource: "wrong" }, { scopes: ["grayboard:delivery"] }, { tokens: { ...next.tokens, resource: "wrong" } }, { tokens: { ...next.tokens, refreshHash: next.refreshHash } }]) {
      expect((await w2(() => second.repo.oauth.rotateRefresh({ ...next, ...change }, start + 1))).status).toBe("invalid");
      expect(first.repo.oauth.isGrantActive(input.grantId, start + 1)).toBe(true);
    }
    expect((await w2(() => second.repo.oauth.rotateRefresh(next, start + 1))).status).toBe("ok");
    const newest = { ...binding, refreshHash: next.tokens.refreshHash, tokens: pair(start + 2) };
    expect((await w1(() => first.repo.oauth.rotateRefresh(newest, start + 2))).status).toBe("ok");
    expect((await w1(() => first.repo.oauth.rotateRefresh({ ...next, clientId: "foreign" }, start + 3))).status).toBe("invalid");
    expect((await w1(() => first.repo.oauth.rotateRefresh({ ...next, tokens: pair(start + 3) }, start + 3))).status).toBe("replay");
    expect(second.repo.oauth.isGrantActive(input.grantId, start + 3)).toBe(false);
    for (const p of [input.tokens, next.tokens, newest.tokens]) expect(first.repo.oauth.findActiveAccess(p.accessHash, binding.resource, [], start + 3)).toBeUndefined();
    expect((await w1(() => first.repo.oauth.rotateRefresh({ ...binding, refreshHash: newest.tokens.refreshHash, tokens: pair(start + 4) }, start + 4))).status).toBe("invalid");
  });
  test("refresh failure rollback leaves current refresh live and no successor", async () => {
    const input = await issue();
    const next = { ...binding, refreshHash: input.tokens.refreshHash, tokens: pair(start + 1) };
    first.db.exec("CREATE TRIGGER fail_refresh BEFORE INSERT ON oauth_tokens WHEN NEW.kind = 'refresh' BEGIN SELECT RAISE(ABORT, 'injected'); END");
    await expect(w1(() => first.repo.oauth.rotateRefresh(next, start + 1))).rejects.toThrow("injected");
    expect(first.db.query("SELECT * FROM oauth_tokens").all()).toHaveLength(2);
    first.db.exec("DROP TRIGGER fail_refresh");
    expect((await w2(() => second.repo.oauth.rotateRefresh(next, start + 1))).status).toBe("ok");
  });
  test("refresh race winner is revoked by strict replay from the other connection", async () => {
    const input = await issue();
    const a = pair(start + 1), b = pair(start + 1);
    const results = await Promise.all([w1(() => first.repo.oauth.rotateRefresh({ ...binding, refreshHash: input.tokens.refreshHash, tokens: a }, start + 1)), w2(() => second.repo.oauth.rotateRefresh({ ...binding, refreshHash: input.tokens.refreshHash, tokens: b }, start + 1))]);
    expect(results.map(r => r.status).sort()).toEqual(["ok", "replay"]);
    expect(first.repo.oauth.isGrantActive(input.grantId, start + 1)).toBe(false);
  });
  test("revoke access is individual, refresh revokes grant, foreign/unknown inputs are inert", async () => {
    const input = await issue();
    const o = first.repo.oauth;
    await w1(() => o.revokeToken(input.tokens.refreshHash, "foreign", start + 1));
    await w1(() => o.revokeToken(h("unknown"), binding.clientId, start + 1));
    await w1(() => o.revokeToken(input.tokens.accessHash, binding.clientId, start + 1));
    expect(o.isGrantActive(input.grantId, start + 1)).toBe(true);
    expect(o.findActiveAccess(input.tokens.accessHash, binding.resource, [], start + 1)).toBeUndefined();
    const next = pair(start + 1);
    expect((await w2(() => second.repo.oauth.rotateRefresh({ ...binding, refreshHash: input.tokens.refreshHash, tokens: next }, start + 1))).status).toBe("ok");
    await w1(() => o.revokeToken(input.tokens.refreshHash, binding.clientId, start + 2));
    await w1(() => o.revokeToken(input.tokens.refreshHash, binding.clientId, start + 2));
    expect((await w2(() => second.repo.oauth.rotateRefresh({ ...binding, refreshHash: next.refreshHash, tokens: pair(start + 2) }, start + 2))).status).toBe("invalid");
  });
  test("revoke and issue serial schedules never resurrect a grant", async () => {
    const input = await issue();
    await w1(() => first.repo.oauth.revokeToken(input.tokens.refreshHash, binding.clientId, start + 1));
    expect((await w2(() => second.repo.oauth.rotateRefresh({ ...binding, refreshHash: input.tokens.refreshHash, tokens: pair(start + 1) }, start + 1))).status).toBe("invalid");
    expect(second.repo.oauth.isGrantActive(input.grantId, start + 1)).toBe(false);
  });
  test("access verifies resource, scopes, user, expiry; disable/reenable cannot resurrect", async () => {
    const input = await issue();
    const o = first.repo.oauth;
    expect(o.findActiveAccess(input.tokens.accessHash, "wrong", [], start)).toBeUndefined();
    expect(o.findActiveAccess(input.tokens.accessHash, binding.resource, ["grayboard:delivery"], start)).toBeUndefined();
    expect(o.findActiveAccess(input.tokens.accessHash, binding.resource, [], input.tokens.accessExpiresAt)).toBeUndefined();
    await w1(() => first.repo.users.setDisabled(userId, true));
    expect(o.findBrowserSession(sessionHash, start)).toBeUndefined();
    expect(o.isGrantActive(input.grantId, start)).toBe(false);
    await w1(() => first.repo.users.setDisabled(userId, false));
    expect(o.isGrantActive(input.grantId, start)).toBe(false);
  });
  test("admin revoke-all includes OAuth; single old-session logout and browser logout do not", async () => {
    const input = await issue();
    const s = await w1(() => first.repo.sessions.create(userId, "old-hash", null));
    await w1(() => first.repo.sessions.revoke(s.id));
    await w1(() => first.repo.oauth.revokeBrowserSession(sessionHash));
    expect(first.repo.oauth.isGrantActive(input.grantId, start)).toBe(true);
    await w1(() => first.repo.sessions.revokeAllForUser(userId));
    expect(first.repo.oauth.isGrantActive(input.grantId, start)).toBe(false);
  });
  test("expiry caps, cleanup and retained spent refresh tombstones", async () => {
    const input = await issue();
    const later = start + OAUTH_TTL.refresh - 1;
    const next = pair(later);
    expect((await w1(() => first.repo.oauth.rotateRefresh({ ...binding, refreshHash: input.tokens.refreshHash, tokens: next }, later))).status).toBe("ok");
    await w1(() => first.repo.oauth.cleanup(start + OAUTH_TTL.refresh + 1));
    expect(first.db.query("SELECT * FROM oauth_tokens WHERE hash = ?").get(input.tokens.refreshHash)).not.toBeNull();
    expect((await w1(() => first.repo.oauth.rotateRefresh({ ...binding, refreshHash: input.tokens.refreshHash, tokens: pair(start + OAUTH_TTL.refresh + 1) }, start + OAUTH_TTL.refresh + 1))).status).toBe("replay");
    await w1(() => first.repo.oauth.cleanup(input.grantExpiresAt));
    expect(first.db.query("SELECT * FROM oauth_tokens").all()).toHaveLength(0);
    expect(first.db.query("SELECT * FROM oauth_grants").all()).toHaveLength(0);
  });
  test("absolute family deadline cannot be extended or crossed by replacements", async () => {
    await issueCode();
    const input = redemption();
    input.grantExpiresAt = start + 100;
    input.tokens = pair(start, input.grantExpiresAt);
    expect((await w1(() => first.repo.oauth.redeemCode(input, start))).status).toBe("ok");
    const result = await w1(() => first.repo.oauth.rotateRefresh({ ...binding, refreshHash: input.tokens.refreshHash, tokens: pair(start + 1) }, start + 1));
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("rotation failed");
    expect(result.value.tokens.accessExpiresAt).toBe(input.grantExpiresAt);
    expect(result.value.tokens.refreshExpiresAt).toBe(input.grantExpiresAt);
    expect(first.repo.oauth.isGrantActive(input.grantId, input.grantExpiresAt)).toBe(false);
  });
  test("state/session/code expiry boundaries and canonical scopes are enforced", async () => {
    expect((await w1(() => first.repo.oauth.createRequest({ ...request, scopes: ["z", "a"] }, start))).status).toBe("invalid");
    expect((await w1(() => first.repo.oauth.createRequest({ ...request, scopes: ["a", "a"] }, start))).status).toBe("invalid");
    expect((await w1(() => first.repo.oauth.createRequest({ ...request, expiresAt: request.expiresAt + 1 }, start))).status).toBe("invalid");
    await w1(() => first.repo.oauth.createRequest(request, start));
    await w1(() => first.repo.oauth.bindRequestSession(request.requestHash, request.browserHash, sessionHash, start));
    expect(first.repo.oauth.findRequest(request.requestHash, request.browserHash, request.expiresAt)).toBeUndefined();
    expect(first.repo.oauth.findBrowserSession(sessionHash, start + OAUTH_TTL.browser)).toBeUndefined();
    expect((await w1(() => first.repo.oauth.decideRequest(decision(), start))).status).toBe("ok");
    expect((await w1(() => first.repo.oauth.redeemCode(redemption(), code.expiresAt))).status).toBe("not_found");
  });
  test("pending request capacity bounded and expired entries reclaimed", async () => {
    for (let i = 0; i < 10; i++) expect((await w1(() => first.repo.oauth.createRequest({ ...request, requestHash: h(`request-${i}`) }, start))).status).toBe("ok");
    expect((await w1(() => first.repo.oauth.createRequest(request, start))).status).toBe("capacity");
    const now = request.expiresAt;
    expect((await w1(() => first.repo.oauth.createRequest({ ...request, createdAt: now, expiresAt: now + 1 }, now))).status).toBe("ok");
  });
  test("persistence whitelists fields and rejects un-hashed capability material", async () => {
    const raw = "must-not-persist-secret";
    expect((await w1(() => first.repo.oauth.createRequest({ ...request, requestHash: raw }, start))).status).toBe("invalid");
    expect((await w1(() => first.repo.oauth.createBrowserSession({ sessionHash: raw, userId, createdAt: start, expiresAt: start + 1 }, start))).status).toBe("invalid");
    await w1(() => first.repo.oauth.createRequest({ ...request, rawState: raw } as OAuthRequest, start));
    expect(JSON.stringify(first.db.query("SELECT * FROM oauth_requests").all())).not.toContain(raw);
    await w1(() => first.repo.oauth.bindRequestSession(request.requestHash, request.browserHash, sessionHash, start));
    await w1(() => first.repo.oauth.decideRequest({ ...decision(), code: { ...code, rawCode: raw } as OAuthCode }, start));
    expect(JSON.stringify(first.db.query("SELECT * FROM oauth_codes").all())).not.toContain(raw);
    const input = redemption();
    expect((await w1(() => first.repo.oauth.redeemCode(input, start))).status).toBe("ok");
    for (const table of ["oauth_requests", "oauth_browsers", "oauth_codes", "oauth_grants", "oauth_tokens"]) {
      expect(JSON.stringify(first.db.query(`SELECT * FROM ${table}`).all())).not.toContain(raw);
    }
  });
  test("reopen preserves grants, hash-only capabilities and refresh lineage", async () => {
    const input = await issue();
    second.db.close();
    second = openDatabase(join(dir, "db.sqlite"), { blobDir: join(dir, "blobs") });
    expect(second.repo.oauth.findActiveAccess(input.tokens.accessHash, binding.resource, binding.scopes, start)?.userId).toBe(userId);
    const serialized = JSON.stringify(first.db.query("SELECT * FROM oauth_tokens").all());
    expect(serialized).toContain(input.tokens.refreshHash);
    expect(serialized).not.toContain(`refresh-${serial}\"`);
    expect((await w2(() => second.repo.oauth.rotateRefresh({ ...binding, refreshHash: input.tokens.refreshHash, tokens: pair(start + 1) }, start + 1))).status).toBe("ok");
  });
  test("independent processes serialize simultaneous code and refresh consumption", async () => {
    await issueCode();
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
    expect((await w1(() => first.repo.oauth.rotateRefresh({ ...binding, refreshHash: codeWinner.tokens.refreshHash, tokens: pair(start + 1) }, start + 1))).status).toBe("invalid");
    request = { ...request, requestHash: h("second-request") };
    code = { ...code, codeHash: h("second-code") };
    await issueCode();
    const fresh = redemption(pair(), "grant_refresh_3333333333");
    const issued = await w1(() => first.repo.oauth.redeemCode(fresh, start));
    if (issued.status !== "ok") throw new Error("fresh grant failed");
    const winner = issued.value;
    const rotations = await race("rotateRefresh", [
      { ...binding, refreshHash: winner.tokens.refreshHash, tokens: pair(start + 1) },
      { ...binding, refreshHash: winner.tokens.refreshHash, tokens: pair(start + 1) },
    ]);
    expect(rotations.map(r => r.status).sort()).toEqual(["ok", "replay"]);
    expect(first.repo.oauth.isGrantActive(winner.grant.id, start + 1)).toBe(false);
  });
  test("consent insert failure rolls back one-use request", async () => {
    await w1(() => first.repo.oauth.createRequest(request, start));
    await w1(() => first.repo.oauth.bindRequestSession(request.requestHash, request.browserHash, sessionHash, start));
    first.db.exec("CREATE TRIGGER fail_code BEFORE INSERT ON oauth_codes BEGIN SELECT RAISE(ABORT, 'injected'); END");
    await expect(w1(() => first.repo.oauth.decideRequest(decision(), start))).rejects.toThrow("injected");
    expect(second.repo.oauth.findRequest(request.requestHash, request.browserHash, start)).toBeDefined();
    first.db.exec("DROP TRIGGER fail_code");
    expect((await w2(() => second.repo.oauth.decideRequest(decision(), start))).status).toBe("ok");
  });
  test("refresh access scopes may narrow independently of stable original refresh permission", async () => {
    const full = ["grayboard:delivery", "grayboard:tools"];
    request = { ...request, scopes: full };
    code = { ...code, scopes: full };
    await issueCode();
    const input = { ...redemption(), scopes: full, tokens: { ...pair(), scopes: full } };
    expect((await w1(() => first.repo.oauth.redeemCode(input, start))).status).toBe("ok");
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
    ]) expect((await w2(() => second.repo.oauth.rotateRefresh(changed, start + 1))).status).toBe("invalid");
    expect(first.db.query("SELECT spent_at FROM oauth_tokens WHERE hash = ?").get(input.tokens.refreshHash)).toEqual({ spent_at: null });
    const result = await w2(() => second.repo.oauth.rotateRefresh(narrow, start + 1));
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("narrow rotation failed");
    expect(result.value.grant.scopes).toEqual(full);
    expect(result.value.tokens.scopes).toEqual(["grayboard:tools"]);
    expect(first.repo.oauth.findActiveAccess(narrow.tokens.accessHash, binding.resource, ["grayboard:delivery"], start + 1)).toBeUndefined();
    expect(first.repo.oauth.findActiveAccess(narrow.tokens.accessHash, binding.resource, ["grayboard:tools"], start + 1)?.scopes).toEqual(["grayboard:tools"]);
    const original = first.repo.oauth.findRefreshGrant(narrow.tokens.refreshHash, binding.clientId, binding.resource, start + 2)!;
    expect(original.scopes).toEqual(full);
    const other = { ...pair(start + 2), scopes: ["grayboard:delivery"] };
    expect((await w2(() => second.repo.oauth.rotateRefresh({ ...binding, scopes: other.scopes, refreshHash: narrow.tokens.refreshHash, tokens: other }, start + 2))).status).toBe("ok");
    expect(first.repo.oauth.findActiveAccess(other.accessHash, binding.resource, ["grayboard:tools"], start + 2)).toBeUndefined();
    // A service resolves an omitted scope from the full original refresh authorization.
    const defaults = first.repo.oauth.findRefreshGrant(other.refreshHash, binding.clientId, binding.resource, start + 3)!;
    const restored = { ...pair(start + 3), scopes: defaults.scopes };
    expect((await w1(() => first.repo.oauth.rotateRefresh({ ...defaults, refreshHash: other.refreshHash, tokens: restored }, start + 3))).status).toBe("ok");
    expect(first.repo.oauth.findActiveAccess(restored.accessHash, binding.resource, full, start + 3)?.scopes).toEqual(full);
    second.db.close();
    second = openDatabase(join(dir, "db.sqlite"), { blobDir: join(dir, "blobs") });
    expect(second.repo.oauth.findActiveAccess(narrow.tokens.accessHash, binding.resource, ["grayboard:delivery"], start + 3)).toBeUndefined();
    expect(second.repo.oauth.findRefreshGrant(restored.refreshHash, binding.clientId, binding.resource, start + 3)?.scopes).toEqual(full);
  });
  test("code replay validates every binding before committing family revocation", async () => {
    const input = await issue();
    for (const changed of [{ clientId: "foreign" }, { resource: "wrong" }, { scopes: ["grayboard:delivery"] },
      { redirectUri: "https://evil.example/cb" }, { codeChallenge: "B".repeat(43) }, { codeHash: h("unknown") }]) {
      expect((await w2(() => second.repo.oauth.redeemCode({ ...input, ...changed }, start + 1))).status).not.toBe("ok");
      expect(first.repo.oauth.isGrantActive(input.grantId, start + 1)).toBe(true);
    }
    expect((await w2(() => second.repo.oauth.redeemCode(input, start + 1))).status).toBe("replay");
    expect(first.repo.oauth.findActiveAccess(input.tokens.accessHash, binding.resource, [], start + 1)).toBeUndefined();
    expect((await w1(() => first.repo.oauth.rotateRefresh({ ...binding, refreshHash: input.tokens.refreshHash, tokens: pair(start + 1) }, start + 1))).status).toBe("invalid");
  });
  test("spent code tombstones survive expiry, reopen, disable/admin revoke and cleanup until family cap", async () => {
    const input = await issue();
    const later = code.expiresAt + 1;
    await w1(() => first.repo.oauth.cleanup(later));
    second.db.close();
    second = openDatabase(join(dir, "db.sqlite"), { blobDir: join(dir, "blobs") });
    expect((await w2(() => second.repo.oauth.redeemCode(input, later))).status).toBe("replay");
    await w1(() => first.repo.sessions.revokeAllForUser(userId));
    await w1(() => first.repo.users.setDisabled(userId, true));
    expect(first.db.query("SELECT grant_id FROM oauth_codes WHERE hash = ?").get(code.codeHash)).toEqual({ grant_id: input.grantId });
    expect((await w2(() => second.repo.oauth.redeemCode(input, input.grantExpiresAt))).status).toBe("not_found");
    await w1(() => first.repo.oauth.cleanup(input.grantExpiresAt));
    expect(first.db.query("SELECT * FROM oauth_codes").all()).toHaveLength(0);
    expect(first.db.query("SELECT * FROM oauth_grants").all()).toHaveLength(0);
  });
  test("pre-correction OAuth tables migrate additively and legacy access retains full grant scopes", async () => {
    const input = await issue();
    second.db.close();
    await seed(first.repo, () => { first.db.exec("DELETE FROM oauth_codes"); });
    first.db.exec("DROP INDEX idx_oauth_codes_grant");
    first.db.exec("ALTER TABLE oauth_codes DROP COLUMN grant_id");
    first.db.exec("ALTER TABLE oauth_tokens DROP COLUMN access_scopes");
    second = openDatabase(join(dir, "db.sqlite"), { blobDir: join(dir, "blobs") });
    expect(second.repo.oauth.findActiveAccess(input.tokens.accessHash, binding.resource, binding.scopes, start)?.scopes).toEqual(binding.scopes);
    expect(second.db.query("SELECT access_scopes FROM oauth_tokens WHERE hash = ?").get(input.tokens.accessHash)).toEqual({ access_scopes: null });
    expect(second.db.query("PRAGMA table_info(oauth_codes)").all().some((c: any) => c.name === "grant_id")).toBe(true);
    expect((await w2(() => second.repo.oauth.rotateRefresh({ ...binding, refreshHash: input.tokens.refreshHash, tokens: pair(start + 1) }, start + 1))).status).toBe("ok");
  });
  test("expired unspent code never mints and is reclaimed", async () => {
    await issueCode();
    expect((await w1(() => first.repo.oauth.redeemCode(redemption(), code.expiresAt))).status).toBe("not_found");
    await w1(() => first.repo.oauth.cleanup(code.expiresAt));
    expect(first.db.query("SELECT * FROM oauth_codes").all()).toHaveLength(0);
    expect(first.db.query("SELECT * FROM oauth_grants").all()).toHaveLength(0);
  });
  test("replay revocation errors propagate and a retry commits for code and refresh", async () => {
    const input = await issue();
    const next = { ...binding, refreshHash: input.tokens.refreshHash, tokens: pair(start + 1) };
    expect((await w1(() => first.repo.oauth.rotateRefresh(next, start + 1))).status).toBe("ok");
    first.db.exec("CREATE TRIGGER fail_replay BEFORE UPDATE ON oauth_grants BEGIN SELECT RAISE(ABORT, 'replay failure'); END");
    await expect(w2(() => second.repo.oauth.redeemCode(input, start + 2))).rejects.toThrow("replay failure");
    await expect(w2(() => second.repo.oauth.rotateRefresh({ ...next, tokens: pair(start + 2) }, start + 2))).rejects.toThrow("replay failure");
    expect(first.repo.oauth.isGrantActive(input.grantId, start + 2)).toBe(true);
    first.db.exec("DROP TRIGGER fail_replay");
    expect((await w2(() => second.repo.oauth.rotateRefresh({ ...next, tokens: pair(start + 2) }, start + 2))).status).toBe("replay");
    expect((await w2(() => second.repo.oauth.redeemCode(input, start + 2))).status).toBe("replay");
    expect(first.repo.oauth.isGrantActive(input.grantId, start + 2)).toBe(false);
    expect((await w2(() => second.repo.oauth.redeemCode(input, start + 2))).status).toBe("replay");
  });
  test("foreign writer contention fails closed in bounded time and retry succeeds after release", async () => {
    const input = await issue();
    expect(first.db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    first.db.exec("PRAGMA busy_timeout = 250");
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
      await expect(w1(() => first.repo.oauth.rotateRefresh({ ...binding, refreshHash: input.tokens.refreshHash, tokens: pair(start + 1) }, start + 1))).rejects.toThrow(/locked|busy/i);
      const elapsed = performance.now() - began;
      expect(elapsed).toBeGreaterThanOrEqual(200);
      expect(elapsed).toBeLessThan(1000);
      expect(first.repo.oauth.isGrantActive(input.grantId, start + 1)).toBe(true);
      expect(await child.exited).toBe(0);
      expect(await new Response(child.stderr).text()).toBe("");
      expect((await w1(() => first.repo.oauth.rotateRefresh({ ...binding, refreshHash: input.tokens.refreshHash, tokens: pair(start + 1) }, start + 1))).status).toBe("ok");
    } finally {
      reader.releaseLock();
      child.kill();
      await child.exited;
    }
  });
  test("storage errors propagate for revocation and admin transactions", async () => {
    const input = await issue();
    first.db.exec("CREATE TRIGGER fail_revoke BEFORE UPDATE ON oauth_grants BEGIN SELECT RAISE(ABORT, 'storage failure'); END");
    await expect(w1(() => first.repo.oauth.revokeToken(input.tokens.refreshHash, binding.clientId, start))).rejects.toThrow("storage failure");
    expect(first.repo.oauth.isGrantActive(input.grantId, start)).toBe(true);
    await expect(w1(() => first.repo.sessions.revokeAllForUser(userId))).rejects.toThrow("storage failure");
    await expect(w1(() => first.repo.users.setDisabled(userId, true))).rejects.toThrow("storage failure");
    expect(first.repo.users.findById(userId)?.disabled_at).toBeNull();
  });
});
