import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db.ts";
import type { Tx } from "./store/tx.ts";
import { seed } from "../../tests/support/seed.ts";
import { transactionProcess } from "../../tests/support/transaction-process.ts";
import { OAUTH_TTL, type OAuthAuthorization, type OAuthCode, type OAuthRequest, type OAuthTokenPair } from "./oauth-types.ts";
import { oauthContract } from "./store/oauth.contract.ts";
import { sqliteOAuthBackend } from "./store/oauth.contract.sqlite.ts";

// Every OAuthStore method's serial answers, shared with the Postgres store (#807 P3 C4). The tests below this are
// SQLite's own: two connections or processes on one file, triggers that force an interleaving or a storage error,
// and the additive migration.
describe("OAuth contract (SQLite)", () => oauthContract(sqliteOAuthBackend));

const h = (s: string) => createHash("sha256").update(s).digest("hex");
const start = 1_800_000_000_000;
const binding: OAuthAuthorization = { clientId: "native", resource: "https://example.com/mcp", scopes: ["grayboard:tools"], redirectUri: "http://127.0.0.1/callback", codeChallenge: "A".repeat(43) };
let serial = 0;
const pair = (now = start, cap = now + OAUTH_TTL.grant): OAuthTokenPair => ({ ...binding,
  accessHash: h(`access-${++serial}`), refreshHash: h(`refresh-${serial}`),
  accessExpiresAt: Math.min(now + OAUTH_TTL.access, cap), refreshExpiresAt: Math.min(now + OAUTH_TTL.refresh, cap) });

