// The claims store's group interface (#807 P3 C10b, docs/future/postgres-server.md D2): claims, their watches and
// their event log, which Repo (db.ts) composes and the Postgres store (pg/claims.ts) implements. The row types are
// core's (src/core/claims.ts), whose SQL the SQLite store runs. Type-only imports, so a module under pg/ may import it
// (pg/isolation.test.ts); db.ts re-exports the interface.
import type { Claim, ClaimEvent, ClaimEventRow, ClaimRow, TakeRow } from "../../core/claims.ts";
import type { Read, Tx } from "./tx_base.ts";

export type { Claim, ClaimEvent, ClaimEventRow, ClaimRow, TakeRow };

// Claims' reads and writes (#807 P3 B2, B5b3), on the caller's handle. The sweep and the claim tools are the server's
// (src/server/claims.ts); every rule they apply is core's. Every write that ends a claim (release, expire, ackQueue,
// takeWatchers) is one conditional DELETE … RETURNING: what it returns is what it deleted, so two racing enders
// can't both act on one row (D3).
export interface ClaimsStore {
  // Live claims, by key in byte order; with prefix, only keys that start with it, ASCII letters matched in either case
  // (SQLite's LIKE; Postgres ILIKE), `%`, `_` and `\` literally. Rows carry no holder_user.
  list(r: Read, prefix?: string): Promise<Claim[]>;
  // The earliest expiry of a claim with a board (the expiry timer's next fire), or null.
  nextExpiry(r: Read): Promise<number | null>;
  // The key's row, live or lapsed (core claimRow); the caller judges whether it's live.
  get(r: Read, key: string): Promise<ClaimRow | undefined>;
  // Take or renew (core takeClaim): overwrites only a lapsed row or `t.as`'s own (D3); null when another's live
  // claim was there, which the caller answers as held.
  take(tx: Tx, t: TakeRow): Promise<Claim | null>;
  // Ends `holder`'s live claim on `key` (core releaseClaim): the deleted row, or null when a racing write ended it.
  release(tx: Tx, key: string, holder: string, now: number): Promise<ClaimRow | null>;
  // The key's latest two events, newest first (core recentClaimEvents), for releasedByRule.
  recentEvents(r: Read, key: string): Promise<ClaimEventRow[]>;
  // The claim's watchers, by handle (core claimWatchers): an [update]'s cc.
  watchers(r: Read, key: string): Promise<string[]>;
  // The key's live claim, for a watch (core liveClaim). Postgres reads it FOR SHARE (W1), so a release racing the
  // watch waits for it rather than leaving an orphan watch; hence a Tx.
  liveForWatch(tx: Tx, key: string, now: number): Promise<Claim | undefined>;
  // Watch a claim, idempotently (core addClaimWatch); stop watching it (core removeClaimWatch).
  addWatch(tx: Tx, key: string, handle: string): Promise<void>;
  unwatch(tx: Tx, key: string, handle: string): Promise<void>;
  // Deletes the claims lapsed at `now` and returns them in lapse order, by key within a tie (core expireClaims). It
  // logs nothing: the sweep logs each row's expire event before that row's requeue, in core's order.
  expire(tx: Tx, now: number): Promise<ClaimRow[]>;
  // Appends a claim event (core logEvent).
  logEvent(tx: Tx, event: ClaimEvent, handle: string, c: Partial<Claim> & { key: string }, at: number, heldBy?: string): Promise<void>;
  // The watchers of a claim that ended, by handle, their watches deleted (core takeClaimWatchers): exactly the
  // watches it deleted.
  takeWatchers(tx: Tx, key: string): Promise<string[]>;
  // The user the system's announcement for `c` is written as (core holderUser).
  holderUser(r: Read, c: ClaimRow): Promise<string | undefined>;
  // A queue-board reply's ack (#807 P3 B5b2): releases `key` when one of `addresses` holds it, lapsed or not, with
  // its watches and an "ack" or "ack (late)" release event (core ackQueueClaim); whether it did. A claim another
  // holder took over is left alone: Postgres deletes only a row one of `addresses` holds, in the one statement.
  ackQueue(tx: Tx, addresses: string[], key: string, now: number): Promise<boolean>;
}
