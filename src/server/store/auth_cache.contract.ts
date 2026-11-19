// The auth cache's contract (#807 P3 C9a, docs/future/postgres-server.md D5 and D9): store/auth_cache.ts over a
// backend's generation source, written once over a harness so both stores run the same rows. Not a *.test.ts file, so
// Bun doesn't discover it: a backend's test file registers it under a describe() (auth_cache.contract.sqlite.ts through
// db.test.ts for SQLite; C9b's runner for Postgres).
//
// Portability rules the rows follow:
// - Each row opens a fresh store. The cache's members are the Repo's: `auth.findActiveAccess`, `auth.isDisabled` and
//   `auth.active` are what Repo puts in its oauth and users groups.
// - A held read goes through the cache's own pause points (auth:user:read, auth:access:read), which live in
//   auth_cache.ts and so hold on every backend.
// - The generation may move after a write resolves as well as before: on Postgres the pod's own NOTIFY arrives a moment
//   after its write-path bump and bumps again (scope §2.2). So every row calls `settle()` after each of its own auth
//   writes and before each baseline (a generation it compares with later) or read-count window; only a row asserting
//   what a write did before it resolved (A3) reads the generation before settling.
// - An outside write is another connection's (SQLite: a second Database on the file; Postgres: the test database's raw
//   client). `seen()` waits until this store has learnt of it (see the harness).
// - Reads are counted by the harness, by backend: the user-by-id and live-token reads under the caches.
// Rows that only SQLite can express (a failed counter read, an autocommit write, a synchronous post) stay in
// src/server/auth-generation.test.ts.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { hostedPause } from "../../../tests/support/hosted-pause.ts";
import { OAUTH_TTL, type OAuthAuthorization, type OAuthStore } from "../oauth-types.ts";
import type { AuthCache } from "./auth_cache.ts";
import type { UsersStore } from "./identity.ts";
import type { Read, Tx } from "./tx_base.ts";

// One store, fresh per row.
export type AuthCacheHarness = {
  auth: AuthCache;
  oauth: OAuthStore;
  users: Pick<UsersStore, "upsertByEmail" | "setDisabled">;
  write<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  read: Read;
  now(): number;
  // A committed write to a table the generation doesn't cover.
  touchOther(tx: Tx): Promise<void>;
  // Sets the user's disabled_at from another connection, committed when it resolves.
  outsideDisable(userId: number): Promise<void>;
  // Resolves once every notification this store's generation source will get for writes committed before the call
  // has arrived, so the generation stays put until the next write. SQLite: a no-op (its generation moves with the
  // commit, data_version included). Postgres: NOTIFY a unique marker on the listener's channel and wait until the
  // listener receives it, with a deadline; a listener receives notifications in commit order, so every earlier one
  // (this pod's own included) has arrived by then.
  settle(): Promise<void>;
  // Resolves once this store has learnt of the last outsideDisable. SQLite: at once (data_version moves with the
  // commit). Postgres: the outside client NOTIFYs a unique marker after its commit, and seen() waits, with a deadline,
  // until the listener receives that marker, so the disable's own notification, and every one before it, has arrived.
  seen(): Promise<void>;
  // Counts the uncached reads under the caches from now until restore().
  reads(): { users(): number; accesses(): number; restore(): void };
  close(): void | Promise<void>;
};

// `commitGeneration`: "exact" where Repo.commitGeneration is the committed generation outside the caller's own
// transaction (SQLite), "none" where it is always undefined because a commit can lag (Postgres: scope §5).
export type AuthCacheBackend = { kind: "sqlite" | "postgres"; commitGeneration: "exact" | "none"; open(): Promise<AuthCacheHarness> };

const RESOURCE = "https://bus.example.com/mcp", OTHER = "https://other.example.com/mcp";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
// A body's deliberate rollback; any other error (a failed expect inside the body) propagates.
const ROLLBACK = new Error("rolled back");
const rolledBack = (error: unknown) => { if (error !== ROLLBACK) throw error; };
const gate = () => { let open!: () => void; const p = new Promise<void>(r => { open = r; }); return { p, open }; };

