// The auth cache's generation under a write body held open across an await (#996, #807 P1c-2): another task keys
// its cache on committed state, never on the holder's uncommitted bump.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type Repo } from "./db.ts";
import { sqliteOf, type Tx } from "./store/tx.ts";
import { scratchDbPath } from "../../tests/support/scratch_db.ts";
import { createHash } from "node:crypto";
import { OAUTH_TTL, type OAuthAuthorization } from "./oauth-types.ts";

const open = (): Repo => openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) }).repo;
const gate = () => { let open!: () => void; const p = new Promise<void>(r => { open = r; }); return { p, open }; };

// Holds a write body open after `fn`'s writes until the returned release() is called; settles with the body.
function hold(repo: Repo, fn: (tx: Tx) => unknown, fail = false) {
  const g = gate(), wrote = gate();
  const done = repo.write(async tx => {
    await fn(tx);
    wrote.open();
    await g.p;
    if (fail) throw new Error("rolled back");
  });
  return { wrote: wrote.p, release: g.open, done: fail ? done.catch(() => {}) : done };
}

test("another task's generation stays the committed one while a holder's uncommitted write is open", async () => {
  const repo = open();
  const user = await repo.write(tx => repo.users.upsertByEmail(tx, "a@example.com", null));
  const before = repo.authGeneration();
  expect(before).toBeDefined();
  expect(repo.users.activeEmail(user.id)).toBe("a@example.com");
  let inside: string | undefined = "unset";
  const h = hold(repo, async tx => { await repo.users.setDisabled(tx, user.id, true); inside = repo.authGeneration(); });
  await h.wrote;
  expect(inside).toBeUndefined();
  // Outside the holder's transaction: the committed generation, and the committed (enabled) user.
  expect(repo.authGeneration()).toBe(before);
  expect(repo.users.activeEmail(user.id)).toBe("a@example.com");
  expect(await repo.authRead(() => repo.authGeneration())).toBe(before);
  h.release();
  await h.done;
  expect(repo.authGeneration()).not.toBe(before);
  expect(repo.users.activeEmail(user.id)).toBeUndefined();
});

test("a rolled-back holder leaves the generation and the cached user as committed", async () => {
  const repo = open();
  const user = await repo.write(tx => repo.users.upsertByEmail(tx, "b@example.com", null));
  const before = repo.authGeneration();
  const h = hold(repo, tx => repo.users.setDisabled(tx, user.id, true), true);
  await h.wrote;
  expect(repo.users.activeEmail(user.id)).toBe("b@example.com");
  h.release();
  await h.done;
  expect(repo.authGeneration()).toBe(before);
  expect(repo.users.activeEmail(user.id)).toBe("b@example.com");
});

test("a transaction's commit moves the generation too, a synchronous post's too", async () => {
  const repo = open();
  const before = repo.authGeneration();
  await repo.write(tx => repo.users.upsertByEmail(tx, "c@example.com", null));
  const mid = repo.authGeneration();
  expect(mid).not.toBe(before);
  // A synchronous body (users.upsertByEmail answers with a promise, #807 P3 A6b): the user row on its Tx.
  expect(repo.post(tx => { sqliteOf(tx).run("INSERT INTO users (email, created_at) VALUES (?, 0)", ["d@example.com"]); })).toBe(true);
  expect(repo.authGeneration()).not.toBe(mid);
});

test("a failed counter read leaves the generation undefined, never stale, until a commit reads it again", async () => {
  const repo = open();
  await repo.write(tx => repo.users.upsertByEmail(tx, "g@example.com", null));
  // Drops the counter table: the commit's hook can't read it.
  await repo.write(tx => { sqliteOf(tx).run("DROP TABLE temp.auth_generation"); });
  const h = hold(repo, () => {});
  await h.wrote;
  expect(repo.authGeneration()).toBeUndefined();
  expect(await repo.authRead(() => repo.authGeneration())).toBeUndefined();
  h.release();
  await h.done;
  await repo.write(tx => { sqliteOf(tx).run("CREATE TEMP TABLE auth_generation(n INTEGER NOT NULL); INSERT INTO auth_generation(n) VALUES (7)"); });
  const h2 = hold(repo, () => {});
  await h2.wrote;
  expect(repo.authGeneration()).toStartWith("7:");
  h2.release();
  await h2.done;
});