describe("OAuth domain store (SQLite only)", () => {
  let dir: string;
  let first: ReturnType<typeof openDatabase>;
  let second: ReturnType<typeof openDatabase>;
  let userId: number;
  let request: OAuthRequest;
  let code: OAuthCode;
  const sessionHash = h("browser-session");
  // The store's writes run in each connection's write queue, as a request's do.
  // A body may return the store's promise (#807 P3 A6c).
  const w1 = <T>(fn: (tx: Tx) => T) => seed(first.repo, async tx => fn(tx));
  const w2 = <T>(fn: (tx: Tx) => T) => seed(second.repo, async tx => fn(tx));
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "grayboard-oauth-"));
    const opts = { blobDir: join(dir, "blobs") };
    first = openDatabase(join(dir, "db.sqlite"), opts);
    second = openDatabase(join(dir, "db.sqlite"), opts);
    await w1(async tx => {
      userId = (await first.repo.users.upsertByEmail(tx, "you@example.com", null)).id;
      expect((await first.repo.oauth.createBrowserSession(tx, { sessionHash, userId, createdAt: start, expiresAt: start + OAUTH_TTL.browser }, start)).status).toBe("ok");
    });
    request = { ...binding, requestHash: h("request"), browserHash: h("browser"), csrfHash: h("csrf"), stateHash: h("state"), consentSessionHash: null, createdAt: start, expiresAt: start + OAUTH_TTL.request };
    code = { ...binding, userId, codeHash: h("code"), createdAt: start, expiresAt: start + OAUTH_TTL.code };
  });
  afterEach(() => { second.db.close(); first.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const decision = () => ({ requestHash: request.requestHash, browserHash: request.browserHash, csrfHash: request.csrfHash, sessionHash, approve: true, code });
  function issueCode() {
    return w1(async tx => {
      expect((await first.repo.oauth.createRequest(tx, request, start)).status).toBe("ok");
      expect((await first.repo.oauth.bindRequestSession(tx, request.requestHash, request.browserHash, sessionHash, start)).status).toBe("ok");
      expect((await first.repo.oauth.decideRequest(tx, decision(), start)).status).toBe("ok");
    });
  }
  function redemption(tokens = pair(), grantId = "grant_0123456789abcdef") {
    return { ...binding, codeHash: code.codeHash, grantId, grantExpiresAt: start + OAUTH_TTL.grant, tokens };
  }
  async function issue() {
    await issueCode();
    const input = redemption();
    expect((await w1(tx => first.repo.oauth.redeemCode(tx, input, start))).status).toBe("ok");
    return input;
  }
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
      expect(await first.repo.oauth.isGrantActive(first.repo.read, input.grantId, start + 1)).toBe(true);
      await Bun.write(release, "release");
      await Promise.all(workers.map(async w => { expect(await w.proc.exited).toBe(0); await w.done; }));
      expect(workers.map(w => JSON.parse(w.output().trim().split("\n").at(-1)!).status).sort()).toEqual(["ok", "replay"]);
      expect(await first.repo.oauth.isGrantActive(first.repo.read, input.grantId, start + 1)).toBe(false);
      for (const replacement of replacements) expect(await first.repo.oauth.findActiveAccess(first.repo.read, replacement.accessHash, binding.resource, binding.scopes, start + 1)).toBeUndefined();
    } finally {
      await Bun.write(release, "release");
      for (const w of workers) { w.proc.kill(); await w.proc.exited; }
    }
  }, 15_000);
  test("failed insertion rolls back code consumption and half-grant", async () => {
    await issueCode();
    const input = redemption();
    first.db.exec("CREATE TRIGGER fail_oauth_token BEFORE INSERT ON oauth_tokens WHEN NEW.kind = 'refresh' BEGIN SELECT RAISE(ABORT, 'injected'); END");
    await expect(w1(tx => first.repo.oauth.redeemCode(tx, input, start))).rejects.toThrow("injected");
    expect(first.db.query("SELECT * FROM oauth_grants").all()).toHaveLength(0);
    expect(first.db.query("SELECT * FROM oauth_tokens").all()).toHaveLength(0);
    first.db.exec("DROP TRIGGER fail_oauth_token");
    expect((await w2(tx => second.repo.oauth.redeemCode(tx, input, start))).status).toBe("ok");
  });
  test("refresh failure rollback leaves current refresh live and no successor", async () => {
    const input = await issue();
    const next = { ...binding, refreshHash: input.tokens.refreshHash, tokens: pair(start + 1) };
    first.db.exec("CREATE TRIGGER fail_refresh BEFORE INSERT ON oauth_tokens WHEN NEW.kind = 'refresh' BEGIN SELECT RAISE(ABORT, 'injected'); END");
    await expect(w1(tx => first.repo.oauth.rotateRefresh(tx, next, start + 1))).rejects.toThrow("injected");
    expect(first.db.query("SELECT * FROM oauth_tokens").all()).toHaveLength(2);
    first.db.exec("DROP TRIGGER fail_refresh");
    expect((await w2(tx => second.repo.oauth.rotateRefresh(tx, next, start + 1))).status).toBe("ok");
  });
  test("reopen preserves grants, hash-only capabilities, narrowed access scopes, spent-code tombstones and refresh lineage", async () => {
    // A grant for both scopes, so a rotation can narrow its access token.
    const full = ["grayboard:delivery", "grayboard:tools"];
    request = { ...request, scopes: full };
    code = { ...code, scopes: full };
    await issueCode();
    const input = { ...redemption({ ...pair(), scopes: full }), scopes: full };
    expect((await w1(tx => first.repo.oauth.redeemCode(tx, input, start))).status).toBe("ok");
    const later = code.expiresAt + 1;
    await w1(tx => first.repo.oauth.cleanup(tx, later));
    const reopen = () => {
      second.db.close();
      second = openDatabase(join(dir, "db.sqlite"), { blobDir: join(dir, "blobs") });
    };
    reopen();
    expect((await second.repo.oauth.findActiveAccess(second.repo.read, input.tokens.accessHash, binding.resource, full, start))?.userId).toBe(userId);
    expect(await second.repo.oauth.findCodeScopes(second.repo.read, code.codeHash, binding.clientId, binding.resource, binding.redirectUri, later)).toEqual(full);
    const serialized = JSON.stringify(first.db.query("SELECT * FROM oauth_tokens").all());
    expect(serialized).toContain(input.tokens.refreshHash);
    expect(serialized).not.toContain(`refresh-${serial}\"`);
    const narrow = { ...binding, refreshHash: input.tokens.refreshHash, tokens: pair(start + 1) };
    expect((await w2(tx => second.repo.oauth.rotateRefresh(tx, narrow, start + 1))).status).toBe("ok");
    // The narrowed access scopes and the stable refresh permission are what a fresh connection reads.
    reopen();
    expect(await second.repo.oauth.findActiveAccess(second.repo.read, narrow.tokens.accessHash, binding.resource, ["grayboard:delivery"], start + 1)).toBeUndefined();
    expect((await second.repo.oauth.findActiveAccess(second.repo.read, narrow.tokens.accessHash, binding.resource, ["grayboard:tools"], start + 1))?.scopes).toEqual(["grayboard:tools"]);
    expect((await second.repo.oauth.findRefreshGrant(second.repo.read, narrow.tokens.refreshHash, binding.clientId, binding.resource, start + 1))?.scopes).toEqual(full);
    // The spent code's tombstone still replays after the reopen, past the code's expiry and a cleanup.
    expect((await w2(tx => second.repo.oauth.redeemCode(tx, { ...input, grantId: "grant_replay_0123456789", tokens: { ...pair(later), scopes: full } }, later))).status).toBe("replay");
    expect(await first.repo.oauth.isGrantActive(first.repo.read, input.grantId, later)).toBe(false);
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
        const result=await repo.write(tx => repo.oauth[process.argv[4]](tx, JSON.parse(process.argv[5]), ${start + 1}));
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
    expect(await first.repo.oauth.isGrantActive(first.repo.read, codeWinner.grant.id, start + 1)).toBe(false);
    expect(await first.repo.oauth.findActiveAccess(first.repo.read, codeWinner.tokens.accessHash, binding.resource, [], start + 1)).toBeUndefined();
    expect((await w1(tx => first.repo.oauth.rotateRefresh(tx, { ...binding, refreshHash: codeWinner.tokens.refreshHash, tokens: pair(start + 1) }, start + 1))).status).toBe("invalid");
    request = { ...request, requestHash: h("second-request") };
    code = { ...code, codeHash: h("second-code") };
    await issueCode();
    const fresh = redemption(pair(), "grant_refresh_3333333333");
    const issued = await w1(tx => first.repo.oauth.redeemCode(tx, fresh, start));
    if (issued.status !== "ok") throw new Error("fresh grant failed");
    const winner = issued.value;
    const rotations = await race("rotateRefresh", [
      { ...binding, refreshHash: winner.tokens.refreshHash, tokens: pair(start + 1) },
      { ...binding, refreshHash: winner.tokens.refreshHash, tokens: pair(start + 1) },
    ]);
    expect(rotations.map(r => r.status).sort()).toEqual(["ok", "replay"]);
    expect(await first.repo.oauth.isGrantActive(first.repo.read, winner.grant.id, start + 1)).toBe(false);
  });
  test("consent insert failure rolls back one-use request", async () => {
    await w1(tx => first.repo.oauth.createRequest(tx, request, start));
    await w1(tx => first.repo.oauth.bindRequestSession(tx, request.requestHash, request.browserHash, sessionHash, start));
    first.db.exec("CREATE TRIGGER fail_code BEFORE INSERT ON oauth_codes BEGIN SELECT RAISE(ABORT, 'injected'); END");
    await expect(w1(tx => first.repo.oauth.decideRequest(tx, decision(), start))).rejects.toThrow("injected");
    expect((await second.repo.oauth.findRequest(second.repo.read, request.requestHash, request.browserHash, start))).toBeDefined();
    first.db.exec("DROP TRIGGER fail_code");
    expect((await w2(tx => second.repo.oauth.decideRequest(tx, decision(), start))).status).toBe("ok");
  });
  test("pre-correction OAuth tables migrate additively and legacy access retains full grant scopes", async () => {
    const input = await issue();
    second.db.close();
    await seed(first.repo, () => { first.db.exec("DELETE FROM oauth_codes"); });
    first.db.exec("DROP INDEX idx_oauth_codes_grant");
    first.db.exec("ALTER TABLE oauth_codes DROP COLUMN grant_id");
    first.db.exec("ALTER TABLE oauth_tokens DROP COLUMN access_scopes");
    second = openDatabase(join(dir, "db.sqlite"), { blobDir: join(dir, "blobs") });
    expect((await second.repo.oauth.findActiveAccess(second.repo.read, input.tokens.accessHash, binding.resource, binding.scopes, start))?.scopes).toEqual(binding.scopes);
    expect(second.db.query("SELECT access_scopes FROM oauth_tokens WHERE hash = ?").get(input.tokens.accessHash)).toEqual({ access_scopes: null });
    expect(second.db.query("PRAGMA table_info(oauth_codes)").all().some((c: any) => c.name === "grant_id")).toBe(true);
    expect((await w2(tx => second.repo.oauth.rotateRefresh(tx, { ...binding, refreshHash: input.tokens.refreshHash, tokens: pair(start + 1) }, start + 1))).status).toBe("ok");
  });
  test("replay revocation errors propagate and a retry commits for code and refresh", async () => {
    const input = await issue();
    const next = { ...binding, refreshHash: input.tokens.refreshHash, tokens: pair(start + 1) };
    expect((await w1(tx => first.repo.oauth.rotateRefresh(tx, next, start + 1))).status).toBe("ok");
    first.db.exec("CREATE TRIGGER fail_replay BEFORE UPDATE ON oauth_grants BEGIN SELECT RAISE(ABORT, 'replay failure'); END");
    await expect(w2(tx => second.repo.oauth.redeemCode(tx, input, start + 2))).rejects.toThrow("replay failure");
    await expect(w2(tx => second.repo.oauth.rotateRefresh(tx, { ...next, tokens: pair(start + 2) }, start + 2))).rejects.toThrow("replay failure");
    expect(await first.repo.oauth.isGrantActive(first.repo.read, input.grantId, start + 2)).toBe(true);
    first.db.exec("DROP TRIGGER fail_replay");
    expect((await w2(tx => second.repo.oauth.rotateRefresh(tx, { ...next, tokens: pair(start + 2) }, start + 2))).status).toBe("replay");
    expect((await w2(tx => second.repo.oauth.redeemCode(tx, input, start + 2))).status).toBe("replay");
    expect(await first.repo.oauth.isGrantActive(first.repo.read, input.grantId, start + 2)).toBe(false);
    expect((await w2(tx => second.repo.oauth.redeemCode(tx, input, start + 2))).status).toBe("replay");
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
      await expect(w1(tx => first.repo.oauth.rotateRefresh(tx, { ...binding, refreshHash: input.tokens.refreshHash, tokens: pair(start + 1) }, start + 1))).rejects.toThrow(/locked|busy/i);
      const elapsed = performance.now() - began;
      expect(elapsed).toBeGreaterThanOrEqual(200);
      expect(elapsed).toBeLessThan(1000);
      expect(await first.repo.oauth.isGrantActive(first.repo.read, input.grantId, start + 1)).toBe(true);
      expect(await child.exited).toBe(0);
      expect(await new Response(child.stderr).text()).toBe("");
      expect((await w1(tx => first.repo.oauth.rotateRefresh(tx, { ...binding, refreshHash: input.tokens.refreshHash, tokens: pair(start + 1) }, start + 1))).status).toBe("ok");
    } finally {
      reader.releaseLock();
      child.kill();
      await child.exited;
    }
  });
  test("storage errors propagate for revocation and admin transactions", async () => {
    const input = await issue();
    first.db.exec("CREATE TRIGGER fail_revoke BEFORE UPDATE ON oauth_grants BEGIN SELECT RAISE(ABORT, 'storage failure'); END");
    await expect(w1(tx => first.repo.oauth.revokeToken(tx, input.tokens.refreshHash, binding.clientId, start))).rejects.toThrow("storage failure");
    expect(await first.repo.oauth.isGrantActive(first.repo.read, input.grantId, start)).toBe(true);
    await expect(seed(first.repo, tx => first.repo.sessions.revokeAllForUser(tx, userId))).rejects.toThrow("storage failure");
    await expect(w1(tx => first.repo.users.setDisabled(tx, userId, true))).rejects.toThrow("storage failure");
    expect((await first.repo.users.findById(first.repo.read, userId))?.disabled_at).toBeNull();
  });
  // #807 P2-1 (D3): each single-use spend is one conditional statement. SQLite's single writer can't interleave two
  // redeemers, so a trigger lands the other redeemer's spend between this one's read and its spend; the Postgres
  // interleaving tests come with P3. Reverting a spend to an unconditional UPDATE makes each of these answer "ok".
  const auditCount = (action: string) => first.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM access_log WHERE action = ?").get(action)!.n;
  test("a code spent after its read answers as a replay, withdraws its grant and revokes the winner's", async () => {
    const winner = await issue();
    code = { ...code, codeHash: h("code-2") };
    await issueCode();
    first.db.exec(`CREATE TRIGGER steal AFTER INSERT ON oauth_grants BEGIN
      UPDATE oauth_codes SET grant_id = '${winner.grantId}' WHERE hash = '${code.codeHash}'; END`);
    const loser = redemption(pair(), "grant_loser_0123456789");
    expect(await w1(tx => first.repo.oauth.redeemCode(tx, loser, start))).toEqual({ status: "replay" });
    first.db.exec("DROP TRIGGER steal");
    expect(first.db.query("SELECT id FROM oauth_grants").all()).toEqual([{ id: winner.grantId }]);
    expect(await first.repo.oauth.isGrantActive(first.repo.read, winner.grantId, start)).toBe(false);
    expect(auditCount("oauth.code_replay_revoked")).toBe(1);
    expect(auditCount("oauth.grant_issued")).toBe(1);
  });
  test("a code deleted after its read answers not_found and leaves no grant", async () => {
    await issueCode();
    first.db.exec(`CREATE TRIGGER gone AFTER INSERT ON oauth_grants BEGIN DELETE FROM oauth_codes WHERE hash = '${code.codeHash}'; END`);
    expect(await w1(tx => first.repo.oauth.redeemCode(tx, redemption(), start))).toEqual({ status: "not_found" });
    first.db.exec("DROP TRIGGER gone");
    expect(first.db.query("SELECT id FROM oauth_grants").all()).toHaveLength(0);
  });
  test("a login code spent after its read answers as a replay, withdraws its session and revokes the winner's", async () => {
    const login = { ...binding, scopes: ["grayboard:login"] };
    request = { ...request, ...login };
    code = { ...code, ...login };
    await issueCode();
    const won = await seed(first.repo, tx => first.repo.sessions.create(tx, userId, h("winner-token"), null));
    first.db.exec(`CREATE TRIGGER steal AFTER INSERT ON sessions WHEN NEW.id <> ${won.id} BEGIN
      UPDATE oauth_codes SET session_id = ${won.id} WHERE hash = '${code.codeHash}'; END`);
    const input = { ...login, codeHash: code.codeHash, tokenHash: h("loser-token"), label: null };
    expect(await w1(tx => first.repo.oauth.redeemLoginCode(tx, input, start))).toEqual({ status: "replay" });
    first.db.exec("DROP TRIGGER steal");
    expect(first.db.query("SELECT id FROM sessions WHERE token_hash = ?").all(input.tokenHash)).toHaveLength(0);
    expect(first.db.query<{ revoked_at: number | null }, [number]>("SELECT revoked_at FROM sessions WHERE id = ?").get(won.id)!.revoked_at).toBe(start);
    expect(auditCount("oauth.code_replay_revoked")).toBe(1);
    expect(auditCount("oauth.session_issued")).toBe(0);
  });
  test("a refresh token spent after its read answers as a replay; one revoked or expired after it answers invalid", async () => {
    const input = await issue();
    const presented = input.tokens.refreshHash;
    const rotate = (tokens: OAuthTokenPair) => w1(tx => first.repo.oauth.rotateRefresh(tx, { ...binding, refreshHash: presented, tokens }, start + 1));
    const absent = (p: OAuthTokenPair) => expect(first.db.query("SELECT hash FROM oauth_tokens WHERE hash IN (?, ?)").all(p.accessHash, p.refreshHash)).toHaveLength(0);
    first.db.exec(`CREATE TRIGGER revoke_presented AFTER INSERT ON oauth_tokens WHEN NEW.kind = 'refresh' BEGIN
      UPDATE oauth_tokens SET revoked_at = ${start} WHERE hash = '${presented}'; END`);
    const revoked = pair(start + 1);
    expect(await rotate(revoked)).toEqual({ status: "invalid" });
    first.db.exec("DROP TRIGGER revoke_presented");
    absent(revoked);
    expect(await first.repo.oauth.isGrantActive(first.repo.read, input.grantId, start + 1)).toBe(true);
    await w1(() => { first.db.run("UPDATE oauth_tokens SET revoked_at = NULL WHERE hash = ?", [presented]); });
    first.db.exec(`CREATE TRIGGER expire_presented AFTER INSERT ON oauth_tokens WHEN NEW.kind = 'refresh' BEGIN
      UPDATE oauth_tokens SET expires_at = ${start} WHERE hash = '${presented}'; END`);
    const expired = pair(start + 1);
    expect(await rotate(expired)).toEqual({ status: "invalid" });
    first.db.exec("DROP TRIGGER expire_presented");
    absent(expired);
    await w1(() => { first.db.run("UPDATE oauth_tokens SET expires_at = ? WHERE hash = ?", [start + OAUTH_TTL.refresh, presented]); });
    first.db.exec(`CREATE TRIGGER steal AFTER INSERT ON oauth_tokens WHEN NEW.kind = 'refresh' BEGIN
      UPDATE oauth_tokens SET spent_at = ${start} WHERE hash = '${presented}'; END`);
    const loser = pair(start + 1);
    expect(await rotate(loser)).toEqual({ status: "replay" });
    first.db.exec("DROP TRIGGER steal");
    absent(loser);
    expect(await first.repo.oauth.isGrantActive(first.repo.read, input.grantId, start + 1)).toBe(false);
    expect(auditCount("oauth.refresh_replay_revoked")).toBe(1);
    expect(auditCount("oauth.refreshed")).toBe(0);
  });
});