export function authCacheContract(backend: AuthCacheBackend): void {
  const it = (name: string, fn: (h: AuthCacheHarness) => Promise<void>) => test(name, async () => {
    const h = await backend.open();
    try { await h.settle(); await fn(h); } finally { await h.close(); }
  });
  // The raw writes (A3 reads the generation before settling) and their settled forms, which every other row uses.
  const seedRaw = (h: AuthCacheHarness, email: string) => h.write(async tx => (await h.users.upsertByEmail(tx, email, null)).id);
  const disableRaw = (h: AuthCacheHarness, userId: number) => h.write(tx => h.users.setDisabled(tx, userId, true));
  const seedUser = async (h: AuthCacheHarness, email: string) => { const id = await seedRaw(h, email); await h.settle(); return id; };
  const disable = async (h: AuthCacheHarness, userId: number) => { await disableRaw(h, userId); await h.settle(); };
  const email = (h: AuthCacheHarness, r: Read, userId: number) => h.auth.active(r, userId).then(u => u?.email);
  // Holds a write body open after `fn`'s writes until the returned release() is called; settles with the body.
  const hold = (h: AuthCacheHarness, fn: (tx: Tx) => unknown, fail = false) => {
    const g = gate(), wrote = gate();
    const done = h.write(async tx => {
      await fn(tx);
      wrote.open();
      await g.p;
      if (fail) throw new Error("rolled back");
    });
    return { wrote: wrote.p, release: g.open, done: fail ? done.catch(() => {}) : done };
  };
  // An access token for userId, through the store's consent and redemption path, settled unless `settle` is false;
  // returns its hash.
  let serial = 0;
  const issueAccess = async (h: AuthCacheHarness, userId: number, settle = true): Promise<string> => {
    const resource = RESOURCE;
    const start = h.now(), n = ++serial;
    const binding: OAuthAuthorization = { clientId: "native", resource, scopes: ["grayboard:tools"], redirectUri: "http://127.0.0.1/callback", codeChallenge: "A".repeat(43) };
    const request = { ...binding, requestHash: sha(`request${n}`), browserHash: sha(`browser${n}`), csrfHash: sha(`csrf${n}`), stateHash: sha(`state${n}`), consentSessionHash: null, createdAt: start, expiresAt: start + OAUTH_TTL.request };
    const code = { ...binding, userId, codeHash: sha(`code${n}`), createdAt: start, expiresAt: start + OAUTH_TTL.code };
    const sessionHash = sha(`browser-session${n}`);
    const tokens = { ...binding, accessHash: sha(`access${n}`), refreshHash: sha(`refresh${n}`), accessExpiresAt: start + OAUTH_TTL.access, refreshExpiresAt: start + OAUTH_TTL.refresh };
    await h.write(async tx => {
      expect((await h.oauth.createBrowserSession(tx, { sessionHash, userId, createdAt: start, expiresAt: start + OAUTH_TTL.browser }, start)).status).toBe("ok");
      expect((await h.oauth.createRequest(tx, request, start)).status).toBe("ok");
      expect((await h.oauth.bindRequestSession(tx, request.requestHash, request.browserHash, sessionHash, start)).status).toBe("ok");
      expect((await h.oauth.decideRequest(tx, { requestHash: request.requestHash, browserHash: request.browserHash, csrfHash: request.csrfHash, sessionHash, approve: true, code }, start)).status).toBe("ok");
      expect((await h.oauth.redeemCode(tx, { ...binding, codeHash: code.codeHash, grantId: `grant_${n.toString(16).padStart(16, "0")}`, grantExpiresAt: start + OAUTH_TTL.grant, tokens }, start)).status).toBe("ok");
    });
    if (settle) await h.settle();
    return tokens.accessHash;
  };

  // A1 (#996, #807 P1c-2).
  it("A1: another task's generation stays the committed one while a holder's uncommitted auth write is open", async h => {
    const user = await seedUser(h, "a@example.com");
    const before = h.auth.authGeneration();
    expect(before).toBeDefined();
    expect(await email(h, h.read, user)).toBe("a@example.com");
    let inside: string | undefined = "unset";
    const held = hold(h, async tx => { await h.users.setDisabled(tx, user, true); inside = h.auth.authGeneration(); });
    await held.wrote;
    expect(inside).toBeUndefined();
    // Outside the holder's transaction: the committed generation, and the committed (enabled) user.
    expect(h.auth.authGeneration()).toBe(before);
    expect(await email(h, h.read, user)).toBe("a@example.com");
    expect(await h.auth.authRead(() => h.auth.authGeneration())).toBe(before);
    held.release();
    await held.done;
    expect(h.auth.authGeneration()).not.toBe(before);
    expect(await email(h, h.read, user)).toBeUndefined();
  });

  // A2.
  it("A2: a rolled-back holder leaves the generation and the cached user as committed", async h => {
    const user = await seedUser(h, "b@example.com");
    const before = h.auth.authGeneration();
    const held = hold(h, tx => h.users.setDisabled(tx, user, true), true);
    await held.wrote;
    expect(await email(h, h.read, user)).toBe("b@example.com");
    held.release();
    await held.done;
    expect(h.auth.authGeneration()).toBe(before);
    expect(await email(h, h.read, user)).toBe("b@example.com");
  });

  it("A2: a savepoint rolled back inside a committed body leaves the generation and the cached user", async h => {
    const user = await seedUser(h, "b2@example.com");
    const before = h.auth.authGeneration(), commitBefore = h.auth.commitGeneration();
    expect(await email(h, h.read, user)).toBe("b2@example.com");
    await h.write(async tx => {
      await tx.savepoint(async t => { await h.users.setDisabled(t, user, true); throw ROLLBACK; }).catch(rolledBack);
      await h.touchOther(tx);
    });
    expect(h.auth.authGeneration()).toBe(before);
    expect(h.auth.commitGeneration()).toBe(commitBefore);
    const reads = h.reads();
    try {
      expect(await email(h, h.read, user)).toBe("b2@example.com");
      expect(reads.users()).toBe(0);
    } finally { reads.restore(); }
  });

  // A3.
  // Unsettled on purpose: each generation is read as write() resolves, before any notification could move it. Later
  // bumps only move it further, so the not-equal checks hold either way.
  it("A3: a commit that writes an auth table moves the generation before write() resolves, for each table", async h => {
    const exact = backend.commitGeneration === "exact";
    const g0 = h.auth.authGeneration(), c0 = h.auth.commitGeneration();
    if (exact) expect(c0).toBeDefined(); else expect(c0).toBeUndefined();
    const user = await seedRaw(h, "c@example.com"); // users
    const g1 = h.auth.authGeneration(), c1 = h.auth.commitGeneration();
    expect(g1).not.toBe(g0);
    if (exact) expect(c1).not.toBe(c0); else expect(c1).toBeUndefined();
    const issued = await issueAccess(h, user, false); // oauth_grants and oauth_tokens
    const g2 = h.auth.authGeneration();
    expect(g2).not.toBe(g1);
    await h.write(tx => h.oauth.revokeToken(tx, issued, "native", h.now()).then(() => {})); // oauth_tokens
    expect(h.auth.authGeneration()).not.toBe(g2);
    expect(h.auth.commitGeneration()).toBe(exact ? h.auth.authGeneration() : undefined);
  });

  it("A3: an auth commit moves the generation before the write queue's next body starts", async h => {
    const g0 = h.auth.authGeneration();
    const user = await seedUser(h, "c2@example.com");
    const before = h.auth.authGeneration();
    const disabled = disableRaw(h, user);
    // Queued behind the disable: while it holds the queue, other tasks read the committed generation, which is
    // none seen before the disable committed.
    const held = hold(h, () => {});
    await held.wrote;
    try {
      const during = h.auth.authGeneration();
      expect(during).toBeDefined();
      expect([g0, before]).not.toContain(during);
      expect(await h.auth.isDisabled(h.read, user)).toBe(true);
    } finally { held.release(); }
    await held.done;
    await disabled;
  });

  // A4.
  it("A4: a commit that writes no auth table leaves the generation and the caches", async h => {
    const user = await seedUser(h, "d@example.com");
    const issued = await issueAccess(h, user);
    const t = h.now();
    expect(await email(h, h.read, user)).toBe("d@example.com");
    expect(await h.auth.findActiveAccess(h.read, issued, RESOURCE, [], t)).toBeDefined();
    const before = h.auth.authGeneration(), commitBefore = h.auth.commitGeneration();
    await h.write(tx => h.touchOther(tx));
    expect(h.auth.authGeneration()).toBe(before);
    expect(h.auth.commitGeneration()).toBe(commitBefore);
    const reads = h.reads();
    try {
      expect(await email(h, h.read, user)).toBe("d@example.com");
      expect(await h.auth.findActiveAccess(h.read, issued, RESOURCE, [], t)).toBeDefined();
      expect(reads.users()).toBe(0);
      expect(reads.accesses()).toBe(0);
    } finally { reads.restore(); }
  });

  // A5 (#807 P3 A7b): authRead's pin is per async task and live only while its body runs. Work the body starts that
  // runs after it (a continuation, a timer) reads the generation afresh, so a disable or revoke committed meanwhile is
  // seen, not answered from the cache the body filled under its own generation.
  it("A5: work an authRead body starts reads afresh once the body is done: a disable after it isn't served from the cache", async h => {
    const user = await seedUser(h, "p@example.com");
    const g0 = h.auth.authGeneration();
    const later = gate();
    // Boxed, so authRead settles without waiting for it: the continuation the body starts runs after it, with its store.
    const after = (await h.auth.authRead(async () => {
      expect(await email(h, h.read, user)).toBe("p@example.com"); // fills the user cache at g0
      return { seen: later.p.then(async () => ({ g: h.auth.authGeneration(), email: await email(h, h.read, user) })) };
    })).seen;
    await disable(h, user);
    later.open();
    const seen = await after;
    expect(seen.g).not.toBe(g0);
    expect(seen.email).toBeUndefined();
  });

  it("A5: work an authRead body starts reads afresh once the body is done: a disabled user's token isn't served from the cache", async h => {
    const user = await seedUser(h, "p2@example.com");
    // A disable revokes the user's grants and tokens too; the access cache must miss after it.
    const t = h.now();
    const later = gate();
    const issued = await issueAccess(h, user);
    const after = (await h.auth.authRead(async () => {
      expect(await h.auth.findActiveAccess(h.read, issued, RESOURCE, [], t)).toBeDefined(); // fills the access cache
      return { seen: later.p.then(() => h.auth.findActiveAccess(h.read, issued, RESOURCE, [], t)) };
    })).seen;
    await disable(h, user);
    later.open();
    expect(await after).toBeUndefined();
  });

  it("A5: a body that rejects ends its pin too: a continuation it started reads afresh after a later disable", async h => {
    const user = await seedUser(h, "p3@example.com");
    const g0 = h.auth.authGeneration();
    const later = gate();
    let after!: Promise<{ g: string | undefined; email: string | undefined }>;
    await h.auth.authRead(async () => {
      expect(await email(h, h.read, user)).toBe("p3@example.com"); // fills the user cache at g0
      after = later.p.then(async () => ({ g: h.auth.authGeneration(), email: await email(h, h.read, user) }));
      throw ROLLBACK;
    }).catch(rolledBack);
    await disable(h, user);
    later.open();
    const seen = await after;
    expect(seen.g).not.toBe(g0);
    expect(seen.email).toBeUndefined();
  });

  it("A5: an authRead inside another keeps the outer body's pin across a commit; the outer pin ends with the outer body", async h => {
    const user = await seedUser(h, "p4@example.com");
    const g0 = h.auth.authGeneration();
    await h.auth.authRead(async () => {
      expect(await email(h, h.read, user)).toBe("p4@example.com"); // fills the user cache at g0
      await disable(h, user);
      // Nested: still the outer body's generation and its answer (#881's bound: one authorization), not a new pin.
      const inner = await h.auth.authRead(async () => ({ g: h.auth.authGeneration(), email: await email(h, h.read, user) }));
      expect(inner).toEqual({ g: g0, email: "p4@example.com" });
      expect(h.auth.authGeneration()).toBe(g0);
    });
    expect(h.auth.authGeneration()).not.toBe(g0);
    expect(await email(h, h.read, user)).toBeUndefined();
  });

  // A6 (#807 P3 A7c): bodies pinned to different generations overlap across awaits. An older body's lookup bypasses
  // the cache a newer one keyed: it neither clears nor fills it, so the newer body's next lookup still hits.
  it("A6: an older authRead body's lookup leaves a newer body's cache alone while both are open", async h => {
    const user = await seedUser(h, "s@example.com");
    const t = h.now();
    const issued = await issueAccess(h, user);
    const older = gate(), newer = gate();
    const g0 = h.auth.authGeneration();
    const first = h.auth.authRead(async () => {
      await older.p;
      expect(h.auth.authGeneration()).toBe(g0);
      await h.auth.findActiveAccess(h.read, issued, OTHER, [], t); // a miss under g0, after g1 keyed the cache
      newer.open();
    });
    // Any auth-table commit moves the generation.
    await seedUser(h, "t@example.com");
    const reads = h.reads();
    try {
      await h.auth.authRead(async () => {
        expect(h.auth.authGeneration()).not.toBe(g0);
        expect(await h.auth.findActiveAccess(h.read, issued, RESOURCE, [], t)).toBeDefined(); // fills at g1
        older.open();
        await newer.p;
        expect(await h.auth.findActiveAccess(h.read, issued, RESOURCE, [], t)).toBeDefined();
      });
      await first;
      // The newer body's fill, the older body's miss; the newer body's second lookup hit.
      expect(reads.accesses()).toBe(2);
    } finally { reads.restore(); }
  });

  it("A6: an older authRead body's user lookup leaves a newer body's user cache alone while both are open", async h => {
    const user = await seedUser(h, "s2@example.com"), other = await seedUser(h, "s3@example.com");
    const older = gate(), newer = gate();
    const g0 = h.auth.authGeneration();
    const first = h.auth.authRead(async () => {
      await older.p;
      expect(h.auth.authGeneration()).toBe(g0);
      expect(await email(h, h.read, other)).toBe("s3@example.com"); // a miss under g0, after g1 keyed the cache
      newer.open();
    });
    await seedUser(h, "t2@example.com");
    const reads = h.reads();
    try {
      await h.auth.authRead(async () => {
        expect(h.auth.authGeneration()).not.toBe(g0);
        expect(await email(h, h.read, user)).toBe("s2@example.com"); // fills at g1
        older.open();
        await newer.p;
        expect(await email(h, h.read, user)).toBe("s2@example.com");
      });
      await first;
      // The newer body's fill, the older body's miss; the newer body's second lookup hit.
      expect(reads.users()).toBe(2);
    } finally { reads.restore(); }
  });

  // A7 (#807 P3 A7c, A7u2; scope R3): a lookup's read can await, so a commit may land between the read and the fill.
  // The fill is keyed on the generation the lookup started under, which that commit moved: the held answer stands,
  // linearized before it, but is never cached, and the next lookup reads afresh and refuses.
  for (const end of ["disable", "revoke"] as const) it(`A7: a ${end} committed while an access read is held is never cached: the next check refuses`, async h => {
    const user = await seedUser(h, "r@example.com");
    const t = h.now();
    const issued = await issueAccess(h, user);
    const g0 = h.auth.authGeneration();
    const held = await hostedPause("auth:access:read",
      () => h.auth.authRead(() => h.auth.findActiveAccess(h.read, issued, RESOURCE, [], t)),
      () => h.write(tx => end === "disable" ? h.users.setDisabled(tx, user, true) : h.oauth.revokeToken(tx, issued, "native", t).then(() => {})));
    expect(held).toBeDefined();
    expect(h.auth.authGeneration()).not.toBe(g0);
    await h.settle();
    const reads = h.reads();
    try {
      expect(await h.auth.findActiveAccess(h.read, issued, RESOURCE, [], t)).toBeUndefined();
      expect(reads.accesses()).toBe(1);
    } finally { reads.restore(); }
  });

  for (const writer of ["own", "outside"] as const) it(`A7: an ${writer} disable committed while a user read is held is never cached: the next lookup reads and refuses`, async h => {
    const user = await seedUser(h, "u@example.com");
    const g0 = h.auth.authGeneration();
    const held = await hostedPause("auth:user:read", () => email(h, h.read, user),
      async () => { if (writer === "own") await disable(h, user); else { await h.outsideDisable(user); await h.seen(); } });
    expect(held).toBe("u@example.com");
    expect(h.auth.authGeneration()).not.toBe(g0);
    const reads = h.reads();
    try {
      expect(await email(h, h.read, user)).toBeUndefined();
      expect(reads.users()).toBe(1);
      // That read filled the cache under the new generation: the next lookup hits.
      expect(await h.auth.isDisabled(h.read, user)).toBe(true);
      expect(reads.users()).toBe(1);
    } finally { reads.restore(); }
  });

  it("A7: an outside disable moves the generation: a cached user isn't served once seen", async h => {
    const user = await seedUser(h, "w@example.com");
    expect(await h.auth.isDisabled(h.read, user)).toBe(false);
    const g0 = h.auth.authGeneration();
    await h.outsideDisable(user);
    await h.seen();
    expect(h.auth.authGeneration()).not.toBe(g0);
    expect(h.auth.authPeek()?.user(user)).toBeUndefined();
    expect(await h.auth.isDisabled(h.read, user)).toBe(true);
  });

  // A8 (#807 P3 A7u2): authPeek answers from the caches alone, for the stream timer's synchronous phase A. A token hit
  // with a user miss is a miss (phase B reads), and nothing is read.
  it("A8: authPeek answers cache hits only and reads nothing", async h => {
    const user = await seedUser(h, "v@example.com");
    const t = h.now();
    const issued = await issueAccess(h, user);
    expect(await h.auth.findActiveAccess(h.read, issued, RESOURCE, [], t)).toBeDefined(); // the access cache only
    const reads = h.reads();
    try {
      const peek = h.auth.authPeek()!;
      expect(peek.generation).toBe(h.auth.authGeneration()!);
      expect(peek.access(issued, RESOURCE, t)).toBeDefined();
      expect(peek.access(issued, OTHER, t)).toBeUndefined();
      expect(peek.user(user)).toBeUndefined();
      expect(peek.user(user + 1)).toBeUndefined();
      expect(reads.users()).toBe(0);
      expect(reads.accesses()).toBe(0);
    } finally { reads.restore(); }
    expect(await email(h, h.read, user + 1)).toBeUndefined(); // caches the absence
    expect(h.auth.authPeek()!.user(user + 1)).toBeNull();
    await disable(h, user);
    expect(await h.auth.isDisabled(h.read, user)).toBe(true); // caches the disabled row under the new generation
    const peek = h.auth.authPeek()!;
    expect(peek.user(user)?.disabled_at).not.toBeNull();
    expect(peek.user(user + 1)).toBeUndefined(); // the absence was cached under the old generation
    expect(peek.access(issued, RESOURCE, t)).toBeUndefined(); // the token too
  });

  // A9: inside the caller's own transaction its reads see its uncommitted writes, so the caches are bypassed: no
  // generation, no peek, and each lookup reads on its Tx without filling.
  it("A9: inside the caller's own transaction the cached reads read its Tx, uncached, and fill nothing", async h => {
    const user = await seedUser(h, "x@example.com");
    const t = h.now();
    const issued = await issueAccess(h, user);
    expect(await h.auth.isDisabled(h.read, user)).toBe(false); // cached enabled
    expect(await h.auth.findActiveAccess(h.read, issued, RESOURCE, [], t)).toBeDefined(); // cached live
    const reads = h.reads();
    try {
      await h.write(async tx => {
        expect(h.auth.authGeneration()).toBeUndefined();
        expect(h.auth.commitGeneration()).toBeUndefined();
        expect(h.auth.authPeek()).toBeUndefined();
        expect(await h.auth.authRead(() => h.auth.authGeneration())).toBeUndefined();
        await h.users.setDisabled(tx, user, true);
        expect(await h.auth.isDisabled(tx, user)).toBe(true);
        expect(await h.auth.active(tx, user)).toBeUndefined();
        expect(await h.auth.findActiveAccess(tx, issued, RESOURCE, [], t)).toBeUndefined();
        expect(reads.users()).toBe(2);
        expect(reads.accesses()).toBe(1);
        throw ROLLBACK;
      }).catch(rolledBack);
      // Rolled back: the committed rows, still from the cache.
      expect(await h.auth.isDisabled(h.read, user)).toBe(false);
      expect(await h.auth.findActiveAccess(h.read, issued, RESOURCE, [], t)).toBeDefined();
      expect(reads.users()).toBe(2);
      expect(reads.accesses()).toBe(1);
    } finally { reads.restore(); }
  });

  // A10: a hit is still checked against the lookup's time and scopes. The entry is filled with no required scopes, so
  // the held token must be refused once `now` reaches its expiry and for a scope it lacks, by findActiveAccess and by
  // authPeek alike. (A grant expiring before its token can't be seeded: redemption caps the token at the grant's
  // deadline and rotation clamps it, so the grant-expiry check is pinned only where the two coincide.)
  it("A10: a cached token isn't served past its expiry or for a scope it lacks", async h => {
    const user = await seedUser(h, "y@example.com");
    const t = h.now();
    const issued = await issueAccess(h, user);
    const live = await h.auth.findActiveAccess(h.read, issued, RESOURCE, [], t); // fills with no required scopes
    expect(live).toBeDefined();
    const expiry = live!.expiresAt;
    const reads = h.reads();
    try {
      expect(await h.auth.findActiveAccess(h.read, issued, RESOURCE, ["grayboard:tools"], t)).toBeDefined();
      expect(await h.auth.findActiveAccess(h.read, issued, RESOURCE, ["grayboard:delivery"], t)).toBeUndefined();
      expect(await h.auth.findActiveAccess(h.read, issued, RESOURCE, ["grayboard:tools", "grayboard:delivery"], t)).toBeUndefined();
      expect(reads.accesses()).toBe(0); // all three from the cache
      const peek = h.auth.authPeek()!;
      expect(peek.access(issued, RESOURCE, expiry - 1)).toBeDefined();
      expect(peek.access(issued, RESOURCE, expiry)).toBeUndefined();
      expect(await h.auth.findActiveAccess(h.read, issued, RESOURCE, [], expiry)).toBeUndefined();
      expect(h.auth.authPeek()!.access(issued, RESOURCE, expiry - 1)).toBeUndefined(); // the expired read dropped the entry
    } finally { reads.restore(); }
  });
}
