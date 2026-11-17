// The auth cache's generation under a write body held open across an await (#996, #807 P1c-2): another task keys
// its cache on committed state, never on the holder's uncommitted bump.
import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type Repo } from "./db.ts";
import { sqliteOf, type Tx } from "./store/tx.ts";
import { scratchDbPath } from "../../tests/support/scratch_db.ts";
import { createHash } from "node:crypto";
import { OAUTH_TTL, type OAuthAuthorization } from "./oauth-types.ts";
import { hostedPause } from "../../tests/support/hosted-pause.ts";

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
  expect((await repo.users.activeEmail(repo.read, user.id))).toBe("a@example.com");
  let inside: string | undefined = "unset";
  const h = hold(repo, async tx => { await repo.users.setDisabled(tx, user.id, true); inside = repo.authGeneration(); });
  await h.wrote;
  expect(inside).toBeUndefined();
  // Outside the holder's transaction: the committed generation, and the committed (enabled) user.
  expect(repo.authGeneration()).toBe(before);
  expect((await repo.users.activeEmail(repo.read, user.id))).toBe("a@example.com");
  expect(await repo.authRead(() => repo.authGeneration())).toBe(before);
  h.release();
  await h.done;
  expect(repo.authGeneration()).not.toBe(before);
  expect((await repo.users.activeEmail(repo.read, user.id))).toBeUndefined();
});

test("a rolled-back holder leaves the generation and the cached user as committed", async () => {
  const repo = open();
  const user = await repo.write(tx => repo.users.upsertByEmail(tx, "b@example.com", null));
  const before = repo.authGeneration();
  const h = hold(repo, tx => repo.users.setDisabled(tx, user.id, true), true);
  await h.wrote;
  expect((await repo.users.activeEmail(repo.read, user.id))).toBe("b@example.com");
  h.release();
  await h.done;
  expect(repo.authGeneration()).toBe(before);
  expect((await repo.users.activeEmail(repo.read, user.id))).toBe("b@example.com");
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
  // Boxed, so authRead settles without waiting for it: the continuation the body starts runs after it, with its store.
  const after = (await repo.authRead(async () => {
    expect(await repo.users.activeEmail(repo.read, user.id)).toBe("p@example.com"); // fills the user cache at g0
    return { seen: later.p.then(async () => { const g = repo.authGeneration(); return { g, email: await repo.users.activeEmail(repo.read, user.id) }; }) };
  })).seen;
  await repo.write(tx => repo.users.setDisabled(tx, user.id, true));
  later.open();
  const seen = await after;
  expect(seen.g).not.toBe(g0);
  expect(seen.email).toBeUndefined();
});

test("work an authRead body starts reads afresh once the body is done: a disabled user's token isn't served from the cache", async () => {
  const { repo } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
  const user = await repo.write(tx => repo.users.upsertByEmail(tx, "p@example.com", null));
  // A disable revokes the user's grants and tokens too; the access cache must miss after it.
  const t = repo.now();
  const later = gate();
  const resource = "https://bus.example.com/mcp";
  const issued = await issueAccess(repo, user.id, resource, t);
  const after = (await repo.authRead(async () => {
    expect(await repo.oauth.findActiveAccess(repo.read, issued, resource, [], t)).toBeDefined(); // fills the access cache
    return { seen: later.p.then(() => repo.oauth.findActiveAccess(repo.read, issued, resource, [], t)) };
  })).seen;
  await repo.write(tx => repo.users.setDisabled(tx, user.id, true));
  later.open();
  expect(await after).toBeUndefined();
});

// The access table reads under findActiveAccess's cache, counted.
function accessReads() {
  const query = spyOn(Database.prototype, "query");
  return { count: () => query.mock.calls.filter(([sql]) => String(sql).includes("AS grant_expiry")).length, restore: () => query.mockRestore() };
}

// #807 P3 A7c: the async lookup's read can await, so a commit may land between the read and the fill. The fill is
// keyed on the generation the lookup started under, which that commit moved: a token disabled mid-read is never
// cached as live, and the next check reads it afresh and refuses.
for (const end of ["disable", "revoke"] as const) test(`a ${end} committed while an access read is held is never cached: the next check refuses`, async () => {
  const repo = open();
  const user = await repo.write(tx => repo.users.upsertByEmail(tx, "r@example.com", null));
  const t = repo.now();
  const resource = "https://bus.example.com/mcp";
  const issued = await issueAccess(repo, user.id, resource, t);
  const g0 = repo.authGeneration();
  const held = await hostedPause("auth:access:read",
    () => repo.authRead(() => repo.oauth.findActiveAccess(repo.read, issued, resource, [], t)),
    () => repo.write(tx => end === "disable" ? repo.users.setDisabled(tx, user.id, true) : repo.oauth.revokeToken(tx, issued, "native", t)));
  // The read ran before the end committed; its answer stands, linearized before it.
  expect(held).toBeDefined();
  expect(repo.authGeneration()).not.toBe(g0);
  const reads = accessReads();
  try {
    expect(await repo.oauth.findActiveAccess(repo.read, issued, resource, [], t)).toBeUndefined();
    expect(reads.count()).toBe(1);
  } finally { reads.restore(); }
});

