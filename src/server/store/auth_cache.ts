// The auth cache (#853, #881, #807 P3 C9a; docs/future/postgres-server.md D5): a live access token by hash and a user
// row by id, keyed on a generation that every committed write to oauth_tokens, oauth_grants or users moves. Written
// once over a per-backend generation source: SQLite's is db.ts's trigger counter joined with data_version; Postgres's
// is an in-process counter its write path and a LISTEN bump (C9b). It reads through the uncached store reads it's
// given, so it imports no backend: no module here reaches db.ts or bun:sqlite.
import { AsyncLocalStorage } from "node:async_hooks";
import { testPauseAsync } from "../../shared/testpause.ts";
import type { OAuthAccess, OAuthStore } from "../oauth-types.ts";
import type { User, UsersStore } from "./identity.ts";
import type { Read } from "./tx_base.ts";

// Repo.authPeek's answer: the auth cache's live-token and user hits under one generation (#807 P3 A7d, A7u2).
// `user`: the user cache's entry under that generation (#807 P3 A7u2): the row, null when known absent, undefined on a
// miss.
export type AuthPeek = {
  generation: string;
  access(tokenHash: string, resource: string, now: number): OAuthAccess | undefined;
  user(userId: number): User | null | undefined;
};

// Where the generation comes from, per backend.
export interface AuthGenerationSource {
  // The generation now, or undefined when no cache may be keyed on it. Equal values mean no committed write to the
  // three tables this process has learnt of came between them. May throw (SQLite's counter read): every caller here
  // catches or propagates it as the code it replaced did.
  read(): string | undefined;
  // The caller's task holds the store's open transaction: its reads see uncommitted writes, so the cache is bypassed.
  ownsTx(): boolean;
  // Repo.commitGeneration: equal values mean no auth commit at all between them; undefined where a commit can lag
  // (Postgres: an outside writer's notice in flight) and inside the caller's own transaction.
  commit(): string | undefined;
}

// The uncached reads the caches sit over, on the caller's handle.
export type AuthReads = {
  findActiveAccess: OAuthStore["findActiveAccess"];
  userById(r: Read, userId: number): Promise<User | undefined>;
  // Resolves the handle (SQLite: sqliteOf), so a kept Tx is refused on a cache hit too.
  check(r: Read): void;
};

// Repo's auth members (db.ts documents each) and the cached reads Repo puts in its oauth and users groups.
export type AuthCache = {
  authRead<T>(fn: () => T | Promise<T>): Promise<T>;
  authPeek(): AuthPeek | undefined;
  authGeneration(): string | undefined;
  commitGeneration(): string | undefined;
  findActiveAccess: OAuthStore["findActiveAccess"];
  isDisabled: UsersStore["isDisabled"];
  active: UsersStore["active"];
};

