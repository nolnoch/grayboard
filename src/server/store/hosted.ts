// The hosted sessions group's interface (#807 P3 C8a, docs/future/postgres-server.md D2): the live rows of hosted roots
// and children, their ownerships, lost holds, the server's liveness and the hosted facts on `ids`, which Repo (db.ts)
// composes with its write queue and change notices (`write`, `subscribe`) and the Postgres store (pg/) implements. The
// row types stay in hosted-types.ts, which re-exports this interface. Type-only imports, so a module under pg/ may
// import it (pg/isolation.test.ts).
import type { ChildEnd, EndedChild, HostedEnd, HostedLost, HostedSession, LostReader } from "../hosted-types.ts";
import type { Read, Tx } from "./tx_base.ts";

// The columns a row's `update` may change, each written only when the patch names it (#807 P3 C8 decision 2): a caller
// writes what it means to change, so a write from a row read earlier can't undo another writer's column.
export type HostedPatch = Partial<Pick<HostedSession, "grant_id" | "bind_gen" | "place" | "lease_deadline" | "last_seen_at">>;

export interface HostedStore {
  // The store's reads all return promises, on the caller's handle (#807 P3 A7h1).
  get(r: Read, id: string): Promise<HostedSession | undefined>;
  // Lock order (#807 P3 C8): a body that writes under a grant reads it first (`grantLive`), then the capacity lock, then
  // a root's row, then a child's. On SQLite the single writer serializes every body, so the three seams below take no
  // lock there (each still refuses a handle that isn't a live store Tx); on Postgres they are FOR SHARE, an advisory lock
  // and FOR UPDATE. Each is taken in the body whose write it guards, before the read it guards, and the guarded value is
  // read again after it. Never inside a savepoint that may roll back unless what it guards rolls back with it: on
  // Postgres ROLLBACK TO frees the lock.
  // The row, locked for the rest of the body: a child's root first, then the child. What a caller that reads a row and
  // then writes it (or ends it, or inserts a child under it) reads it with.
  lock(tx: Tx, id: string): Promise<HostedSession | undefined>;
  // Admission's lock (`full()`): one for every count-then-insert, taken before the first count. A creating request
  // reads its row again after it, so a racer that inserted the same ID first is found rather than inserted twice.
  lockCapacity(tx: Tx): Promise<void>;
  // Whether the grant is unrevoked and unexpired at `now`, read so that its revoke waits for this body (or this body
  // for the revoke, then reads it revoked): a session written under it can't outlive the revoke's end. False for a
  // missing grant.
  grantLive(tx: Tx, grantId: string, now: number): Promise<boolean>;
  // Whether the session ID is a hosted session's: a root's ownership row
  // stays after it ends; a child's row only while it is registered.
  owned(r: Read, id: string): Promise<boolean>;
  // Every row but parked children (#566): the row set the limits count (`counts`) and the sweeps scan. `get` still returns a
  // parked row, and `children` lists a root's children, parked or not.
  all(r: Read): Promise<HostedSession[]>;
  // What admission counts, without loading rows (#805): unparked rows on the server and the user's. The user's is
  // O(own rows) on idx_hosted_user; the server's walks idx_hosted_parked, bounded by the global row cap.
  counts(r: Read, user: number): Promise<{ total: number; user: number }>;
  // An ownership's unparked rows (idx_hosted_ownership): what a grant re-attach moves.
  ofOwnership(r: Read, ownership: number): Promise<HostedSession[]>;
  children(r: Read, root: string): Promise<HostedSession[]>;
  // A user's live roots, oldest first (#475): peer_list's unbound sessions are those holding nothing.
  roots(r: Read, user: number): Promise<HostedSession[]>;
  // Park an idle child (#566) last seen before `idleBefore`, so a touch committed after the sweep's read keeps it
  // active; whether it parked. Or make a parked one active again under its root's current grant.
  park(tx: Tx, session: string, now: number, idleBefore: number): Promise<boolean>;
  unpark(tx: Tx, session: string, grant: string, now: number): Promise<void>;
  insert(tx: Tx, row: HostedSession): Promise<void>;
  // The patch's columns only; an empty patch writes nothing.
  update(tx: Tx, id: string, patch: HostedPatch): Promise<void>;
  // Activity only: `last_seen_at`, observed by no one (#399).
  touch(tx: Tx, session: string, now: number): Promise<void>;
  // The sweep's candidates by query, not by scanning every row (#399): roots whose lease lapsed by `now`; idle
  // unparked rows (children, and roots with no lease and no hold) last seen before `cutoff`; disabled users' roots.
  expired(r: Read, now: number): Promise<HostedSession[]>;
  idle(r: Read, cutoff: number): Promise<HostedSession[]>;
  disabled(r: Read): Promise<HostedSession[]>;
  // `suggested`: the ownership's suggested name (#443), recorded in its `hosted.ownership_started` audit (#522).
  start(tx: Tx, session: string, user: number, client: string, now: number, suggested?: string | null): Promise<number>;
  // A root's end: its rows, its ownership, its holds and its children's IDs; false for a missing row, a child, or when
  // a guard fails on the row as the end locked it: `deadline` (an expiry) that the lease is still that deadline, and
  // `idleBefore` (an idle end) that the row was last seen before it.
  end(tx: Tx, session: string, reason: HostedEnd, now: number, deadline?: number, idleBefore?: number): Promise<boolean>;
  // A child's release, or a root's end (each of its children), ends the child's ID in the same transaction. An
  // eviction ends only a child still parked.
  childEnd(tx: Tx, session: string, now: number, reason: ChildEnd): Promise<void>;
  // The child IDs ended since the last take: the application's post-commit wakes and bounce deliveries.
  takeEnded(): EndedChild[];
  // A root's lost holds `reader` hasn't taken, oldest first (#453). `lose` records one in the revocation's
  // transaction (restating an alias already pending, for both readers); `lost` reads them; `tellLost` takes the
  // agent's; `reportLost` returns the Controller's, marking them reported; `seeLost` takes the reported ones (its
  // delivery_open: the Controller applied them before opening); `forgetLost` drops an alias the root bound again.
  // A take is one conditional statement, so two takers get each row once between them. A hold both readers took is
  // deleted.
  lose(tx: Tx, session: string, lost: HostedLost, now: number): Promise<void>;
  lost(r: Read, session: string, reader: LostReader): Promise<HostedLost[]>;
  tellLost(tx: Tx, session: string, now: number): Promise<HostedLost[]>;
  reportLost(tx: Tx, session: string, now: number): Promise<HostedLost[]>;
  seeLost(tx: Tx, session: string, now: number): Promise<HostedLost[]>;
  forgetLost(tx: Tx, session: string, alias: string): Promise<void>;
  // The server's last recorded liveness (epoch ms), absent before the first
  // heartbeat on this schema. A restart credits leases with the downtime (#423).
  aliveAt(r: Read): Promise<number | undefined>;
  heartbeat(tx: Tx, now: number): Promise<void>;
  // The hosted facts on a session's `ids` row (#807 P1c-15a): a child's root (#523), an ended ID live again (#475 item 7a),
  // a tools-only root's writes_as (A4) and its ownership's launcher flag (#473, #520). `declareLauncher`: whether it turned
  // the flag on.
  setRoot(tx: Tx, id: string, root: string | null): Promise<void>;
  reopenId(tx: Tx, id: string): Promise<void>;
  restateWritesAs(tx: Tx, id: string, writesAs: string): Promise<void>;
  declareLauncher(tx: Tx, id: string): Promise<boolean>;
  launcher(r: Read, id: string): Promise<boolean>;
  // Every session's holds, oldest first: the hosted sweep's and reconcile's.
  holds(r: Read): Promise<{ id: string; address: string }[]>;
}