// #807 P3 A7c: bodies pinned to different generations overlap across awaits. An older body's lookup bypasses the
// cache a newer one keyed: it neither clears nor fills it, so the newer body's next lookup still hits.
test("an older authRead body's lookup leaves a newer body's cache alone while both are open", async () => {
  const repo = open();
  const user = await repo.write(tx => repo.users.upsertByEmail(tx, "s@example.com", null));
  const t = repo.now();
  const resource = "https://bus.example.com/mcp", other = "https://other.example.com/mcp";
  const issued = await issueAccess(repo, user.id, resource, t);
  const older = gate(), newer = gate();
  const g0 = repo.authGeneration();
  const first = repo.authRead(async () => {
    await older.p;
    expect(repo.authGeneration()).toBe(g0);
    await repo.oauth.findActiveAccess(repo.read, issued, other, [], t); // a miss under g0, after g1 keyed the cache
    newer.open();
  });
  // Any auth-table commit moves the generation.
  await repo.write(tx => repo.users.upsertByEmail(tx, "t@example.com", null));
  const reads = accessReads();
  try {
    await repo.authRead(async () => {
      expect(repo.authGeneration()).not.toBe(g0);
      expect(await repo.oauth.findActiveAccess(repo.read, issued, resource, [], t)).toBeDefined(); // fills at g1
      older.open();
      await newer.p;
      expect(await repo.oauth.findActiveAccess(repo.read, issued, resource, [], t)).toBeDefined();
    });
    await first;
    // The newer body's fill, the older body's miss; the newer body's second lookup hit.
    expect(reads.count()).toBe(2);
  } finally { reads.restore(); }
});

// The users-by-id reads under the user cache, counted.
function userReads() {
  const query = spyOn(Database.prototype, "query");
  return { count: () => query.mock.calls.filter(([sql]) => String(sql) === "SELECT * FROM users WHERE id = ?").length, restore: () => query.mockRestore() };
}

// #807 P3 A7u2: the user cache's read awaits too. A disable committed while a lookup is held moves the generation,
// so the fill stores nothing: the held answer stands, linearized before the disable, and the next lookup reads again.
test("a disable committed while a user read is held is never cached: the next lookup reads and refuses", async () => {
  const repo = open();
  const user = await repo.write(tx => repo.users.upsertByEmail(tx, "u@example.com", null));
  const g0 = repo.authGeneration();
  const held = await hostedPause("auth:user:read", () => repo.users.activeEmail(repo.read, user.id),
    () => repo.write(tx => repo.users.setDisabled(tx, user.id, true)));
  expect(held).toBe("u@example.com");
  expect(repo.authGeneration()).not.toBe(g0);
  const reads = userReads();
  try {
    expect(await repo.users.activeEmail(repo.read, user.id)).toBeUndefined();
    expect(reads.count()).toBe(1);
    // That read filled the cache under the new generation: the next lookup hits.
    expect(await repo.users.isDisabled(repo.read, user.id)).toBe(true);
    expect(reads.count()).toBe(1);
  } finally { reads.restore(); }
});

// #807 P3 A7u2: authPeek answers a user from the cache alone, for the stream timer's synchronous phase A. A token
// hit with a user miss is a miss (phase B reads), and nothing is read.
test("authPeek's user answers cache hits only and reads nothing", async () => {
  const repo = open();
  const user = await repo.write(tx => repo.users.upsertByEmail(tx, "v@example.com", null));
  const t = repo.now(), resource = "https://bus.example.com/mcp";
  const issued = await issueAccess(repo, user.id, resource, t);
  expect(await repo.oauth.findActiveAccess(repo.read, issued, resource, [], t)).toBeDefined(); // the access cache only
  const reads = userReads();
  try {
    const peek = repo.authPeek()!;
    expect(peek.access(issued, resource, t)).toBeDefined();
    expect(peek.user(user.id)).toBeUndefined();
    expect(peek.user(user.id + 1)).toBeUndefined();
    expect(reads.count()).toBe(0);
  } finally { reads.restore(); }
  expect(await repo.users.activeEmail(repo.read, user.id + 1)).toBeUndefined(); // caches the absence
  await repo.write(tx => repo.users.setDisabled(tx, user.id, true));
  expect(await repo.users.isDisabled(repo.read, user.id)).toBe(true); // caches the disabled row under the new generation
  const peek = repo.authPeek()!;
  expect(peek.user(user.id)?.disabled_at).not.toBeNull();
  expect(peek.user(user.id + 1)).toBeUndefined(); // the absence was cached under the old generation
});