test("an auth-table write that commits without a tracked boundary still moves the generation", async () => {
  const repo = open();
  const user = await repo.write(tx => repo.users.upsertByEmail(tx, "h@example.com", null));
  const before = repo.authGeneration();
  // A holder's committed callback, outside any transaction: a bare autocommit UPDATE (clearSubject's statement).
  await repo.write(() => {}, () => { sqliteOf(repo.read).run("UPDATE users SET idp_issuer = NULL, idp_subject = NULL WHERE id = ?", [user.id]); });
  expect(repo.authGeneration()).not.toBe(before);
});

// An access token for userId, through the store's consent and redemption path; returns its hash.
async function issueAccess(repo: Repo, userId: number, resource: string, start: number): Promise<string> {
  const h = (s: string) => createHash("sha256").update(s).digest("hex");
  const binding: OAuthAuthorization = { clientId: "native", resource, scopes: ["grayboard:tools"], redirectUri: "http://127.0.0.1/callback", codeChallenge: "A".repeat(43) };
  const request = { ...binding, requestHash: h("request"), browserHash: h("browser"), csrfHash: h("csrf"), stateHash: h("state"), consentSessionHash: null, createdAt: start, expiresAt: start + OAUTH_TTL.request };
  const code = { ...binding, userId, codeHash: h("code"), createdAt: start, expiresAt: start + OAUTH_TTL.code };
  const sessionHash = h("browser-session");
  const tokens = { ...binding, accessHash: h("access"), refreshHash: h("refresh"), accessExpiresAt: start + OAUTH_TTL.access, refreshExpiresAt: start + OAUTH_TTL.refresh };
  await repo.write(async tx => {
    expect((await repo.oauth.createBrowserSession(tx, { sessionHash, userId, createdAt: start, expiresAt: start + OAUTH_TTL.browser }, start)).status).toBe("ok");
    expect((await repo.oauth.createRequest(tx, request, start)).status).toBe("ok");
    expect((await repo.oauth.bindRequestSession(tx, request.requestHash, request.browserHash, sessionHash, start)).status).toBe("ok");
    expect((await repo.oauth.decideRequest(tx, { requestHash: request.requestHash, browserHash: request.browserHash, csrfHash: request.csrfHash, sessionHash, approve: true, code }, start)).status).toBe("ok");
    expect((await repo.oauth.redeemCode(tx, { ...binding, codeHash: code.codeHash, grantId: "grant_0123456789abcdef", grantExpiresAt: start + OAUTH_TTL.grant, tokens }, start)).status).toBe("ok");
  });
  return tokens.accessHash;
}

// #807 P3 A7b: authRead's pin is per async task and live only while its body runs. Work the body starts that runs
// after it (a continuation, a timer) reads the generation afresh, so a disable or revoke committed meanwhile is seen,
// not answered from the cache the body filled under its own generation.
test("work an authRead body starts reads afresh once the body is done: a disable after it isn't served from the cache", async () => {
  const { repo } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
  const user = await repo.write(tx => repo.users.upsertByEmail(tx, "p@example.com", null));
  const g0 = repo.authGeneration();
  const later = gate();
  // Boxed: authRead's body is synchronous until A7c; the continuation it starts runs after it, with its store.
  const after = (await repo.authRead(() => {
    expect(repo.users.activeEmail(user.id)).toBe("p@example.com"); // fills the user cache at g0
    return { seen: later.p.then(() => ({ g: repo.authGeneration(), email: repo.users.activeEmail(user.id) })) };
  })).seen;
  await repo.write(tx => repo.users.setDisabled(tx, user.id, true));
  later.open();
  const seen = await after;
  expect(seen.g).not.toBe(g0);
  expect(seen.email).toBeUndefined();
});

test("work an authRead body starts reads afresh once the body is done: a revoked token isn't served from the cache", async () => {
  const { repo } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
  const user = await repo.write(tx => repo.users.upsertByEmail(tx, "p@example.com", null));
  // A disable revokes the user's grants and tokens too; the access cache must miss after it.
  const t = repo.now();
  const later = gate();
  const resource = "https://bus.example.com/mcp";
  const issued = await issueAccess(repo, user.id, resource, t);
  const after = (await repo.authRead(() => {
    expect(repo.oauth.findActiveAccess(repo.read, issued, resource, [], t)).toBeDefined(); // fills the access cache
    return { seen: later.p.then(() => repo.oauth.findActiveAccess(repo.read, issued, resource, [], t)) };
  })).seen;
  await repo.write(tx => repo.users.setDisabled(tx, user.id, true));
  later.open();
  expect(await after).toBeUndefined();
});