export function makeAuthCache(source: AuthGenerationSource, reads: AuthReads): AuthCache {
  // `pin`: the generation authRead read for its body (#881), per async task rather than per module (#807 P3 A7b), so
  // bodies that overlap once they await each keep their own. Work a body starts (a timer, a queued write, a
  // continuation) inherits the store, but the pin is live only until the body settles: after that the work reads the
  // generation afresh, so a cache filled under the body's generation can't answer it once a commit (a revoke, a
  // disable) has moved the generation on.
  const pin = new AsyncLocalStorage<{ g: string; live: boolean }>();
  const pinned = () => { const p = pin.getStore(); return p?.live ? p.g : undefined; };
  const authGeneration = () => source.ownsTx() ? undefined : pinned() ?? source.read();
  // Caches of what the auth tables say, keyed on authGeneration: a live access token only (an unknown or dead one is
  // re-read every time); a user row, or its absence, as read (#853). Repo's findActiveAccess, isDisabled and active
  // are these wrappers, so a test that replaces one of those methods replaces the cache behind it, except authPeek's:
  // it reads the access and user caches directly, so a stubbed findActiveAccess, isDisabled or active changes only
  // what a miss later fills.
  // A lookup hits only when its generation is the cache's. A miss reads, then fills only if the generation is still
  // its own once the read is done (#807 P3 A7b): a lookup pinned before a commit neither fills nor clears the cache a
  // newer one keyed, so bodies with different pins don't thrash it, and generations need no order.
  // A failed generation read fills nothing (the lookup's answer stands, uncached).
  const fills = (g: string, cacheGen: string | undefined, clear: () => void): string | undefined => {
    let now: string | undefined;
    try { now = source.read(); } catch (error) { console.error("[grayboard] auth generation read failed:", error); return cacheGen; }
    if (now !== g) return cacheGen;
    if (g !== cacheGen) clear();
    return g;
  };
  let userGeneration: string | undefined;
  const users = new Map<number, User | null>();
  const heldUser = (g: string, userId: number) => g === userGeneration ? users.get(userId) : undefined;
  // The read may await (#807 P3 A7u2; pause auth:user:read): a commit meanwhile (a disable) moves the generation, so
  // the fill check stores nothing and the next lookup reads again. The answer stands, linearized before that commit.
  // Inside the caller's own transaction (generation undefined) it reads on the caller's Tx, uncached. The handle is
  // resolved first, so a kept Tx is refused on a hit too.
  const cachedUser = async (r: Read, userId: number): Promise<User | undefined> => {
    reads.check(r);
    const g = authGeneration();
    if (g === undefined) return reads.userById(r, userId);
    const hit = heldUser(g, userId);
    if (hit !== undefined) return hit ?? undefined;
    const u = (await reads.userById(r, userId)) ?? null;
    await testPauseAsync("auth:user:read");
    const kept = fills(g, userGeneration, () => users.clear());
    if (kept === g) { userGeneration = g; users.set(userId, u); }
    return u ?? undefined;
  };
  // A live access token by hash: held while the generation is unchanged and both the token and its grant
  // are unexpired, the join's own time conditions; required scopes are checked against the held scopes.
  let accessGeneration: string | undefined;
  const accesses = new Map<string, OAuthAccess>();
  // Inside a transaction (authGeneration undefined) it reads on the caller's handle, uncached. The handle is
  // resolved first, so a kept Tx is refused on a cache hit too.
  // The read may await (#807 P3 A7c): a commit that lands meanwhile moves the generation, and the fill check then
  // stores nothing, so a token revoked mid-read is never cached as live.
  const scoped = (a: OAuthAccess | undefined, requiredScopes: string[]) => a && requiredScopes.every(s => a.scopes.includes(s)) ? a : undefined;
  const fillAccess = (g: string, key: string, a: OAuthAccess | undefined) => {
    const kept = fills(g, accessGeneration, () => accesses.clear());
    if (kept === g) { accessGeneration = g; if (a) accesses.set(key, a); else accesses.delete(key); }
  };
  const heldAccess = (g: string, key: string, now: number) => {
    const a = g === accessGeneration ? accesses.get(key) : undefined;
    return a && now < a.expiresAt && now < a.grantExpiresAt ? a : undefined;
  };
  const findActiveAccess: OAuthStore["findActiveAccess"] = async (r, h, resource, requiredScopes, now) => {
    reads.check(r);
    const g = authGeneration();
    if (g === undefined || !Array.isArray(requiredScopes)) return reads.findActiveAccess(r, h, resource, requiredScopes, now);
    const key = `${resource}\n${h}`;
    let a = heldAccess(g, key, now);
    if (!a) {
      a = await reads.findActiveAccess(r, h, resource, [], now);
      await testPauseAsync("auth:access:read");
      fillAccess(g, key, a);
    }
    return scoped(a, requiredScopes);
  };
  return {
    async authRead<T>(fn: () => T | Promise<T>): Promise<T> {
      if (pinned() !== undefined || source.ownsTx()) return fn();
      const g = source.read();
      if (g === undefined) return fn();
      const p = { g, live: true };
      try { return await pin.run(p, fn); } finally { p.live = false; }
    },
    authPeek() {
      let g: string | undefined;
      try { g = authGeneration(); } catch (error) { console.error("[grayboard] auth generation read failed:", error); return undefined; }
      if (g === undefined) return undefined;
      const generation = g;
      return { generation, access: (h, resource, now) => heldAccess(generation, `${resource}\n${h}`, now), user: (userId) => heldUser(generation, userId) };
    },
    authGeneration,
    commitGeneration: () => source.commit(),
    findActiveAccess,
    async isDisabled(r, userId) {
      return (await cachedUser(r, userId))?.disabled_at != null;
    },
    async active(r, userId) {
      const u = await cachedUser(r, userId);
      return u && u.disabled_at === null ? { email: u.email, kind: u.kind } : undefined;
    },
  };
}
