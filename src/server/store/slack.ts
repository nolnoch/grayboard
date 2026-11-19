// The Slack bridge's row types and group interface (#807 P3 C67a, docs/future/postgres-server.md D2): links, thread
// maps and outbound progress, which Repo (db.ts) composes and the Postgres store (pg/) implements. Type-only imports,
// so a module under pg/ may import it (pg/isolation.test.ts); db.ts re-exports every name.
import type { Read, Tx } from "./tx_base.ts";

// A user's Slack link: their member ID and their DM with the bridge's app.
export type SlackLink = { user_id: number; email: string; slack_user: string; dm_channel: string; linked_at: number };
// thread_ts: the Slack top-level message. root_id: the grayboard thread's root
// (message id for dm, post id for board). peer: the other party in a dm.
// last_id: the newest grayboard id in the thread, the parent for a reply.
export type SlackThread = { thread_ts: string; kind: "dm" | "board"; board: string | null; root_id: number; peer: string | null; last_id: number };
// An outbound item's progress: a JSON object, as the relay's Progress is (bridge/relay.ts). Never a scalar or null:
// Postgres's jsonb column is NOT NULL, and a bare number or boolean doesn't bind to it (42804).
export type SlackProgress = Record<string, unknown>;

export interface SlackStore {
  // Every link, by user_id.
  links(r: Read): Promise<SlackLink[]>;
  // application.helloFacts reads it on the caller's handle; delegate reads it before core's
  // resolveDelegationWith decides (#807 P3 A7i).
  linkFor(r: Read, userId: number): Promise<SlackLink | undefined>;
  linkBySlackUser(r: Read, slackUser: string): Promise<SlackLink | undefined>;
  // The link writes' lock (#807 P3 C7 decision 4), held until the body ends: one for every link and unlink, taken
  // before the body's first Slack read, so a Slack account links to one user and an unlink naming an old account
  // can't delete a new link. A no-op on SQLite (the single writer); one advisory lock on Postgres. Never inside a
  // savepoint that may roll back: on Postgres its ROLLBACK TO frees the lock.
  lock(tx: Tx): Promise<void>;
  // Replaces the user's earlier link, if any. A link to another account (or DM) drops the user's thread map and
  // progress, which live in the old account's DM; the same link again keeps them.
  link(tx: Tx, userId: number, slackUser: string, dmChannel: string): Promise<void>;
  // Also forgets the user's thread map and progress.
  unlink(tx: Tx, userId: number): Promise<void>;
  thread(r: Read, userId: number, kind: "dm" | "board", board: string | null, rootId: number): Promise<SlackThread | undefined>;
  threadByTs(r: Read, userId: number, threadTs: string): Promise<SlackThread | undefined>;
  // Inserts the thread unless its ts, or its (kind, board, root), is already mapped; then it changes nothing.
  addThread(tx: Tx, userId: number, t: SlackThread): Promise<void>;
  // Moves a thread's reply target forward, never back; a DM item's sender becomes its peer (#524).
  advanceThread(tx: Tx, userId: number, threadTs: string, id: number, peer?: string): Promise<void>;
  // How far an outbound item got in Slack, keyed by its grayboard ref
  // ("dm:<message id>" or "post:<post id>"); cleared once it's done. A JSON object (SlackProgress): progress returns
  // what setProgress was given (key order aside), with NUL and lone surrogates in its strings as U+FFFD (jsonSafe).
  progress(r: Read, userId: number, ref: string): Promise<SlackProgress | undefined>;
  setProgress(tx: Tx, userId: number, ref: string, progress: SlackProgress): Promise<void>;
  clearProgress(tx: Tx, userId: number, ref: string): Promise<void>;
}
