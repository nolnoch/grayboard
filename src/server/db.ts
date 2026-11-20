import type { Database } from "bun:sqlite";
import type { EndedChild, HostedSession, HostedEnd, LostReader, HostedLost } from "./hosted-types.ts";
import type { HostedPatch, HostedStore } from "./store/hosted.ts";
import { testPause } from "../shared/testpause.ts";
import { makeAuthCache, type AuthPeek } from "./store/auth_cache.ts";
import { queueFor } from "./store/queue.ts";
import { isThenable } from "./store/tx_base.ts";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { acknowledge, redeliveryFacts, aliasScopeRows, authorAddresses, claimQueuePost, humansAmong, insertOutbox, insertPost, queueLaneRows, subscriberRows, threadFacts, insertBoard, isHuman, readRows, setArchived, setMute, threadRoot, type AliasScopeRow, ALIAS_SESSION_SQL, boardViewRows, openSummaryRows, setQueueParticipation, whoRows, writeStatus, type UnboundFacts, ensureBoard, forgetHandle, isSubscribed, markHuman, prunePosts, setSubscription, unsubscribeScope, catalogPage, getBoard, getPost, HOLD_ORDER, lastSeen, pendingDigests, pendingPushes, snapshotPage, pruneEndedIds, registerId, writeAliasMeta, setIdFacts, setPlace, touchAlias, touchId, type CoreDb, setAccess, type Access } from "../core/boards.ts";
import { ackQueueClaim, addClaimWatch, claimRow, claimWatchers, expireClaims, holderUser, listClaims, liveClaim, logEvent, recentClaimEvents, releaseClaim, removeClaimWatch, takeClaim, takeClaimWatchers } from "../core/claims.ts";
import { addressSet, aliasUser, aliasUses, dropHold, holderOf, holdsOf, idRow, idStatuses, logBinding, unendedIds } from "../core/bindings.ts";
import type { AuditAction } from "./audit.ts";
import { bindAttachments, blobNamed, dropAttachments, dropBlobEntry, dropUnsentUploads, getAttachment, insertUpload, pruneUnbound, removeUpload, unnamedBlobs, uploadDigests, withAttachments, type BlobStore, type Uploader } from "../core/attachments.ts";
import { addressParts } from "../core/addresses.ts";
import { HUMAN_NAME } from "../shared/addressing.ts";
import type { Principal } from "../core/resolver.ts";
import { initCoreSchema } from "../core/schema.ts";
import { addressUser, countOpenDelegations, everConnected, isLauncher, launchers } from "../core/delegation.ts";
import { delegationFacts, type DelegationStore } from "./store/delegation.ts";
import type { EndAuditSink, SessionEndPort, SessionEndStore } from "./store/session_end.ts";
import { undeliverableId } from "../core/session_end.ts";
import { afterCommit, type Boundary, onCommit, openBoundary, openReader, openSqlite, ownsTx, ownWriter, reclaimFreePages, routeReads } from "../core/sqlite.ts";
import type { WriteTx } from "../core/write_tx.ts";
import { isTx, type Read, type Tx, sqliteOf, sqliteRead, sqliteTx } from "./store/tx.ts";
import { DEFAULT_ATTACHMENT_LIMITS, DEFAULT_ATTACHMENT_USER_QUOTA, type AttachmentLimits } from "../shared/attachments.ts";
import { DiskBlobs } from "./blobs.ts";
import { detached, inRequest, requestOrigin } from "./request_context.ts";
import { GOOGLE_ISSUER } from "./idp_google.ts";
import { LOGIN_SCOPE, OAUTH_SCOPES } from "./oauth-config.ts";
import type { CredentialSource, ServiceCredential, OAuthStore, OAuthAuthorization, OAuthRequest, OAuthBrowserSession, OAuthCode, OAuthGrant, OAuthTokenPair, OAuthAccess, OAuthFailure } from "./oauth-types.ts";
import { accessFits, accessLookup, BROWSER_SESSIONS, browserData, browserSessionInput, clampPair, clientLookup, codeData, codeInput, grantInput, isLogin, LIVE_SECRETS,
  loginInput, lookup, MINT_WINDOW_MS, mintInput, requestData, requestInput, REQUESTS_PER_BROWSER, REQUESTS_TOTAL, sameAuthorization, rotationBinding, secretLookup,
  serviceCredentialInput, serviceSecretInput, successorInput, time } from "./oauth-rules.ts";
import { AuthorityLost, LastOwner, MissingParent, MissingPost, PrincipalTaken } from "./store/errors.ts";
import type { Alias, AliasesStore } from "./store/aliases.ts";
import type { MessageRow, MessagesStore, RetractResult } from "./store/messages.ts";
import type { AttachmentsStore } from "./store/attachments.ts";
import type { BindingsStore } from "./store/bindings.ts";
import type { BoardsStore } from "./store/boards.ts";
import type { ClaimsStore } from "./store/claims.ts";
import type { CursorsStore } from "./store/cursors.ts";
import type { WriteReceipt, WriteReceiptsStore } from "./store/write_receipts.ts";
import { AUDIT_WRITE_ON_READ, type AccessLogRow, type AuditStore } from "./store/audit.ts";
import type { SlackLink, SlackProgress, SlackStore, SlackThread } from "./store/slack.ts";
import { jsonTextSafe, textSafeOrNull } from "./store/json_safe.ts";
import { DEV_SESSION_LABEL, TEAM_POLICIES, type User, type IdpSignIn, type Session, type PrincipalRow, type Team, type TeamPolicy, type TeamMember, type RoleBinding, type InvokeBinding, type RoleAuthority, type RoleRevoke, type MemberAuthority, type MemberRemoval, type ServiceRow, type UsersStore, type SessionsStore, type PrincipalsStore, type TeamsStore, type RolesStore, type ServicesStore } from "./store/identity.ts";
// The identity groups' row types and interfaces live in store/identity.ts for the Postgres store (#807 P3 C3a);
// re-exported for every importer.
export { DEV_SESSION_LABEL, TEAM_POLICIES } from "./store/identity.ts";
export type { User, IdpSignIn, Session, PrincipalRow, Team, TeamPolicy, TeamRole, TeamMember, RoleBinding, InvokeBinding, RoleAuthority, RoleGrant, RoleRevoke, MemberAuthority, MemberRemoval, RoleFilter, ServiceRow, UsersStore, SessionsStore, PrincipalsStore, TeamsStore, RolesStore, ServicesStore, JsonValue, AuditFields, IdentityGroups } from "./store/identity.ts";
// The aliases and messages groups' row types and interfaces live in store/aliases.ts and store/messages.ts (#807 P3 C5a).
export type { Alias, AliasTarget, AliasesStore, AliasScopeRow } from "./store/aliases.ts";
export type { MessageRow, MessageFiles, ServicePost, RetractResult, MessagesStore } from "./store/messages.ts";
export type { AttachmentsStore } from "./store/attachments.ts";
// The bindings group's in store/bindings.ts (#807 P3 C10a-a).
export type { AliasMetaDiff, BindingsStore } from "./store/bindings.ts";
export type { ClaimsStore } from "./store/claims.ts";
// The cursors, write receipts, audit and Slack groups' in store/cursors.ts, write_receipts.ts, audit.ts and slack.ts (#807 P3 C67a).
export type { CursorStream, CursorsStore } from "./store/cursors.ts";
export type { WriteReceipt, WriteReceiptKey, WriteReceiptsStore } from "./store/write_receipts.ts";
export { AUDIT_WRITE_ON_READ, type AccessLogRow, type AuditStore } from "./store/audit.ts";
export type { SlackLink, SlackProgress, SlackThread, SlackStore } from "./store/slack.ts";
// The hosted group's in store/hosted.ts (#807 P3 C8a); its row types in hosted-types.ts.
export type { HostedPatch, HostedStore } from "./store/hosted.ts";
// The session end and delegation groups' in store/session_end.ts and store/delegation.ts (#807 P3 C10d1).
export type { SessionEndStore } from "./store/session_end.ts";
export type { DelegationStore, ReadDelegationFacts } from "./store/delegation.ts";

// Row types
// Every read of a user row goes through this, so `kind` is never missing (a "SELECT *" would type-check without it).
// A users row with no service principal is a person's: user principals are seeded on every open.
const USER_SQL = `SELECT u.id, u.email, u.display_name, u.created_at, u.disabled_at, u.idp_issuer, u.idp_subject,
  CASE WHEN p.id IS NULL THEN 'user' ELSE 'service' END AS kind
  FROM users u LEFT JOIN principals p ON p.user_id = u.id AND p.kind = 'service'`;
// A user row by id, the auth cache's read (tests count it).
export const USER_BY_ID_SQL = `${USER_SQL} WHERE u.id = ?`;
// Only a direct message's sender and recipient can see it, its thread, or
// the files it carries. One you're not in reads as missing, so its existence
// doesn't leak. `me`: every address the caller reads as (#284 S8).
export function participant(m: MessageRow | undefined, me: string[]): m is MessageRow {
  return !!m && m.recipient_type === "user" && (me.includes(m.sender) || me.includes(m.recipient));
}

// A message's columns as readers see them. sender_id (#284) is the sending
// session's provenance, kept in the database and left out of reads and pushes;
// via (#523) is shown, since it names a child writer its root's address hides.
const MSG_COLS = `id, sender, recipient_type, recipient, body, parent_id, created_at, delivered_at, pending, kind, via`;
const M_MSG_COLS = `m.id, m.sender, m.recipient_type, m.recipient, m.body, m.parent_id, m.created_at, m.delivered_at, m.pending, m.kind, m.via`;
const ALIAS_COLS = `id, address, scope_kind, scope_ref, name, created_at`;

// A synchronous callback's result: a promise is refused at compile time, so
// nothing can await between a transaction's reads and its writes.
export type Sync<T> = T extends PromiseLike<unknown> ? never : T;
// The hosted group as Repo composes it (#807 P3 C8a): the store's members, with its write queue and change notices.
export type RepoHosted = HostedStore & {
  // One IMMEDIATE transaction through the server's write queue, for a transaction's outermost caller (Repo.write): `committed` runs
  // after the commit, before the queue's next body. fn may be async: `committed` gets its resolved value.
  write<T, R = T>(fn: (tx: Tx) => Promise<T>, committed?: (value: T) => R): Promise<Awaited<R>>;
  write<T, R = T>(fn: (tx: Tx) => Sync<T>, committed?: (value: T) => R): Promise<Awaited<R>>;
  // Told after each commit that changed a row (#399): its session ID, or null when any row may have (a grant or
  // user change). A touch (`touch`) tells nothing: nothing that observes rows reads `last_seen_at`.
  // With `read`, a named row's notice carries `read`'s answer on the committing transaction, just before its COMMIT
  // (#807 P3 A7g1); undefined when the read failed or the body was synchronous.
  subscribe<F>(fn: (changed: string | null, facts?: F) => void, read?: (tx: Tx, id: string) => Promise<F>): () => void;
};
// Repo.authPeek's answer (store/auth_cache.ts), re-exported for its callers.
export type { AuthPeek };

// A top-level write transaction, through db's write queue. `committed` runs after the commit and before the queue's
// next body (D4: in-memory state a transaction reads changes only inside one or right after its commit, never in
// the gap before its caller resumes). Its result is boxed, so a promise it returns doesn't hold the queue.
// fn may await (#807 P1b-4e): the transaction stays open, and the queue held, until its promise settles; it commits
// on fulfilment, after the beforeCommit hooks its Tx registered, and rolls back on rejection. Meanwhile other tasks
// read committed state on the reader and their writes wait in the queue (core/sqlite.ts ownWriter).
// fn gets the transaction's Tx (#807 P1c), closed when fn settles: a timer or un-awaited promise fn started that uses it
// later throws instead of writing into whichever transaction is open by then.
// fn and committed run as the work of the request that called write(), or of none (#1042): a body that waited starts
// from the releasing holder's context, whose request origin its audit rows would otherwise carry (F-19). Only the
// origin is set: binding the whole context (AsyncResource.bind) would also restore the queue's holder token.
// `thrown` sees a failure the body throws synchronously (BEGIN, fn, COMMIT, committed), before the promise rejects
// with it: posted's idle queue throws it to its caller.
function queued<T, R>(db: Database, fn: (tx: Tx) => T | PromiseLike<T>, committed?: (value: T) => R, thrown?: (error: unknown) => void): Promise<Awaited<R>> {
  const queue = queueFor(db);
  if (queue.mine && db.inTransaction) return Promise.reject(new Error("write() inside an open transaction: nested code calls its Tx's savepoint"));
  const o = requestOrigin();
  const run = () => {
    try { return o ? inRequest(o, body) : detached(body); } catch (error) { thrown?.(error); throw error; }
  };
  return queue.run(run).then(box => box.out) as Promise<Awaited<R>>;
  function body(): { out: R } | Promise<{ out: R }> {
    const b = openBoundary(db);
    const tx = sqliteTx(db);
    const settle = (value: T) => { tx.close(); b.commit(); return { out: committed ? committed(value) : value as unknown as R }; };
    const fail = (error: unknown): never => { tx.close(); b.rollback(); throw error; };
    let out: T | PromiseLike<T>;
    try { out = fn(tx); } catch (error) { return fail(error); }
    if (!isThenable(out) && !tx.hasBeforeCommit) return settle(out as T);
    // Reactions attached here run as the holder (the queue's context follows them), so the commit is the writer's.
    // The beforeCommit hooks run after the body fulfils, on its still-open Tx (#807 P3 A7g); a sync body that
    // registered one goes this way too. With none, the commit is as many ticks after the body as before: an
    // un-awaited write's caller resumes after it committed, not inside it.
    return Promise.resolve(out).then(value => tx.hasBeforeCommit ? tx.runBeforeCommit().then(() => settle(value), fail) : settle(value), fail);
  }
}

// fn's synchronous transaction body with its own Tx, closed when it returns or throws. Its savepoint refuses: a
// synchronous body can't await one, and an unawaited one would outlive the frame it opened in.
function withTx<T>(db: Database, fn: (tx: Tx) => T): () => T {
  return () => {
    const tx = sqliteTx(db, false);
    try { return fn(tx); } finally { tx.close(); }
  };
}

// Core's shared writes (attachment store/release/sweep, #807 D4) through repo's write queue, each body
// given the connection its queued body's `Tx` resolves to (P1c-15c-2). Core's bodies are synchronous, so the cast
// only restates that. The server's own flows reach these through `repo.claims` and `repo.attachments` (P3 B2, B3); this
// stays for tests that drive core's flows against a server database.
export function queuedTx(repo: Repo): WriteTx {
  return <T>(fn: (db: CoreDb) => T) => repo.write((tx: Tx) => fn(repo.coreOn(tx)) as Sync<T>) as Promise<T>;
}

// A write no caller waits for (an audit row, a closing session's last-seen touch, a lapsed lease's settle; #807 P1b-4b),
// for code that can't await: a sync finally, a timer, a sync check on the request path. It runs as its own transaction
// when the caller holds the queue outside one (its committed callback, its afterCommit flush), or through the queue:
// now when it's idle and fn is synchronous and registered no beforeCommit hook, else when fn (and its hooks) settles
// or after the bodies ahead of it. Inside an open transaction it refuses (#807 P3 A3): a write that belongs to a body
// goes on that body's Tx. fn may be async, except from the holder: the holder resumes while fn awaits, so a thenable
// there rolls fn back and throws. True when it ran now (its error, and committed's, thrown), false when it waits or
// awaits; a failure then is logged as `what` failed. The Postgres store's post (store/pg/tx.ts) is always false: every
// commit there is async, and a holder's post queues behind the bodies already waiting.
function posted<T>(db: Database, fn: (tx: Tx) => T | PromiseLike<T>, given: ((value: T) => unknown) | undefined, what: string): boolean {
  const queue = queueFor(db);
  // No caller awaits a post, so a promise its committed returns is caught here, on every branch, and logged as `what`
  // (#1051); returning nothing, the waited branch's own catch doesn't log it twice. A synchronous throw is unchanged.
  const committed = given && ((value: T) => {
    const r = given(value);
    if (isThenable(r)) Promise.resolve(r).catch(error => console.error(`[grayboard] ${what} failed:`, error));
  });
  if (queue.mine && db.inTransaction) throw new Error(`post inside an open transaction (${what}): a body's write goes on its Tx`);
  if (queue.mine) {
    const value = db.transaction(() => {
      const out = withTx(db, fn)();
      if (!isThenable(out)) return out;
      Promise.resolve(out).catch(() => {});
      throw new Error(`async post from the write queue's holder (${what}): the holder would run while it awaits`);
    }).immediate() as T;
    committed?.(value);
    return true;
  }
  // An idle queue starts the body inside queued(): a synchronous failure (BEGIN, fn, COMMIT, committed) is thrown here.
  let now = true, ran = false, failed: { error: unknown } | undefined;
  const done = queued(db, fn, (value: T) => { committed?.(value); ran = true; }, error => { if (now) failed = { error }; });
  now = false;
  if (failed) { done.catch(() => {}); throw failed.error; }
  done.catch(error => console.error(`[grayboard] ${what} failed:`, error));
  return ran;
}

export interface Repo {
  // The server's clock, for rows written outside the Repo too (writeAudit).
  now(): number;
  // Runs fn in one IMMEDIATE transaction through the server's write queue (store/queue.ts): the form for a
  // transaction's outermost caller. Inside an open transaction it refuses, since a nested body can't wait for
  // the queue its own transaction holds; nested code calls its Tx's `savepoint`. `committed(value)` runs after the commit, before
  // the queue's next body: in-memory state the transaction's readers see changes there, not after the await.
  // fn may be async: its transaction stays open across its awaits, other tasks' writes waiting behind it (P1b-4e).
  // fn gets the transaction's Tx (#807 P1c), live until fn settles; a store function it calls writes through it.
  write<T, R = T>(fn: (tx: Tx) => Promise<T>, committed?: (value: T) => R): Promise<Awaited<R>>;
  write<T, R = T>(fn: (tx: Tx) => Sync<T>, committed?: (value: T) => R): Promise<Awaited<R>>;
  // A write no caller awaits, for code that can't (posted, above): true when it ran now, false when it waits behind
  // another body or awaits (always, on Postgres), its failure then logged as `what` failed. It refuses inside an open transaction (a body's
  // write goes on its Tx). A promise `committed` returns is caught and its rejection logged as `what` failed on every
  // branch (#1051). fn may be async (#807 P3 A3), except from the queue's holder; its Tx is live until fn settles.
  post<T>(fn: (tx: Tx) => T | Promise<T>, committed?: (value: T) => unknown, what?: string): boolean;
  // The store's read handle outside any transaction (#807 P1c): reads committed state. The task holding an open
  // transaction can't use it (sqliteOf refuses, #807 P3 A7e2): it passes its body's Tx. A Postgres Read is a pool
  // handle and must never resolve to a transaction's connection.
  read: Read;
  // Runs fn, which writes none of the generation's tables, with the auth cache's generation read once for its whole
  // body (#881): one authorization's token and user reads share it, across its awaits (#807 P3 A7c). Inside the
  // caller's own transaction, nested, or with no generation to read, it's plain fn().
  authRead<T>(fn: () => T | Promise<T>): Promise<T>;
  // The auth cache's hits, synchronously, for the stream timer's phase A (#807 P3 A7d): a live access token by hash,
  // and a user by id (#807 P3 A7u2), as the caches hold them under the current generation, else undefined (a miss:
  // the caller reads in full, async).
  // Only live tokens are cached, so a miss is never a refusal. Undefined itself when there's no generation to key on
  // (inside the caller's own transaction, or a failed generation read).
  authPeek(): AuthPeek | undefined;
  // The auth cache's generation: authRead's pinned one inside its body (and in work the body starts: the pin follows
  // the async task, #807 P3 A7b), else read now; undefined inside the caller's
  // own transaction. Another task's open transaction doesn't move it: it reflects commits only (#996). Equal values
  // mean no committed write to oauth_tokens, oauth_grants or users from this connection, and no commit at all from
  // another, came between them (#899).
  authGeneration(): string | undefined;
  // The generation read now, never authRead's pin, where every commit to oauth_tokens, oauth_grants or users moves it
  // before the committing body releases the write queue (SQLite: the commit hook and data_version); undefined inside
  // the caller's own transaction, after a failed counter read, and on a store whose generation can lag a commit (an
  // outside writer's notice still in flight). The hosted gate reads equal values as "no auth commit between them"
  // (#807 P3 A7d2b), which only this contract makes sound; authGeneration's equality (#899) promises less.
  commitGeneration(): string | undefined;
  oauth: OAuthStore;
  hosted: RepoHosted;
  users: UsersStore;
  sessions: SessionsStore;
  principals: PrincipalsStore;
  // Names in scopes, keyed by address (store/aliases.ts).
  aliases: AliasesStore;
  // Holds, session rows and presence (store/bindings.ts).
  bindings: BindingsStore;
  // Uploads and the blob catalog (store/attachments.ts).
  attachments: AttachmentsStore;
  // Claims, their watches and events (store/claims.ts).
  claims: ClaimsStore;
  // Boards, posts, subscriptions, pushes and a queue post's claim (store/boards.ts).
  boards: BoardsStore;
  // A session's end and its ID's deliverability (store/session_end.ts).
  sessionEnd: SessionEndStore;
  // What a delegate decides on (store/delegation.ts).
  delegation: DelegationStore;
  teams: TeamsStore;
  roles: RolesStore;
  services: ServicesStore;
  // Direct and team messages (store/messages.ts).
  messages: MessagesStore;
  // The connection a handle resolves to, for core helpers that take a `db` (#807 P1c-15b; D1 keeps core's signatures until
  // P3 forks it): a body's `Tx` inside one, `repo.read` outside. Resolved at the call, so a settled `Tx` is refused there.
  coreOn(h: Read): CoreDb;
  // Closes the database: the reader, then the writer (#807 P1c-15c-2: the server holds no raw connection to close).
  close(): void;
  cursors: CursorsStore;
  audit: AuditStore;
  slack: SlackStore;
  writeReceipts: WriteReceiptsStore;
  // The database file's free pages (#137).
  storage: {
    // Returns up to `maxPages` (> 0) free pages to the filesystem with
    // `PRAGMA incremental_vacuum`. A file without auto_vacuum=INCREMENTAL
    // (created before #170) reclaims nothing until a one-time VACUUM converts it.
    // Async because the Repo interface is async for the Postgres store (#807 P3 A6f), not because SQLite awaits.
    reclaimFreePages(maxPages: number): Promise<{ reclaimed: number; remaining: number; incremental: boolean }>;
  };
  // Attachment bytes, by sha256; the attachment rows are metadata in this database.
  blobs: BlobStore;
  // The server's per-file and per-message caps; insert binds files under them.
  attachmentLimits: AttachmentLimits;
  // The bytes of attachments one user may store, sent or not.
  attachmentUserQuota: number;
}

// `now` is the hub's clock (application.ts): rows, audit and write receipts read one clock, so a test clock moves them together (#297).
// `sessionEnd`: the session end a released hosted child's ID ends through (session_end.ts sessionEndPort), made from
// the Repo on first use; a child end without it throws.
export type OpenOptions = { blobDir: string; attachmentLimits?: AttachmentLimits; attachmentUserQuota?: number; now?: () => number; sessionEnd?: (repo: Repo) => SessionEndPort };

// undeliveredFrom: messages a sender has sent that the recipient's read point
// hasn't reached. The read point is the last delivered-and-handled message id
// (mailbox_cursors.last_seen_id); unread = `id > read point` — a message is counted
// undelivered iff `id > read point`. Exported so the EXPLAIN pin asserts the
// plan of the exact statement the code executes, not a hand-copied drift.
// The unary `+` on recipient_type keeps the planner, which has no ANALYZE stats, off
// idx_msg_recipient: that index on recipient_type alone is a pass over every user DM (#805).
export const UNDELIVERED_FROM_SQL = `SELECT m.recipient, COUNT(*) AS n, MIN(m.id) AS oldest_id FROM messages m
             LEFT JOIN mailbox_cursors c ON c.address = m.recipient AND c.stream_type = 'direct' AND c.stream_ref = m.recipient
            WHERE m.sender IN (SELECT value FROM json_each(?)) AND +m.recipient_type = 'user' AND m.recipient != m.sender
              AND m.id > COALESCE(c.last_seen_id, 0) AND m.delivered_at IS NULL AND m.created_at < ?
            GROUP BY m.recipient ORDER BY m.recipient`;

// queuedTo: per recipient, the DMs its read point hasn't reached. Exported
// for the same EXPLAIN pin.
export const QUEUED_TO_SQL = `SELECT m.recipient, COUNT(*) AS n FROM messages m
            WHERE m.recipient_type = 'user' AND m.recipient IN (SELECT value FROM json_each(?)) AND m.recipient != m.sender
              AND m.id > COALESCE((SELECT c.last_seen_id FROM mailbox_cursors c WHERE c.address = m.recipient AND c.stream_type = 'direct' AND c.stream_ref = m.recipient), 0)
            GROUP BY m.recipient`;

// sentPending: the sender's pending DMs, unacked. Exported for the same EXPLAIN pin; `+` as in undeliveredFrom.
export const SENT_PENDING_SQL = `SELECT ${M_MSG_COLS} FROM messages m
            WHERE +m.recipient_type = 'user' AND m.sender IN (SELECT value FROM json_each(?)) AND m.pending = 1 AND m.created_at >= ?
              AND NOT EXISTS (SELECT 1 FROM dm_acks a WHERE a.reader = m.sender AND a.message_id = m.id)
            ORDER BY m.id ASC`;

// retract: the sender's direct message, with what decides whether it may go: delivered or past the recipient's
// cursor (read), and whether it has a reply (#807 P3 C5 decision 4: the store says which). Exported for the same
// EXPLAIN pin.
export const RETRACTABLE_SQL = `SELECT recipient,
               delivered_at IS NOT NULL OR id <= COALESCE((SELECT last_seen_id FROM mailbox_cursors
                                   WHERE address = messages.recipient AND stream_type = 'direct' AND stream_ref = messages.recipient), 0) AS read,
               EXISTS (SELECT 1 FROM messages r WHERE r.parent_id = messages.id) AS replied
               FROM messages WHERE id = ? AND sender = ? AND recipient_type = 'user'`;

// audit.last: the newest row for (action, target), searched by idx_access_log_action_target (#295).
export const ACCESS_LOG_LAST_SQL = `SELECT at, actor, action, target, detail FROM access_log WHERE action = ? AND target = ? ORDER BY at DESC, id DESC LIMIT 1`;
// `db` is the raw writer, returned for tests only (#807 P1c-15c-2): server code reaches the database through `repo`, and
// a core helper through `repo.coreOn(handle)`, so nothing outside this file writes without a live `Tx`.
export function openDatabase(path: string, opts: OpenOptions): { db: Database; repo: Repo } {
  mkdirSync(dirname(path), { recursive: true });
  // auto_vacuum must precede the first page write.
  const db = openSqlite(path, "PRAGMA auto_vacuum = INCREMENTAL; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;", (d) => {
    // The first open under #284 creates aliases; that open seeds it.
    const first = !d.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'aliases'`).get();
    // The first open under #927 creates role_bindings; that open seeds team ownership into it.
    const firstRoles = !d.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'role_bindings'`).get();
    initSchema(d);
    initCoreSchema(d);
    migrateHostedHolds(d);
    recordChildRoots(d);
    sweepStaleLaunchers(d, (opts.now ?? Date.now)());
    seedSchema(d, first, firstRoles);
  });
  authGenerationTriggers(db);
  // Core's board and claim functions judge visibility through the Access installed on their connection, and fall back
  // to local mode's open one. No server path calls them (its ports check the async boardAccess), so a server database
  // installs one that refuses every use: a future caller fails loudly instead of skipping team and service visibility.
  // A test that seeds through core opts in with setAccess(db, openAccess(db)), or the parity oracle.
  setAccess(db, SERVER_REFUSES_CORE_ACCESS);
  routeReads(db, openReader(path));
  const queue = queueFor(db);
  ownWriter(db, { holds: () => queue.mine, check: () => queue.assertMine() });
  let port: SessionEndPort | undefined;
  const sessionEnd = () => port ??= opts.sessionEnd?.(repo) ?? (() => { throw new Error("no session-end port: pass OpenOptions.sessionEnd to end a hosted child"); })();
  const repo = makeRepo(db, new DiskBlobs(opts.blobDir), opts.attachmentLimits ?? DEFAULT_ATTACHMENT_LIMITS, opts.attachmentUserQuota ?? DEFAULT_ATTACHMENT_USER_QUOTA, sessionEnd, opts.now);
  return { db, repo };
}

const SERVER_REFUSES_CORE_ACCESS = new Proxy({} as Access, {
  get(_t, key) { throw new Error(`core Access.${String(key)} on a server database: server paths use boardAccess (src/server/access.ts)`); },
});

// #853: a connection-local counter every write to the authorization tables bumps, by trigger, so no
// write site can forget to. TEMP objects live and die with this connection, outside the schema, and
// roll back with their transaction: makeRepo reads the counter only after a commit (onCommit), and authGeneration
// serves that value.
function authGenerationTriggers(db: Database): void {
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS auth_generation(n INTEGER NOT NULL);
    INSERT INTO auth_generation(n) SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM auth_generation)`);
  for (const table of ["oauth_tokens", "oauth_grants", "users"]) for (const op of ["INSERT", "UPDATE", "DELETE"]) {
    db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS auth_generation_${table}_${op.toLowerCase()} AFTER ${op} ON ${table}
      BEGIN UPDATE auth_generation SET n = n + 1; END`);
  }
}

// #451: a hosted root holds aliases like any session, in alias_holds, whose address
// PRIMARY KEY is the uniqueness. hosted_sessions.name is vestigial: SQLite can't drop a
// column an old index covered without a rebuild, and schema changes here are additive, so
// the column stays, unread and unwritten. A row an older release bound has its name copied
// into alias_holds once (a v2.x server already wrote the matching hold, so this is normally
// a no-op), then cleared, so a later open finds nothing to do. writes_as: the alias a
// tools-only hosted root writes as. Runs after initCoreSchema, which creates alias_holds.
function migrateHostedHolds(db: Database): void {
  const cols = new Set((db.prepare(`PRAGMA table_info(hosted_sessions)`).all() as { name: string }[]).map((c) => c.name));
  if (!cols.has("writes_as")) db.exec(`ALTER TABLE hosted_sessions ADD COLUMN writes_as TEXT`);
  // The name a root's first request suggested (#443): written at insert, never updated.
  if (!cols.has("suggested")) db.exec(`ALTER TABLE hosted_sessions ADD COLUMN suggested TEXT`);
  // When the sweep parked an idle child (#566); null while active.
  if (!cols.has("parked_at")) db.exec(`ALTER TABLE hosted_sessions ADD COLUMN parked_at INTEGER`);
  // `all()` reads the active rows and `children()` a root's: a long ownership's parked backlog stays off both scans.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_hosted_parked ON hosted_sessions(parked_at); CREATE INDEX IF NOT EXISTS idx_hosted_root ON hosted_sessions(root_session_id)`);
  db.exec(`
    INSERT OR IGNORE INTO alias_holds(address, id, bound_at)
      SELECT u.email || '/' || h.name, h.session_id, h.last_seen_at FROM hosted_sessions h JOIN users u ON u.id = h.user_id WHERE h.name IS NOT NULL;
    UPDATE hosted_sessions SET name = NULL WHERE name IS NOT NULL;
  `);
}

// #523: a hosted child's root is recorded on its ids row (hostedRoot), where it
// outlives the child's source row. A child registered before the column, or by
// an older release sharing the file, gets it from its live source row here.
// Runs after initCoreSchema, which adds ids.root_id.
function recordChildRoots(db: Database): void {
  db.exec(`
    UPDATE ids SET root_id = (SELECT h.root_session_id FROM hosted_sessions h WHERE h.session_id = ids.id)
      WHERE root_id IS NULL AND id IN (SELECT session_id FROM hosted_sessions WHERE root_session_id IS NOT NULL);
  `);
}

// #521 5: a server sets ids.launcher only for a live hosted root's ownership (hostedDeclareLauncher), and that
// ownership's end clears it. A mark on any other row is stale: a pre-upgrade WSS launcher's, or a hosted root's
// that ended before #532 cleared the flag at the end. It kept `peer_list` showing `launcher: true` on an offline
// alias whose last holder it was, and `delegate(to:)` answering "a launcher but offline". One statement clears
// them on every open (normally none); each cleared ID is audited `handle.launcher_set {on: false, reason: "stale"}`,
// actor its principal (no ownership or client to name, unlike an end's row).
function sweepStaleLaunchers(db: Database, now: number): void {
  const cleared = db.prepare(`UPDATE ids SET launcher = 0 WHERE launcher = 1
      AND NOT EXISTS (SELECT 1 FROM hosted_sessions h WHERE h.session_id = ids.id AND h.root_session_id IS NULL)
      RETURNING id, principal`).all() as { id: string; principal: string | null }[];
  for (const { id, principal } of cleared) insertAudit(db, now, principal, "handle.launcher_set", id, JSON.stringify({ on: false, reason: "stale" }));
}

function initSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hosted_ownerships (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id),
      client_id TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, end_reason TEXT
    );
    CREATE TABLE IF NOT EXISTS hosted_sessions (
      session_id TEXT PRIMARY KEY, ownership_id INTEGER NOT NULL REFERENCES hosted_ownerships(id),
      user_id INTEGER NOT NULL REFERENCES users(id), client_id TEXT NOT NULL, grant_id TEXT NOT NULL,
      source_session_id TEXT NOT NULL, name TEXT, bind_gen INTEGER NOT NULL DEFAULT 0,
      root_session_id TEXT, place TEXT, lease_deadline INTEGER, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hosted_grant ON hosted_sessions(grant_id);
    CREATE INDEX IF NOT EXISTS idx_hosted_ownership ON hosted_sessions(ownership_id);
    CREATE INDEX IF NOT EXISTS idx_hosted_deadline ON hosted_sessions(lease_deadline);
    CREATE INDEX IF NOT EXISTS idx_hosted_user ON hosted_sessions(user_id);
    -- A hosted root's holds are alias_holds rows (#451); the unique index on its old single name goes (migrateHostedHolds).
    DROP INDEX IF EXISTS idx_hosted_name;
    -- A hosted root's holds the server took (#453, revokeAliases), one row per alias (a second loss restates it).
    -- Two readers: the agent takes a row once (told_at: its native whoami or tool result carried the notice); the
    -- root's Controller is reported it by every subscriber whoami (reported_at: the first) until its next
    -- delivery_open (seen_at), which it sends only after applying the loss, so the shrunken held set is a known
    -- loss, not a pause, even when a whoami's response is lost. A row both took is deleted; a bind of the alias
    -- deletes it too. An ownership end deletes the row and these with it: the next ownership starts holding
    -- nothing. was_primary: the hold was the root's primary, for the notice's "sends as ... now".
    CREATE TABLE IF NOT EXISTS hosted_alias_lost (
      session_id TEXT NOT NULL REFERENCES hosted_sessions(session_id) ON DELETE CASCADE,
      alias TEXT NOT NULL, reason TEXT NOT NULL, was_primary INTEGER NOT NULL, at INTEGER NOT NULL,
      told_at INTEGER, reported_at INTEGER, seen_at INTEGER,
      PRIMARY KEY (session_id, alias)
    );
    -- Server-wide scalar state. alive_at: the server's last heartbeat (epoch ms),
    -- so a restart can credit hosted leases with the downtime (#423). builtin_clients:
    -- when this database first ran with the built-in OAuth clients (#429), which revoked
    -- older grants under their IDs (revokePreBuiltinGrants); builtin_clients_cli: the same
    -- for grayboard-cli (#928).
    CREATE TABLE IF NOT EXISTS server_state (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS oauth_requests (
      hash TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_oauth_requests_expiry ON oauth_requests(expires_at);
    CREATE TABLE IF NOT EXISTS oauth_browsers (
      hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL, data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_codes (
      hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL, data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_grants (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL,
      revoked_at INTEGER, data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_oauth_grants_user ON oauth_grants(user_id);
    -- A service's OAuth client-credentials client (#270 D2): one per row, owned by the service (user_id), with its own
    -- oauth_grants row, whose expires_at is the credential's expiry and whose revoked_at is its revocation. source
    -- (D3) and user_id never change after insert: the access cache reads source through the grant and no trigger
    -- covers this table. token_seconds: the run-token lifetime the admin set, clamped again at each mint.
    CREATE TABLE IF NOT EXISTS service_credentials (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id     TEXT    NOT NULL UNIQUE,
      user_id       INTEGER NOT NULL REFERENCES users(id),
      grant_id      TEXT    NOT NULL UNIQUE REFERENCES oauth_grants(id) ON DELETE CASCADE,
      source        TEXT    NOT NULL CHECK (source IN ('opencode','generic')),
      token_seconds INTEGER NOT NULL,
      created_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_service_credentials_user ON service_credentials(user_id);
    -- A credential's secrets, SHA-256 only (D2): up to two live at once, for rotation.
    CREATE TABLE IF NOT EXISTS service_credential_secrets (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      credential_id INTEGER NOT NULL REFERENCES service_credentials(id) ON DELETE CASCADE,
      hash          TEXT    NOT NULL UNIQUE,
      created_at    INTEGER NOT NULL,
      revoked_at    INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_service_credential_secrets_credential ON service_credential_secrets(credential_id);
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('access','refresh')), expires_at INTEGER NOT NULL,
      spent_at INTEGER, revoked_at INTEGER, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_oauth_tokens_grant ON oauth_tokens(grant_id);

    CREATE TABLE IF NOT EXISTS users (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      email        TEXT NOT NULL UNIQUE,
      display_name TEXT,
      created_at   INTEGER NOT NULL,
      disabled_at  INTEGER
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL REFERENCES users(id),
      token_hash   TEXT NOT NULL UNIQUE,
      created_at   INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL,
      revoked_at   INTEGER,
      label        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS identities (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id),
      name       TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(user_id, name)
    );

    CREATE TABLE IF NOT EXISTS teams (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL UNIQUE,
      created_by  INTEGER NOT NULL REFERENCES users(id),
      policy      TEXT NOT NULL DEFAULT 'open',
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS team_members (
      team_id   INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id   INTEGER NOT NULL REFERENCES users(id),
      joined_at INTEGER NOT NULL,
      PRIMARY KEY (team_id, user_id)
    );
    -- A user's teams, and whether two users share a collaborative one (the
    -- msg.wake grant, #806), are indexed lookups (vision.md principle 11).
    CREATE INDEX IF NOT EXISTS team_members_user ON team_members(user_id);

    CREATE TABLE IF NOT EXISTS messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      sender          TEXT NOT NULL,
      recipient_type  TEXT NOT NULL CHECK (recipient_type IN ('user','team')),
      recipient       TEXT NOT NULL,
      body            TEXT NOT NULL,
      parent_id       INTEGER REFERENCES messages(id),
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_msg_recipient ON messages(recipient_type, recipient, id);
    CREATE INDEX IF NOT EXISTS idx_msg_sender ON messages(sender, id);

    CREATE TABLE IF NOT EXISTS cursors (
      identity_id   INTEGER NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
      stream_type   TEXT NOT NULL CHECK (stream_type IN ('direct','team')),
      stream_ref    TEXT NOT NULL,
      last_seen_id  INTEGER NOT NULL,
      PRIMARY KEY (identity_id, stream_type, stream_ref)
    );
    CREATE INDEX IF NOT EXISTS idx_cursors_stream ON cursors(stream_type, stream_ref);

    -- Read points by address (#284), replacing cursors, which an
    -- alias-less session can't key: identity_id is NOT NULL there.
    CREATE TABLE IF NOT EXISTS mailbox_cursors (
      address       TEXT    NOT NULL,
      stream_type   TEXT    NOT NULL CHECK (stream_type IN ('direct','team')),
      stream_ref    TEXT    NOT NULL,
      last_seen_id  INTEGER NOT NULL,
      PRIMARY KEY (address, stream_type, stream_ref)
    );

    -- Scope owners (#284 decision 5): every user (name = email) and team,
    -- and service principals (#270). name is one namespace: a team and a
    -- service principal can't share one, and neither can contain "@".
    CREATE TABLE IF NOT EXISTS principals (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      kind        TEXT    NOT NULL CHECK (kind IN ('user','team','service')),
      name        TEXT    NOT NULL UNIQUE,
      user_id     INTEGER REFERENCES users(id),
      team_id     INTEGER REFERENCES teams(id),
      parent_id   INTEGER REFERENCES principals(id),
      created_at  INTEGER NOT NULL
    );
    -- A user's and a team's principal row, for a role decision's one lookup (#927).
    CREATE INDEX IF NOT EXISTS idx_principals_user ON principals(user_id);
    CREATE INDEX IF NOT EXISTS idx_principals_team ON principals(team_id);

    -- Runtime role bindings (#927): authority is that a row exists, read on every
    -- decision. principal_id holds the role; scope_id is null for the org
    -- (org_admin), else the team's or service's principal row. RESTRICT, not
    -- CASCADE: deleting a scope or holder must revoke its bindings first, each
    -- with its role.revoked row. granted_by is null only for the #927 seed. No
    -- CHECK on role: the role table in policy.ts validates, and a CHECK can't be
    -- widened additively. A NULL never collides in a unique index, so the org
    -- and scoped bindings each get a partial one.
    CREATE TABLE IF NOT EXISTS role_bindings (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      principal_id INTEGER NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
      role         TEXT    NOT NULL,
      scope_id     INTEGER REFERENCES principals(id) ON DELETE RESTRICT,
      granted_by   INTEGER REFERENCES principals(id) ON DELETE RESTRICT,
      granted_at   INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_role_bindings_org ON role_bindings(principal_id, role) WHERE scope_id IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_role_bindings_scoped ON role_bindings(principal_id, role, scope_id) WHERE scope_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_role_bindings_scope ON role_bindings(scope_id, role);

    CREATE TABLE IF NOT EXISTS access_log (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      at     INTEGER NOT NULL,
      actor  TEXT,
      action TEXT NOT NULL,
      target TEXT,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_at ON access_log(at);
    -- audit.last's (action, target) lookup, newest first: a repeated dm_retract asks it each time (#295).
    CREATE INDEX IF NOT EXISTS idx_access_log_action_target ON access_log(action, target, at);

    -- The Slack bridge (src/server/slack.ts): who is linked, and which Slack
    -- thread holds which grayboard thread. board is '' for a dm, so the
    -- UNIQUE constraint holds (NULLs never collide).
    CREATE TABLE IF NOT EXISTS slack_links (
      user_id    INTEGER PRIMARY KEY REFERENCES users(id),
      slack_user TEXT NOT NULL UNIQUE,
      dm_channel TEXT NOT NULL,
      linked_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS slack_threads (
      user_id   INTEGER NOT NULL REFERENCES users(id),
      thread_ts TEXT NOT NULL,
      kind      TEXT NOT NULL CHECK (kind IN ('dm','board')),
      board     TEXT NOT NULL DEFAULT '',
      root_id   INTEGER NOT NULL,
      peer      TEXT,
      last_id   INTEGER NOT NULL,
      PRIMARY KEY (user_id, thread_ts),
      UNIQUE (user_id, kind, board, root_id)
    );
    -- An outbound item partway into Slack (src/bridge/relay.ts Progress), so
    -- a restart neither reposts it nor shares its files twice. The outbox
    -- itself is the hub's unacked pushes.
    CREATE TABLE IF NOT EXISTS slack_progress (
      user_id   INTEGER NOT NULL REFERENCES users(id),
      ref       TEXT NOT NULL,
      progress  TEXT NOT NULL,
      PRIMARY KEY (user_id, ref)
    );

    -- Received direct messages marked handled without a reply (dm_ack).
    CREATE TABLE IF NOT EXISTS dm_acks (
      reader      TEXT NOT NULL,
      message_id  INTEGER NOT NULL,
      acked_at    INTEGER NOT NULL,
      PRIMARY KEY (reader, message_id)
    );

    -- Append writes' receipts (#254, src/server/write_dedup.ts): a repeat of
    -- an identical call within the window replays result_json, the first
    -- call's result without its frame, instead of writing again. Pruned on
    -- write per session and nightly (src/server/retention.ts).
    CREATE TABLE IF NOT EXISTS write_receipts (
      session     TEXT NOT NULL,
      sender      TEXT NOT NULL,
      fp          TEXT NOT NULL,
      tool        TEXT NOT NULL,
      ref_kind    TEXT NOT NULL CHECK (ref_kind IN ('message','post')),
      ref_id      INTEGER NOT NULL,
      result_json TEXT NOT NULL,
      at          INTEGER NOT NULL,
      PRIMARY KEY (session, sender, fp)
    );
    CREATE INDEX IF NOT EXISTS idx_write_receipts_at ON write_receipts(at);
  `);
  const oauthColumns: [string, string, string][] = [
    ["oauth_tokens", "access_scopes", "TEXT"],
    ["oauth_codes", "grant_id", "TEXT REFERENCES oauth_grants(id) ON DELETE CASCADE"],
    // The CLI session a login code was redeemed for (#928 D8): a session can't fill grant_id, a grants key.
    ["oauth_codes", "session_id", "INTEGER REFERENCES sessions(id) ON DELETE CASCADE"],
    // The secret a client-credentials run token was minted with (#270 D2), so revoking that secret revokes its tokens.
    ["oauth_tokens", "secret_id", "INTEGER REFERENCES service_credential_secrets(id) ON DELETE CASCADE"],
  ];
  // users.idp_subject (security audit F-13) and idp_issuer (#928 D3): unique as a pair among the users with a subject.
  const userColumns = db.query<{ name: string }, []>(`PRAGMA table_info(users)`).all();
  if (!userColumns.some(c => c.name === "idp_subject")) db.exec(`ALTER TABLE users ADD COLUMN idp_subject TEXT`);
  if (!userColumns.some(c => c.name === "idp_issuer")) {
    db.exec(`ALTER TABLE users ADD COLUMN idp_issuer TEXT`);
    // Once, with the column: every existing subject is Google's, and every subjectless row's email was last proven
    // by Google (or dev login). Never on a later open, which would re-stamp a row unlink-idp cleared.
    db.run("UPDATE users SET idp_issuer = ?", [GOOGLE_ISSUER]);
  }
  // Every open: a rolled-back binary (which knows only Google) links or creates users with a subject and no issuer.
  db.run("UPDATE users SET idp_issuer = ? WHERE idp_issuer IS NULL AND idp_subject IS NOT NULL", [GOOGLE_ISSUER]);
  // Every open, since a rolled-back binary recreates it: one `sub` is not unique across issuers.
  db.exec("DROP INDEX IF EXISTS idx_users_idp_subject");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_idp_identity ON users(idp_issuer, idp_subject) WHERE idp_subject IS NOT NULL");
  for (const [table, column, definition] of oauthColumns) {
    const columns = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
    if (!columns.some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_oauth_codes_grant ON oauth_codes(grant_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_oauth_tokens_secret ON oauth_tokens(secret_id)");
  // dm_send pending: the sender owes a follow-up in the thread. sender_id:
  // the sending session's ID (#284), beside the address it sent as; null for
  // messages from before it, and for writers with no session. kind: 'bounce'
  // for mail returned because its recipient session ended (#284 decision 10).
  const msgCols = db.prepare(`PRAGMA table_info(messages)`).all() as { name: string }[];
  if (!msgCols.some((c) => c.name === "pending")) db.exec(`ALTER TABLE messages ADD COLUMN pending INTEGER NOT NULL DEFAULT 0`);
  if (!msgCols.some((c) => c.name === "sender_id")) db.exec(`ALTER TABLE messages ADD COLUMN sender_id TEXT`);
  if (!msgCols.some((c) => c.name === "kind")) db.exec(`ALTER TABLE messages ADD COLUMN kind TEXT`);
  // delivered_at: when the message was handed to its recipient's harness (#470).
  if (!msgCols.some((c) => c.name === "delivered_at")) db.exec(`ALTER TABLE messages ADD COLUMN delivered_at INTEGER`);
  // via: the child session (a harness subagent, #523) that wrote it under its
  // root's addresses; null for a root's own write.
  if (!msgCols.some((c) => c.name === "via")) db.exec(`ALTER TABLE messages ADD COLUMN via TEXT`);
  // sender_user: the writer's signed-in user (security audit F-10), so a
  // recipient of another user can be told so; null before it and for bounces.
  if (!msgCols.some((c) => c.name === "sender_user")) db.exec(`ALTER TABLE messages ADD COLUMN sender_user TEXT`);
  // human: whether the DM bears the human mark (#1364), judged when it's written: 1 when its sender bore the human
  // mark then (writeSend), 0 for every other DM (a bounce among them); null before it. Never shown on reads (MSG_COLS).
  // Hosted delivery reads no column: adapters mark by the reserved `<email>/human` sender (own-human.ts).
  if (!msgCols.some((c) => c.name === "human")) db.exec(`ALTER TABLE messages ADD COLUMN human INTEGER`);
  // role: 'owner' or 'member' (security audit F-02); null on rows from
  // before it. Read once, by the #927 seed (seedSchema); role_bindings holds
  // ownership since, and nothing reads or writes this column.
  const tmCols = db.prepare(`PRAGMA table_info(team_members)`).all() as { name: string }[];
  if (!tmCols.some((c) => c.name === "role")) db.exec(`ALTER TABLE team_members ADD COLUMN role TEXT`);
  // ip, ua: the client address and user agent of the request that wrote the
  // row (security audit F-19, request_context.ts); null for work no request
  // caused and on rows from before it.
  const logCols = db.prepare(`PRAGMA table_info(access_log)`).all() as { name: string }[];
  if (!logCols.some((c) => c.name === "ip")) db.exec(`ALTER TABLE access_log ADD COLUMN ip TEXT`);
  if (!logCols.some((c) => c.name === "ua")) db.exec(`ALTER TABLE access_log ADD COLUMN ua TEXT`);
  // client_id: the OAuth client of the hosted MCP request that wrote the row (#847); null off /mcp and on older rows.
  if (!logCols.some((c) => c.name === "client_id")) db.exec(`ALTER TABLE access_log ADD COLUMN client_id TEXT`);
}

/**
 * Every access_log row goes in here: it stamps the client address, user agent
 * and OAuth client of the request whose handling wrote it (security audit F-19).
 * NUL and lone surrogates in actor, target and detail's strings are stored as U+FFFD (#807 P3 C7 decision 3), as
 * the Postgres store's pg/audit_row.ts stores them.
 */
export function insertAudit(db: Database, at: number, actor: string | null, action: string, target: string | null, detail: string | null): void {
  const o = requestOrigin();
  db.run("INSERT INTO access_log (at, actor, action, target, detail, ip, ua, client_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [at, textSafeOrNull(actor), action, textSafeOrNull(target), detail === null ? null : jsonTextSafe(detail), o?.ip ?? null, o?.ua ?? null, o?.client_id ?? null]);
}

// #284's seeds, inside the schema transaction. Principals follow users and
// teams on every open (their writers insert them too). Aliases and read
// points come from the 1.x identities, handles and cursors once, on the open
// that creates aliases (`first`): after it, nothing reads or writes those
// tables, and a later seed would bring back an alias deleted since.
// Team ownership (#927) moves from team_members.role into role_bindings
// once, on the open that creates role_bindings (`firstRoles`), for the same
// reason: a later seed would bring back a revoked ownership. An owner is a
// row whose role is 'owner', or, on a row from before roles (F-02), whose role
// is null and whose user created the team. granted_by is null ("seeded") and
// granted_at the join time. It joins users and teams to their principal rows,
// so it runs after the principals seed.
function seedSchema(db: Database, first: boolean, firstRoles: boolean): void {
  db.exec(`
    INSERT OR IGNORE INTO principals (kind, name, user_id, created_at) SELECT 'user', email, id, created_at FROM users;
    INSERT OR IGNORE INTO principals (kind, name, team_id, created_at) SELECT 'team', name, id, created_at FROM teams;
  `);
  if (firstRoles) {
    db.exec(`
      INSERT OR IGNORE INTO role_bindings (principal_id, role, scope_id, granted_by, granted_at)
      SELECT pu.id, 'team_owner', pt.id, NULL, tm.joined_at
        FROM team_members tm
        JOIN principals pu ON pu.kind = 'user' AND pu.user_id = tm.user_id
        JOIN principals pt ON pt.kind = 'team' AND pt.team_id = tm.team_id
       WHERE tm.role = 'owner' OR (tm.role IS NULL AND tm.user_id = (SELECT created_by FROM teams WHERE id = tm.team_id))
       ORDER BY tm.joined_at, tm.team_id, tm.user_id;
    `);
  }
  if (!first) return;
  db.exec(`
    INSERT OR IGNORE INTO aliases (address, scope_kind, scope_ref, name, human, queue_off, created_by_principal, created_at, last_seen)
    SELECT u.email || '/' || i.name, 'person', u.email, i.name, h.human, h.queue_off, u.email, i.created_at, h.last_seen
      FROM identities i JOIN users u ON u.id = i.user_id LEFT JOIN handles h ON h.name = u.email || '/' || i.name;
    INSERT OR IGNORE INTO mailbox_cursors (address, stream_type, stream_ref, last_seen_id)
    SELECT u.email || '/' || i.name, c.stream_type, c.stream_ref, c.last_seen_id
      FROM cursors c JOIN identities i ON i.id = c.identity_id JOIN users u ON u.id = i.user_id;
  `);
}


// Moved to store/errors.ts for the Postgres store; re-exported for http.ts and the tests.
export { AuthorityLost, LastOwner, PrincipalTaken } from "./store/errors.ts";

// The column a write's UNIQUE violation names ("principals.name"), or undefined for any other error. D6 classifies
// Postgres's 23505 by its constraint in P3; on SQLite the message is the only place the column appears.
function uniqueViolation(e: unknown): string | undefined {
  if (!(e instanceof Error) || e.name !== "SQLiteError" || (e as { code?: unknown }).code !== "SQLITE_CONSTRAINT_UNIQUE") return undefined;
  return /^UNIQUE constraint failed: (\S+)$/.exec(e.message)?.[1];
}

// A user row by email, created or renamed, with its principal: one SQLite transaction (nested as a savepoint inside
// the caller's). Shared by users.upsertByEmail and signIn, whose own SQLite transaction stays synchronous.
function upsertUser(db: Database, email: string, displayName: string | null, now: number): User {
  return db.transaction(() => {
    db.run(
      `INSERT INTO users (email, display_name, created_at) VALUES (?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET display_name = excluded.display_name`,
      [email, displayName, now],
    );
    const user = db.query<User, [string]>(`${USER_SQL} WHERE u.email = ?`).get(email)!;
    // A service's row is never a person's (#270 D1): no sign-in or upsert names it, so no IdP subject links to it.
    if (user.kind === "service") throw new PrincipalTaken(email);
    db.run(`INSERT OR IGNORE INTO principals (kind, name, user_id, created_at) VALUES ('user', ?, ?, ?)`, [email, user.id, now]);
    return user;
  })();
}

// A principal's service_invoke binding on a service (#270 D6), one statement driven from the holder's name (?1, kind
// ?2) and the service's (?3): its own binding, and for a user each team principal reached from team_members by user
// (team_members_user, then idx_principals_team), each probing idx_role_bindings_scoped: 1 + the holder's team count
// probes, never a scan of the service's holders (principle 13). CROSS JOIN fixes that order, so the planner can't drive
// from role_bindings (db.test.ts checks the plan). Its own binding first, then the lowest team name: the decision row
// names the same binding every time.
export const INVOKE_BINDING_SQL = `SELECT id, team FROM (
         SELECT b.id AS id, NULL AS team
           FROM principals h CROSS JOIN principals s ON s.name = ?3 AND s.kind = 'service'
           CROSS JOIN role_bindings b ON b.principal_id = h.id AND b.role = 'service_invoke' AND b.scope_id = s.id
          WHERE h.name = ?1 AND h.kind = ?2
         UNION ALL
         SELECT b.id, pt.name
           FROM principals h CROSS JOIN team_members tm ON tm.user_id = h.user_id
           CROSS JOIN principals pt ON pt.team_id = tm.team_id AND pt.kind = 'team'
           CROSS JOIN principals s ON s.name = ?3 AND s.kind = 'service'
           CROSS JOIN role_bindings b ON b.principal_id = pt.id AND b.role = 'service_invoke' AND b.scope_id = s.id
          WHERE ?2 = 'user' AND h.name = ?1 AND h.kind = 'user')
       ORDER BY team IS NOT NULL, team LIMIT 1`;

function makeRepo(db: Database, blobs: BlobStore, attachmentLimits: AttachmentLimits, attachmentUserQuota: number, sessionEnd: () => SessionEndPort, clock: () => number = Date.now): Repo {
  const att = (c: Database, rows: MessageRow[]) => withAttachments(c, "message", rows);
  // Role bindings (#927). Every read and write is one statement on the caller's handle; grant and revoke re-check
  // the granter's authority in their own statement, and revoke holds the last-owner guard, so every writer
  // (the admin routes, `team add --role`, team creation, member removal) gets both. SQLite's single writer serializes
  // them. The Postgres port (store/pg/identity.ts) keeps the statements but not the reasoning: under READ COMMITTED
  // the in-statement re-checks don't exclude a concurrent revoke, so every role-binding writer takes one advisory lock
  // first (D3), and the refusals thrown after a write run in the store's own savepoint.
  const BINDING_SQL = `SELECT b.id, b.principal_id, p.name AS principal, b.role, b.scope_id, s.name AS scope, b.granted_by, g.name AS granter, b.granted_at
    FROM role_bindings b JOIN principals p ON p.id = b.principal_id LEFT JOIN principals s ON s.id = b.scope_id LEFT JOIN principals g ON g.id = b.granted_by`;
  const bindingById = (c: Database, id: number): RoleBinding | undefined =>
    c.query<RoleBinding, [number]>(`${BINDING_SQL} WHERE b.id = ?`).get(id) ?? undefined;
  // The granter's authority as of this statement, `scope` the SQL naming the binding's scope id.
  // Its `n` placeholders all take the granter's user id.
  const authoritySql = (a: RoleAuthority, scope: string): { sql: string; n: number } => {
    const admin = `EXISTS (SELECT 1 FROM role_bindings ga JOIN principals gp ON gp.id = ga.principal_id WHERE gp.kind = 'user' AND gp.user_id = ? AND ga.role = 'org_admin' AND ga.scope_id IS NULL)`;
    const owner = `EXISTS (SELECT 1 FROM role_bindings gt JOIN principals gp ON gp.id = gt.principal_id WHERE gp.kind = 'user' AND gp.user_id = ? AND gt.role = 'team_owner' AND gt.scope_id = ${scope})`;
    return a === "none" ? { sql: "1", n: 0 } : a === "org_admin" ? { sql: admin, n: 1 } : { sql: `(${admin} OR ${owner})`, n: 2 };
  };
  // One binding deleted by ids, if the granter's authority holds, with its role.revoked row carrying the whole
  // binding. A team_owner revoke that leaves a team with members and no owner throws LastOwner (security audit F-02)
  // and rolls back: a sole member may give it up; a team that already has no owner has nothing to guard.
  const revokeBinding = (db: Database, principalId: number, role: string, scopeId: number | null, r: Pick<RoleRevoke, "byUser" | "authority" | "actor" | "audit">): RoleBinding | null =>
    db.transaction(() => {
      const auth = authoritySql(r.authority, "role_bindings.scope_id");
      const before = db.query<RoleBinding, (number | string)[]>(
        `${BINDING_SQL} WHERE b.principal_id = ? AND b.role = ? AND ${scopeId === null ? "b.scope_id IS NULL" : "b.scope_id = ?"}`,
      ).get(...[principalId, role, ...(scopeId === null ? [] : [scopeId])]);
      const gone = db.query<{ id: number }, (number | string | null)[]>(
        `DELETE FROM role_bindings WHERE principal_id = ? AND role = ? AND ${scopeId === null ? "scope_id IS NULL" : "scope_id = ?"} AND ${auth.sql} RETURNING id`,
      ).get(...[principalId, role, ...(scopeId === null ? [] : [scopeId]), ...Array(auth.n).fill(r.byUser)]);
      if (!gone || !before) return null;
      if (role === "team_owner" && scopeId !== null) {
        const c = db.query<{ owners: number; members: number; team: string }, [number, number]>(
          `SELECT (SELECT COUNT(*) FROM role_bindings WHERE scope_id = ? AND role = 'team_owner') AS owners,
                  (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) AS members, t.name AS team
             FROM principals pt JOIN teams t ON t.id = pt.team_id WHERE pt.id = ?`,
        ).get(scopeId, scopeId);
        if (c && c.owners === 0 && c.members > 1) throw new LastOwner(c.team, "team");
      }
      // Every service keeps an owner (#270 D1), with no sole-member exception: the owner is its accountability record.
      // SQLite's single writer serializes this count with any concurrent revoke; the Postgres port takes the role-write
      // advisory lock before the revoke, as for a team's (D3).
      if (role === "service_owner" && scopeId !== null) {
        const c = db.query<{ owners: number; name: string }, [number, number]>(
          `SELECT (SELECT COUNT(*) FROM role_bindings WHERE scope_id = ? AND role = 'service_owner') AS owners, ps.name
             FROM principals ps WHERE ps.id = ? AND ps.kind = 'service'`,
        ).get(scopeId, scopeId);
        if (c && c.owners === 0) throw new LastOwner(c.name, "service");
      }
      insertAudit(db, clock(), r.actor, "role.revoked", before.principal, JSON.stringify({ ...bindingDetail(before), ...r.audit }));
      return before;
    })();
  // Whether a membership change's authority holds on the team (`teamId`), as of the statement it's spliced into: its
  // placeholders take `args`, in order.
  const teamAuthority = (by: MemberAuthority, teamId: number): { sql: string; args: (number | null)[] } => {
    const auth = authoritySql(by.authority, "(SELECT id FROM principals WHERE kind = 'team' AND team_id = ?)");
    return { sql: auth.sql, args: [...Array(auth.n).fill(by.byUser), ...(by.authority === "owner_or_admin" ? [teamId] : [])] };
  };
  const authorityHolds = (db: Database, by: MemberAuthority, teamId: number): boolean => {
    const auth = teamAuthority(by, teamId);
    return !!db.query<{ ok: number }, (number | null)[]>(`SELECT ${auth.sql} AS ok`).get(...auth.args)!.ok;
  };
  const NO_AUTHORITY: MemberRemoval = { byUser: null, authority: "none", actor: null };
  const bindingDetail = (b: RoleBinding) => ({
    binding: b.id, role: b.role, principal: b.principal, principal_id: b.principal_id, scope: b.scope, scope_id: b.scope_id,
    granted_by: b.granted_by, granter: b.granter, granted_at: b.granted_at,
  });
  // The decision's one indexed lookup: the binding id of a user's role, on the org or on a team, if held.
  const roleBinding = (c: Database, userId: number, role: string, teamId: number | null): number | undefined =>
    c.query<{ id: number }, number[] | (number | string)[]>(
      `SELECT b.id FROM role_bindings b JOIN principals p ON p.id = b.principal_id AND p.kind = 'user' AND p.user_id = ?
        WHERE b.role = ? AND ${teamId === null ? "b.scope_id IS NULL" : "b.scope_id = (SELECT id FROM principals WHERE kind = 'team' AND team_id = ?)"}`,
    ).get(...(teamId === null ? [userId, role] : [userId, role, teamId]))?.id;
  // A principal's service_invoke binding on a service (#270 D6): INVOKE_BINDING_SQL.
  const invokeBinding = (c: Database, holder: Principal, service: string): InvokeBinding | undefined =>
    c.query<InvokeBinding, [string, string, string]>(INVOKE_BINDING_SQL).get(holder.name, holder.kind, service) ?? undefined;
  // Whether two users share a team whose policy is one of `policies`: one indexed lookup (principle 11).
  // Whether two users share a team, of one of these policies when given (#807 P3 A7e3: none for shareAny).
  const sharePolicy = (c: Database, userA: number, userB: number, policies?: readonly TeamPolicy[]): boolean =>
    !!c.query<{ x: number }, (number | string)[]>(
      `SELECT 1 AS x FROM team_members a
       JOIN team_members b ON b.team_id = a.team_id AND b.user_id = ?
       ${policies ? `JOIN teams t ON t.id = a.team_id AND t.policy IN (${policies.map(() => "?").join(", ")})` : ""}
       WHERE a.user_id = ? LIMIT 1`,
    ).get(userB, ...(policies ?? []), userA);
  const principalByName = (c: Database, name: string): PrincipalRow | undefined =>
    c.query<PrincipalRow, [string]>("SELECT * FROM principals WHERE name = ?").get(name) ?? undefined;
  // Each changed row tells the observers after its transaction commits (#399); a rollback drops the notice with
  // the change. `null`: any row may have changed (a grant or a user), so observers check every one.
  // An observer with `read` gets each named row's facts too, read on the committing transaction's root Tx in a
  // beforeCommit hook (#807 P3 A7g1): the row's state as it commits, not as it was when the op ran. `pending` and
  // `facts` are per observer, not per transaction, because the write queue runs one body at a time and holds itself
  // from the hook through COMMIT to the notices' flush: no other transaction's marks or notices land in between. A
  // mark deletes its id's facts first, so a notice never sees an earlier transaction's; a notice without facts (a
  // synchronous body's Tx, which refuses the hook, or a failed read) is the observer's to handle.
  type Observer = {
    fn: (changed: string | null, facts?: unknown) => void;
    read?: (tx: Tx, id: string) => Promise<unknown>;
    pending: Set<string>;
    facts: Map<string, unknown>;
  };
  const observers = new Set<Observer>();
  const changed = (id: string | null) => afterCommit(db, () => {
    for (const o of observers) {
      try { o.fn(id, id === null ? undefined : o.facts.get(id)); } catch (error) { console.error("hosted invalidation failed", error); }
    }
  });
  // Queues `id`'s facts read on `tx`'s transaction. Each read runs in its own savepoint and a failure is logged and
  // leaves no facts, so a failed read never fails the commit (on Postgres an unsavepointed failure would abort it).
  const readFacts = (tx: Tx, id: string) => {
    for (const o of observers) {
      const read = o.read;
      if (!read) continue;
      o.facts.delete(id);
      o.pending.add(id);
      try {
        tx.beforeCommit(o, async root => {
          const ids = [...o.pending];
          o.pending.clear();
          for (const each of ids) {
            try { o.facts.set(each, await root.savepoint(t => read(t, each))); }
            catch (error) { console.error("hosted facts read failed", error); }
          }
          // After this transaction's notices (registered before the hook ran): the facts served their flush.
          try { root.afterCommit(() => { for (const each of ids) o.facts.delete(each); }); }
          catch (error) { console.error("hosted facts clear failed", error); }
        });
      } catch { o.pending.delete(id); /* a synchronous body's Tx refuses the hook: its notices carry no facts */ }
    }
  };
  // An async op's notice waits for it to fulfil (#807 P3 A6c): one that rejects changed nothing, as a sync throw didn't.
  const then = <R>(value: R, notify: () => void): R => {
    if (!isThenable(value)) { notify(); return value; }
    return Promise.resolve(value).then(v => { notify(); return v; }) as R;
  };
  const change = <A extends unknown[], R>(fn: (...args: A) => R) => (...args: A): R => then(fn(...args), () => changed(null));
  // Every marked op takes its Tx first.
  const marks = <A extends [Tx, ...unknown[]], R>(fn: (...args: A) => R, id: (...args: A) => string) => (...args: A): R =>
    then(fn(...args), () => { const at = id(...args); readFacts(args[0], at); changed(at); });
  const hosted = makeHostedStore(db, sessionEnd);
  const { ends: _ends, ...hostedStore } = hosted;
  const oauth = makeOAuthStore(hosted);
  // The trigger counter (this connection's commits) and data_version (another connection's) (#853).
  // Two plain statements: a pragma_data_version subselect costs over twice as much per call, and this runs
  // on every cached auth read.
  const counter = db.query<{ n: number }, []>("SELECT n FROM temp.auth_generation");
  const dataVersion = db.query<{ data_version: number }, []>("PRAGMA data_version");
  // SQLite's auth generation source (store/auth_cache.ts, #807 P3 C9a). It changes whenever a committed write touches
  // oauth_tokens, oauth_grants or users, from this connection or another (#853). The counter's part is the value at
  // this connection's last commit (#996), not the live one: while a write body holds a transaction open across an
  // await, other tasks read committed rows (the reader) and must not key a cache entry on the holder's uncommitted
  // bump, which its rollback would undo. The cache bypasses itself for the holder inside its own transaction, whose
  // reads see writes that may yet roll back; the generation is undefined after a failed counter read until the next
  // commit reads it again (uncached rather than stale).
  let committed: number | undefined;
  const readCommitted = () => { try { committed = counter.get()!.n; } catch (error) { committed = undefined; console.error("[grayboard] auth generation read failed:", error); } };
  readCommitted();
  onCommit(db, readCommitted);
  // Outside any transaction the live counter is the committed one, and covers a write that committed without a
  // tracked boundary (an autocommit statement: no hook ran); only while another task's transaction is open does it
  // serve the value the last hook read.
  const readGeneration = () => {
    const n = db.inTransaction ? committed : counter.get()!.n;
    return n === undefined ? undefined : `${n}:${dataVersion.get()!.data_version}`;
  };
  const userById = (c: Database, userId: number) => c.query<User, [number]>(USER_BY_ID_SQL).get(userId) ?? undefined;
  const auth = makeAuthCache(
    { read: readGeneration, ownsTx: () => ownsTx(db), commit: () => ownsTx(db) ? undefined : readGeneration() },
    // The store's uncached read: Repo's oauth.findActiveAccess is the cache's wrapper over it.
    { findActiveAccess: (...a) => oauth.findActiveAccess(...a), userById: async (r, userId) => userById(sqliteOf(r), userId), check: r => { sqliteOf(r); } },
  );
  // One SQL statement per read, on the connection a store read's handle names (sqliteOf(r)).
  const aliasAt = (c: Database, address: string): Alias | undefined =>
    c.query<Alias, [string]>(`SELECT ${ALIAS_COLS} FROM aliases WHERE address = ?`).get(address) ?? undefined;
  const aliasesNamed = (c: Database, name: string): Alias[] =>
    c.query<Alias, [string]>(`SELECT ${ALIAS_COLS} FROM aliases WHERE name = ? ORDER BY address`).all(name);
  const userByEmail = (c: Database, email: string): User | undefined =>
    c.query<User, [string]>(`${USER_SQL} WHERE u.email = ?`).get(email) ?? undefined;
  const teamByName = (c: Database, name: string): Team | undefined =>
    c.query<Team, [string]>("SELECT * FROM teams WHERE name = ?").get(name) ?? undefined;
  // The three team list reads return in id order, on every backend (#807 P3 C3 decision 4): teams by team id, members by
  // user id. Before C3a, teamsOf returned SQLite's membership (rowid) order, so a user's teams can now come back
  // reordered (/api/teams, whoami, hello); the member reads already had id order from the primary key. A Postgres plan
  // promises no order without one.
  const teamsOf = (c: Database, userId: number): Team[] =>
    c.query<Team, [number]>(`SELECT t.* FROM teams t JOIN team_members tm ON tm.team_id = t.id WHERE tm.user_id = ? ORDER BY t.id`).all(userId);
  const isMember = (c: Database, teamId: number, userId: number): boolean =>
    !!c.query<{ x: number }, [number, number]>("SELECT 1 AS x FROM team_members WHERE team_id = ? AND user_id = ?").get(teamId, userId);
  const teamMembers = (c: Database, teamId: number): TeamMember[] =>
    c.query<{ user_id: number; email: string; owner: number }, [number]>(
      `SELECT u.id as user_id, u.email, EXISTS (
         SELECT 1 FROM role_bindings b JOIN principals pu ON pu.id = b.principal_id JOIN principals pt ON pt.id = b.scope_id
          WHERE b.role = 'team_owner' AND pu.kind = 'user' AND pu.user_id = u.id AND pt.kind = 'team' AND pt.team_id = tm.team_id
       ) AS owner FROM users u
       JOIN team_members tm ON tm.user_id = u.id WHERE tm.team_id = ? ORDER BY tm.user_id`,
    ).all(teamId).map(({ owner, ...m }) => ({ ...m, role: owner ? "owner" : "member" }));
  const shareCollaborative = (c: Database, userA: number, userB: number) => sharePolicy(c, userA, userB, ["collaborative", "delegating"]);
  const shareDelegating = (c: Database, userA: number, userB: number) => sharePolicy(c, userA, userB, ["delegating"]);
  const principalOf = (c: Database, address: string): Principal | null => {
    const p = addressParts(address);
    if (!p || p.kind === "bare") return null;
    const name = p.kind === "id"
      ? c.query<{ principal: string | null }, [string]>("SELECT principal FROM ids WHERE id = ?").get(p.address)?.principal
      : p.kind === "alias" ? p.scope : p.name;
    const row = name ? principalByName(c, name) : undefined;
    // team:x names a team, never a service; a person scope (an email) is only a user's.
    if (!row || (p.kind === "team" && row.kind !== "team")) return null;
    if (p.kind === "alias" && (p.scopeKind === "person") !== (row.kind === "user")) return null;
    return { kind: row.kind, name: row.name };
  };
  return {
    now: clock,
    write: <T, R = T>(fn: (tx: Tx) => T | Promise<T>, committed?: (value: T) => R) => queued(db, fn, committed),
    post: <T>(fn: (tx: Tx) => T | Promise<T>, committed?: (value: T) => unknown, what = "write") => posted(db, fn, committed, what),
    read: sqliteRead(db),
    authRead: auth.authRead,
    authPeek: auth.authPeek,
    authGeneration: auth.authGeneration,
    commitGeneration: auth.commitGeneration,

    oauth: { ...oauth, findActiveAccess: auth.findActiveAccess, redeemCode: change(oauth.redeemCode), rotateRefresh: change(oauth.rotateRefresh), revokeToken: change(oauth.revokeToken),
      // A service credential's add, rotate and mint only add authority: no session's shrinks, so they send no change
      // notice (each null notice is a full hosted re-check pass, and mints come per run, #270 audit M-1). The
      // generation trigger on oauth_tokens still clears the access cache. Only the revokes notify.
      revokeServiceCredential: change(oauth.revokeServiceCredential), revokeServiceSecret: change(oauth.revokeServiceSecret) },
    hosted: { ...hostedStore, insert: marks(hosted.insert, (_tx, row) => row.session_id), update: marks(hosted.update, (_tx, id) => id),
      end: marks(hosted.end, (_tx, session) => session), childEnd: marks(hosted.childEnd, (_tx, session) => session),
      park: marks(hosted.park, (_tx, session) => session), unpark: marks(hosted.unpark, (_tx, session) => session),
      subscribe(fn, read) {
        const o: Observer = { fn: fn as Observer["fn"], read, pending: new Set(), facts: new Map() };
        observers.add(o);
        return () => { observers.delete(o); };
      } },
    users: {
      async upsertByEmail(tx, email, displayName) {
        return upsertUser(sqliteOf(tx), email, displayName, clock());
      },
      async signIn(tx, issuer, subject, email, displayName) {
        const db = sqliteOf(tx);
        return db.transaction((): IdpSignIn => {
          // A link is conditional on the row still being unlinked and enabled (D3): on Postgres another sign-in may
          // link it, or an admin disable it, between the read and the write. Zero rows: re-read and decide again.
          const link = (id: number) => db.run(
            `UPDATE users SET idp_issuer = ?, idp_subject = ?, display_name = ?
             WHERE id = ? AND idp_subject IS NULL AND (idp_issuer IS NULL OR idp_issuer = ?) AND disabled_at IS NULL`,
            [issuer, subject, displayName, id, issuer]).changes === 1;
          for (let attempt = 0; attempt < 3; attempt++) {
            // 1. This IdP account's user.
            const bySubject = db.query<User, [string, string]>(`${USER_SQL} WHERE u.idp_issuer = ? AND u.idp_subject = ?`).get(issuer, subject);
            if (bySubject) {
              if (bySubject.email !== email) return { status: "email_changed", user: bySubject };
              db.run("UPDATE users SET display_name = ? WHERE id = ?", [displayName, bySubject.id]);
              return { status: "ok", user: { ...bySubject, display_name: displayName }, linked: false };
            }
            const byEmail = db.query<User, [string]>(`${USER_SQL} WHERE u.email = ?`).get(email);
            // A service's row (#270 D1): no IdP account links to it, whatever the issuer.
            if (byEmail?.kind === "service") return { status: "service", user: byEmail };
            if (byEmail) {
              // 3. Another IdP holds the email, linked or (pre-F-13) not: never a merge by email.
              if (byEmail.idp_issuer !== null && byEmail.idp_issuer !== issuer) return { status: "issuer_mismatch", user: byEmail, issuer: byEmail.idp_issuer };
              // 2. Another account at this IdP holds it.
              if (byEmail.idp_subject !== null) return { status: "subject_mismatch", user: byEmail };
              // A disabled account is refused by the caller: a refused sign-in
              // must not bind it to whoever tried (security audit F-13).
              if (byEmail.disabled_at !== null) return { status: "ok", user: byEmail, linked: false };
              // 4 and 5. This IdP's unlinked row, or a row with neither.
              if (link(byEmail.id)) return { status: "ok", user: { ...byEmail, idp_issuer: issuer, idp_subject: subject, display_name: displayName }, linked: true };
              continue;
            }
            // 6. A new user, created with both.
            const user = upsertUser(db, email, displayName, clock());
            if (link(user.id)) return { status: "ok", user: { ...user, idp_issuer: issuer, idp_subject: subject }, linked: false };
          }
          throw new Error(`sign-in for ${email} kept losing its link to concurrent sign-ins`);
        }).immediate();
      },
      async clearSubject(tx, userId) {
        sqliteOf(tx).run("UPDATE users SET idp_issuer = NULL, idp_subject = NULL WHERE id = ?", [userId]);
      },
      async findByEmail(r, email) { return userByEmail(sqliteOf(r), email); },
      async findById(r, userId) { return userById(sqliteOf(r), userId); },
      isDisabled: auth.isDisabled,
      active: auth.active,
      async setDisabled(tx, userId, disabled) {
        sqliteOf(tx); // refuses a settled Tx or a non-store handle before the savepoint opens
        await tx.savepoint(async sp => {
          const db = sqliteOf(sp);
          const now = clock();
          db.run("UPDATE users SET disabled_at = ? WHERE id = ?", [disabled ? now : null, userId]);
          if (disabled) {
            // CLI tokens too, so enable-user doesn't revive them (security audit F-14).
            db.run("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", [now, userId]);
            await endHostedWhere(hosted, sp, "disabled", now, row => row.user_id === userId);
            db.run("UPDATE oauth_grants SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", [now, userId]);
            db.run("DELETE FROM oauth_browsers WHERE user_id = ?", [userId]);
            db.run("DELETE FROM oauth_codes WHERE user_id = ? AND grant_id IS NULL", [userId]);
          }
        });
        changed(null);
      },
    },

    sessions: {
      async create(tx, userId, tokenHash, label) {
        return insertSession(sqliteOf(tx), userId, tokenHash, label, clock());
      },
      async findByTokenHash(r, hash) {
        return (
          sqliteOf(r).query<Session, [string]>(
            "SELECT * FROM sessions WHERE token_hash = ? AND revoked_at IS NULL",
          ).get(hash) ?? undefined
        );
      },
      // By row, revoked ones included: the caller reads revoked_at (#351).
      async findById(r, sessionId) {
        return sqliteOf(r).query<Session, [number]>("SELECT * FROM sessions WHERE id = ?").get(sessionId) ?? undefined;
      },
      async revoke(tx, sessionId) {
        sqliteOf(tx).run("UPDATE sessions SET revoked_at = ? WHERE id = ?", [clock(), sessionId]);
      },
      async revokeAllForUser(tx, userId) {
        sqliteOf(tx); // refuses a settled Tx or a non-store handle before the savepoint opens
        await tx.savepoint(async sp => {
          const db = sqliteOf(sp);
          const now = clock();
          db.run("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", [now, userId]);
          await endHostedWhere(hosted, sp, "revoked", now, row => row.user_id === userId);
          db.run("UPDATE oauth_grants SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", [now, userId]);
          db.run("DELETE FROM oauth_codes WHERE user_id = ? AND grant_id IS NULL", [userId]);
        });
        changed(null);
      },
      async revokeDev(tx) {
        return sqliteOf(tx).run("UPDATE sessions SET revoked_at = ? WHERE label = ? AND revoked_at IS NULL", [clock(), DEV_SESSION_LABEL]).changes;
      },
      async touch(tx, sessionId, now) {
        sqliteOf(tx).run("UPDATE sessions SET last_used_at = ? WHERE id = ?", [now, sessionId]);
      },
    },

    principals: {
      async findByName(r, name) { return principalByName(sqliteOf(r), name); },
      async of(r, address) { return principalOf(sqliteOf(r), address); },
    },

    aliases: {
      // Insert-if-absent (#807 P3 C5 decision 3): an existing address returns no row, and the body goes on.
      async create(tx, scope, createdBy) {
        const db = sqliteOf(tx);
        const { scope_kind, scope_ref, name } = scope;
        return db.query<Alias, [string, string, string, string, string, number]>(
          `INSERT INTO aliases (address, scope_kind, scope_ref, name, created_by_principal, created_at)
           VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (address) DO NOTHING RETURNING ${ALIAS_COLS}`,
        ).get(`${scope_ref}/${name}`, scope_kind, scope_ref, name, createdBy, clock()) ?? null;
      },
      find: async (r, address) => aliasAt(sqliteOf(r), address),
      // The single writer is the lock: nothing else writes until the body commits.
      lock: async (tx, address) => aliasAt(sqliteOf(tx), address),
      lockScope: async (tx) => { sqliteOf(tx); },
      async listForScope(r, kind, ref) {
        return sqliteOf(r).query<Alias, [string, string]>(
          `SELECT ${ALIAS_COLS} FROM aliases WHERE scope_ref = ? AND scope_kind = ? ORDER BY name`,
        ).all(ref, kind);
      },
      async countForScope(r, kind, ref) {
        return sqliteOf(r).query<{ n: number }, [string, string, string]>(
          `SELECT COUNT(*) AS n FROM aliases WHERE scope_ref = ? AND scope_kind = ? AND name != ?`,
        ).get(ref, kind, HUMAN_NAME)!.n;
      },
      findAllByName: async (r, name) => aliasesNamed(sqliteOf(r), name),
      async seen(r, addresses) {
        const rows = sqliteOf(r).query<{ address: string; last_seen: number; cwd: string | null; place: string | null }, [string]>(
          `SELECT a.address, a.last_seen, i.cwd, i.place FROM aliases a LEFT JOIN ids i ON i.id = ${ALIAS_SESSION_SQL}
            WHERE a.address IN (SELECT value FROM json_each(?)) AND a.last_seen IS NOT NULL`,
        ).all(JSON.stringify(addresses));
        return new Map(rows.map(({ address, ...facts }) => [address, facts]));
      },
      async remove(tx, address) {
        const db = sqliteOf(tx);
        db.transaction(() => {
          db.run("DELETE FROM mailbox_cursors WHERE address = ?", [address]);
          db.run("DELETE FROM aliases WHERE address = ?", [address]);
        })();
      },
      markHuman: async (tx, handle, human) => markHuman(sqliteOf(tx), handle, human),
      isHuman: async (r, handle) => isHuman(sqliteOf(r), handle),
      scopesOf: async (r, addresses) => aliasScopeRows(sqliteOf(r), addresses),
      humansAmong: async (r, handles) => humansAmong(sqliteOf(r), handles),
    },

    bindings: {
      holdsOf: async (r, id) => holdsOf(sqliteOf(r), id),
      async holdsOfMany(r, ids) {
        const out = new Map<string, string[]>(ids.map(id => [id, []]));
        const rows = sqliteOf(r).query<{ id: string; address: string }, [string]>(
          `SELECT id, address FROM alias_holds WHERE id IN (SELECT value FROM json_each(?)) ${HOLD_ORDER}`,
        ).all(JSON.stringify(ids));
        for (const { id, address } of rows) out.get(id)!.push(address);
        return out;
      },
      holderOf: async (r, address) => holderOf(sqliteOf(r), address),
      async holdersOf(r, addresses) {
        const rows = sqliteOf(r).query<{ id: string; address: string }, [string]>(
          `SELECT id, address FROM alias_holds WHERE address IN (SELECT value FROM json_each(?))`,
        ).all(JSON.stringify(addresses));
        return new Map(rows.map(({ id, address }) => [address, id]));
      },
      userOf: async (r, address, exceptPrincipal = null) => aliasUser(sqliteOf(r), address, exceptPrincipal),
      addressSet: async (r, address, principal) => addressSet(sqliteOf(r), address, principal),
      idRow: async (r, id) => idRow(sqliteOf(r), id),
      unendedIds: async (r) => unendedIds(sqliteOf(r)),
      idStatuses: async (r, ids) => idStatuses(sqliteOf(r), ids),
      aliasUses: async (r, principal) => aliasUses(sqliteOf(r), principal),
      async lastSeen(r, handles) {
        const db = sqliteOf(r), out = new Map<string, number>();
        for (const h of new Set(handles)) {
          const at = lastSeen(db, h);
          if (at !== null) out.set(h, at);
        }
        return out;
      },
      async take(tx, address, id, principal, now) {
        const db = sqliteOf(tx);
        // The writer check and the upsert are one method, so a store whose transactions interleave (Postgres, C10a)
        // locks the alias row first and keeps them together. The upsert's WHERE leaves another ID's hold alone.
        if (aliasUser(db, address, principal)) return null;
        return db.query<{ bound_at: number }, [string, string, number]>(
          `INSERT INTO alias_holds (address, id, bound_at)
             VALUES (?1, ?2, MAX(?3, COALESCE((SELECT MAX(bound_at) + 1 FROM alias_holds WHERE id = ?2 AND address != ?1), ?3)))
           ON CONFLICT(address) DO UPDATE SET bound_at = excluded.bound_at WHERE alias_holds.id = excluded.id
           RETURNING bound_at`,
        ).get(address, id, now);
      },
      release: async (tx, address, id) => dropHold(sqliteOf(tx), address, id),
      // A stamp the caller doesn't give is core's default (Date.now), as when the server called core directly.
      log: async (tx, id, name, event, detail = null, at) => logBinding(sqliteOf(tx), id, name, event, detail, at),
      touchAlias: async (tx, address, now) => touchAlias(sqliteOf(tx), address, now),
      touchId: async (tx, id, now) => touchId(sqliteOf(tx), id, now),
      registerId: async (tx, facts) => registerId(sqliteOf(tx), facts),
      setIdFacts: async (tx, id, facts) => setIdFacts(sqliteOf(tx), id, facts),
      setPlace: async (tx, id, place) => setPlace(sqliteOf(tx), id, place),
      setMeta: async (tx, address, meta) => writeAliasMeta(sqliteOf(tx), address, meta),
      viewerIds: async (r) => new Set(sqliteOf(r).query<{ id: string }, []>(`SELECT id FROM ids WHERE viewer = 1`).all().map(({ id }) => id)),
      async idFacts(r, ids) {
        const rows = sqliteOf(r).query<UnboundFacts & { id: string }, [string]>(
          `SELECT id, principal, harness, model, effort, launcher FROM ids WHERE id IN (SELECT value FROM json_each(?))`,
        ).all(JSON.stringify(ids));
        return new Map(rows.map(({ id, ...f }) => [id, f]));
      },
      async setStatus(tx, handle, text, now) {
        const db = sqliteOf(tx);
        touchAlias(db, handle, now);
        return writeStatus(db, handle, text, now);
      },
      setQueueParticipation: async (tx, handle, on) => setQueueParticipation(sqliteOf(tx), handle, on),
    },

    attachments: {
      get: async (r, id) => getAttachment(sqliteOf(r), id),
      unsentDigests: async (r, ids, from) => uploadDigests(sqliteOf(r), ids, from),
      dropUnsent: async (tx, ids, from) => dropUnsentUploads(sqliteOf(tx), ids, from),
      pruneUnbound: async (tx, olderThanMs) => pruneUnbound(sqliteOf(tx), olderThanMs),
      insertUpload: async (tx, upload) => insertUpload(sqliteOf(tx), upload),
      remove: async (tx, id) => removeUpload(sqliteOf(tx), id),
      async dropUnboundOf(tx, uploader) {
        sqliteOf(tx).run(`DELETE FROM attachments WHERE uploader = ? AND message_id IS NULL AND post_id IS NULL`, [uploader]);
      },
      unnamedBlobs: async (r) => unnamedBlobs(sqliteOf(r)),
      named: async (r, sha256) => blobNamed(sqliteOf(r), sha256),
      dropBlobEntry: async (tx, sha256) => dropBlobEntry(sqliteOf(tx), sha256),
    },

    claims: {
      list: async (r, prefix) => listClaims(sqliteOf(r), prefix),
      nextExpiry: async (r) => sqliteOf(r).query<{ next: number | null }, []>(`SELECT MIN(expires_at) AS next FROM claims WHERE board IS NOT NULL`).get()!.next,
      get: async (r, key) => claimRow(sqliteOf(r), key),
      take: async (tx, t) => takeClaim(sqliteOf(tx), t),
      release: async (tx, key, holder, now) => releaseClaim(sqliteOf(tx), key, holder, now),
      recentEvents: async (r, key) => recentClaimEvents(sqliteOf(r), key),
      watchers: async (r, key) => claimWatchers(sqliteOf(r), key),
      liveForWatch: async (tx, key, now) => liveClaim(sqliteOf(tx), key, now),
      addWatch: async (tx, key, handle) => addClaimWatch(sqliteOf(tx), key, handle),
      unwatch: async (tx, key, handle) => removeClaimWatch(sqliteOf(tx), key, handle),
      expire: async (tx, now) => expireClaims(sqliteOf(tx), now),
      logEvent: async (tx, event, handle, c, at, heldBy) => logEvent(sqliteOf(tx), event, handle, c, at, heldBy),
      takeWatchers: async (tx, key) => takeClaimWatchers(sqliteOf(tx), key),
      holderUser: async (r, c) => holderUser(sqliteOf(r), c),
      ackQueue: async (tx, addresses, key, now) => ackQueueClaim(sqliteOf(tx), addresses, key, now),
      heldBy: async (r, holder, now) => sqliteOf(r).query<{ key: string }, [string, number]>(
        `SELECT key FROM claims WHERE holder = ? AND expires_at > ?`).all(holder, now).map(c => c.key),
    },

    delegation: {
      addressUser: async (r, address) => addressUser(sqliteOf(r), address),
      async facts(r, q) {
        const c = sqliteOf(r);
        const open = (h: string) => countOpenDelegations(c, "access_log", h, q.since);
        if (q.to !== undefined) {
          const to = q.to;
          return delegationFacts({ to: { address: to, everConnected: everConnected(c, to), isLauncher: isLauncher(c, to) }, users: new Map([[to, addressUser(c, to)]]), open: new Map([[to, open(to)]]) });
        }
        const list = launchers(c);
        return delegationFacts({ launchers: list, users: new Map(list.map(h => [h, addressUser(c, h)])), open: new Map(list.map(h => [h, open(h)])) });
      },
    },

    boards: {
      get: async (r, name) => getBoard(sqliteOf(r), name),
      post: async (r, id) => getPost(sqliteOf(r), id),
      catalogPage: async (r, cursor) => catalogPage(sqliteOf(r), cursor),
      snapshotPage: async (r, board, opts) => snapshotPage(sqliteOf(r), board, opts),
      pendingPushes: async (r, handle) => pendingPushes(sqliteOf(r), handle),
      pendingDigests: async (r, handle) => pendingDigests(sqliteOf(r), handle),
      acknowledge: async (tx, handle, ref) => acknowledge(sqliteOf(tx), handle, ref),
      ensure: async (tx, name, purpose, scope, createdBy) => ensureBoard(sqliteOf(tx), name, purpose, scope, createdBy),
      isSubscribed: async (r, handle, board) => isSubscribed(sqliteOf(r), handle, board),
      setSubscription: async (tx, handle, board, mode) => setSubscription(sqliteOf(tx), handle, board, mode),
      unsubscribeScope: async (tx, handle, scope) => unsubscribeScope(sqliteOf(tx), handle, scope),
      forget: async (tx, handle) => forgetHandle(sqliteOf(tx), handle),
      prunePosts: async (tx, olderThan) => prunePosts(sqliteOf(tx), olderThan),
      views: async (r, handles, board) => boardViewRows(sqliteOf(r), handles, board),
      openSummaries: async (r) => openSummaryRows(sqliteOf(r)),
      roster: async (r, board) => whoRows(sqliteOf(r), board),
      create: async (tx, b) => insertBoard(sqliteOf(tx), b),
      setArchived: async (tx, name, by, now) => setArchived(sqliteOf(tx), name, by, now),
      read: async (tx, board, handle, opts) => readRows(sqliteOf(tx), board, handle, opts),
      threadRoot: async (r, postId) => threadRoot(sqliteOf(r), postId),
      mute: async (tx, handle, root, muted) => setMute(sqliteOf(tx), handle, root, muted),
      insertPost: async (tx, p) => {
        const db = sqliteOf(tx);
        try {
          return insertPost(db, p);
        } catch (e) {
          // A parent that isn't there fails the posts.parent_id foreign key (the statement alone rolls back).
          if (p.parentId !== null && (e as { code?: string }).code === "SQLITE_CONSTRAINT_FOREIGNKEY" && !getPost(db, p.parentId)) throw new MissingPost(p.parentId, p.board);
          throw e;
        }
      },
      bindAttachments: async (tx, ids, from, postId, limits) => bindAttachments(sqliteOf(tx), ids, from, { post_id: postId }, limits),
      authorAddresses: async (r, author, authorId) => authorAddresses(sqliteOf(r), author, authorId),
      subscribers: async (r, board) => subscriberRows(sqliteOf(r), board),
      threadFacts: async (r, parentId) => threadFacts(sqliteOf(r), parentId),
      laneRows: async (r, board, poster) => queueLaneRows(sqliteOf(r), board, poster),
      claimQueuePost: async (tx, board, postId, lane, now, o) => claimQueuePost(sqliteOf(tx), board, postId, lane, now, o),
      insertOutbox: async (tx, postId, targets) => insertOutbox(sqliteOf(tx), postId, targets),
      redeliveryFacts: async (r, key, prevHolder) => redeliveryFacts(sqliteOf(r), key, prevHolder),
    },

    sessionEnd: {
      // core endSession's first statements (#807 P3 C10d2-a); the single writer is the row's lock.
      async end(tx, id, now) {
        const db = sqliteOf(tx);
        const row = db.query<{ ended_at: number | null; principal: string | null }, [string]>(`SELECT ended_at, principal FROM ids WHERE id = ?`).get(id);
        if (row?.ended_at != null) return null;
        const held = [...new Set(holdsOf(db, id))];
        db.run(`UPDATE ids SET ended_at = ?, held_aliases_json = ? WHERE id = ?`, [now, JSON.stringify(held), id]);
        const children = db.query<{ id: string }, [string]>(`SELECT id FROM ids WHERE root_id = ? AND ended_at IS NULL ORDER BY id`).all(id).map(r => r.id);
        return { principal: row?.principal ?? null, held, children };
      },
      refusal: async (tx, id) => undeliverableId(sqliteOf(tx), id),
      pruneEnded: async (tx, olderThanMs, now) => pruneEndedIds(sqliteOf(tx), olderThanMs, now),
    },

    teams: {
      async create(tx, name, createdBy) {
        const db = sqliteOf(tx);
        // No prior read (D3, #807 P2-3): the UNIQUE names decide, so a principal that lands between a caller's check
        // and this insert is still refused. A team's name is a principal's too, so either constraint means taken.
        return db.transaction(() => {
          const now = clock();
          try {
            const team = db.query<Team, [string, number, number]>(
              "INSERT INTO teams (name, created_by, created_at) VALUES (?, ?, ?) RETURNING *",
            ).get(name, createdBy, now)!;
            db.run(`INSERT INTO principals (kind, name, team_id, created_at) VALUES ('team', ?, ?, ?)`, [name, team.id, now]);
            return team;
          } catch (e) {
            const column = uniqueViolation(e);
            if (column === "principals.name" || column === "teams.name") throw new PrincipalTaken(name);
            throw e;
          }
        })();
      },
      async findByName(r, name) { return teamByName(sqliteOf(r), name); },
      async listForUser(r, userId) { return teamsOf(sqliteOf(r), userId); },
      // Conditional on the actor's authority in its own statement, as roles.grant is; zero rows is an existing member
      // or the authority gone, and a second read says which. SQLite's single writer serializes both with any revoke.
      async addMember(tx, teamId, userId, by = NO_AUTHORITY) {
        const db = sqliteOf(tx);
        const auth = teamAuthority(by, teamId);
        const added = db.run(
          `INSERT OR IGNORE INTO team_members (team_id, user_id, joined_at) SELECT ?, ?, ? WHERE ${auth.sql}`,
          [teamId, userId, clock(), ...auth.args],
        ).changes > 0;
        if (!added && !authorityHolds(db, by, teamId)) throw new AuthorityLost();
        return added;
      },
      // The authority is read once, before any write: the revoke below may delete the very binding it rests on (an
      // owner removing themselves), so a re-check after it would refuse what the decision allowed.
      async removeMember(tx, teamId, userId, by = NO_AUTHORITY) {
        const db = sqliteOf(tx);
        return db.transaction(() => {
          if (!authorityHolds(db, by, teamId)) throw new AuthorityLost();
          // An owner is a member (#927): their binding goes first, through revoke, with its row and the guard.
          const ids = db.query<{ pu: number | null; pt: number | null }, [number, number]>(
            `SELECT (SELECT id FROM principals WHERE kind = 'user' AND user_id = ?) AS pu, (SELECT id FROM principals WHERE kind = 'team' AND team_id = ?) AS pt`,
          ).get(userId, teamId)!;
          const revoked = ids.pu !== null && ids.pt !== null
            ? revokeBinding(db, ids.pu, "team_owner", ids.pt, { byUser: by.byUser, authority: by.authority, actor: by.actor, audit: by.audit })
            : null;
          db.run("DELETE FROM team_members WHERE team_id = ? AND user_id = ?", [teamId, userId]);
          return revoked;
        })();
      },
      async listMembers(r, teamId) { return teamMembers(sqliteOf(r), teamId); },
      async listMemberUserIds(r, teamId) {
        return sqliteOf(r).query<{ user_id: number }, [number]>(
          "SELECT user_id FROM team_members WHERE team_id = ? ORDER BY user_id",
        ).all(teamId).map(row => row.user_id);
      },
      async isMember(r, teamId, userId) { return isMember(sqliteOf(r), teamId, userId); },
      async setPolicy(tx, teamId, policy) {
        const db = sqliteOf(tx);
        return db.transaction(() => {
          const row = db.query<{ policy: string }, [number]>("SELECT policy FROM teams WHERE id = ?").get(teamId);
          if (!row) return null;
          db.run("UPDATE teams SET policy = ? WHERE id = ?", [policy, teamId]);
          return (TEAM_POLICIES as readonly string[]).includes(row.policy) ? row.policy as TeamPolicy : "open";
        })();
      },
      async shareAny(r, userA, userB) { return sharePolicy(sqliteOf(r), userA, userB); },
      async shareCollaborative(r, userA, userB) { return shareCollaborative(sqliteOf(r), userA, userB); },
      async shareDelegating(r, userA, userB) { return shareDelegating(sqliteOf(r), userA, userB); },
    },

    roles: {
      async grant(tx, g) {
        const db = sqliteOf(tx);
        const now = clock();
        const kinds = g.holderKinds.length ? `h.kind IN (${g.holderKinds.map(() => "?").join(", ")})` : "0";
        const scoped = g.scope !== null;
        const auth = authoritySql(g.authority, scoped ? "s.id" : "NULL");
        // The holder and scope by name with their kinds, the membership precondition and the granter's authority,
        // all in the statement's WHERE: zero rows is already held or a failed precondition (D3).
        const sql = `INSERT INTO role_bindings (principal_id, role, scope_id, granted_by, granted_at)
          SELECT h.id, ?, ${scoped ? "s.id" : "NULL"}, (SELECT id FROM principals WHERE name = ?), ?
            FROM principals h ${scoped ? "JOIN principals s ON s.name = ? AND s.kind = ?" : ""}
           WHERE h.name = ? AND ${kinds}
             ${scoped && g.member ? "AND EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id = s.team_id AND tm.user_id = h.user_id)" : ""}
             AND ${auth.sql}
          ON CONFLICT DO NOTHING RETURNING id`;
        const args: (string | number | null)[] = [g.role, g.by, now, ...(scoped ? [g.scope, g.scopeKind] : []), g.holder, ...g.holderKinds, ...Array(auth.n).fill(g.byUser)];
        return db.transaction(() => {
          const row = db.query<{ id: number }, (string | number | null)[]>(sql).get(...args);
          if (!row) return null;
          const b = bindingById(db, row.id)!;
          insertAudit(db, now, g.actor, "role.granted", b.principal, JSON.stringify({ ...bindingDetail(b), ...g.audit }));
          return b;
        })();
      },
      async revoke(tx, r) {
        const db = sqliteOf(tx);
        const ids = db.query<{ pu: number | null; ps: number | null }, (string | null)[]>(
          "SELECT (SELECT id FROM principals WHERE name = ?) AS pu, (SELECT id FROM principals WHERE name = ?) AS ps",
        ).get(r.holder, r.scope)!;
        if (ids.pu === null || (r.scope !== null && ids.ps === null)) return null;
        return revokeBinding(db, ids.pu, r.role, r.scope === null ? null : ids.ps, r);
      },
      async find(r, holder, role, scope) {
        return sqliteOf(r).query<RoleBinding, (string | null)[]>(
          `${BINDING_SQL} WHERE p.name = ? AND b.role = ? AND ${scope === null ? "b.scope_id IS NULL" : "s.name = ?"}`,
        ).get(...(scope === null ? [holder, role] : [holder, role, scope])) ?? undefined;
      },
      async bindingOf(r, userId, role, teamId) { return roleBinding(sqliteOf(r), userId, role, teamId); },
      async invokeBinding(r, holder, service) { return invokeBinding(sqliteOf(r), holder, service); },
      async list(r, f, after, limit) {
        const where = ["b.id > ?"], args: (string | number)[] = [after];
        if (f.role !== undefined) { where.push("b.role = ?"); args.push(f.role); }
        if (f.principal !== undefined) { where.push("p.name = ?"); args.push(f.principal); }
        if (f.scope !== undefined) { where.push("s.name = ?"); args.push(f.scope); }
        return sqliteOf(r).query<RoleBinding, (string | number)[]>(`${BINDING_SQL} WHERE ${where.join(" AND ")} ORDER BY b.id LIMIT ?`).all(...args, limit);
      },
    },

    services: {
      async create(tx, name) {
        const db = sqliteOf(tx);
        return db.transaction(() => {
          const now = clock();
          try {
            const id = db.query<{ id: number }, [string, number]>(
              "INSERT INTO users (email, display_name, created_at) VALUES (?, NULL, ?) RETURNING id",
            ).get(name, now)!.id;
            db.run(`INSERT INTO principals (kind, name, user_id, created_at) VALUES ('service', ?, ?, ?)`, [name, id, now]);
            return userById(db, id)!;
          } catch (e) {
            const column = uniqueViolation(e);
            if (column === "principals.name" || column === "users.email") throw new PrincipalTaken(name);
            throw e;
          }
        })();
      },
      async list(r, after, limit) {
        return sqliteOf(r).query<Omit<ServiceRow, "owners"> & { owners: string }, [number, number]>(
          `SELECT p.id, p.name, p.created_at, u.disabled_at,
                  (SELECT json_group_array(h.name) FROM (SELECT h.name FROM role_bindings b JOIN principals h ON h.id = b.principal_id
                     WHERE b.scope_id = p.id AND b.role = 'service_owner' ORDER BY h.name) h) AS owners
             FROM principals p JOIN users u ON u.id = p.user_id
            WHERE p.kind = 'service' AND p.id > ? ORDER BY p.id LIMIT ?`,
        ).all(after, limit).map((row) => ({ ...row, owners: JSON.parse(row.owners) as string[] }));
      },
      async orphanedBy(r, userId) {
        return sqliteOf(r).query<{ name: string }, [number]>(
          `SELECT s.name FROM role_bindings b
             JOIN principals h ON h.id = b.principal_id AND h.kind = 'user'
             JOIN principals s ON s.id = b.scope_id AND s.kind = 'service'
            WHERE b.role = 'service_owner' AND h.user_id = ?
              AND NOT EXISTS (SELECT 1 FROM role_bindings o JOIN principals oh ON oh.id = o.principal_id JOIN users ou ON ou.id = oh.user_id
                               WHERE o.scope_id = b.scope_id AND o.role = 'service_owner' AND ou.disabled_at IS NULL)
            ORDER BY s.name`,
        ).all(userId).map((row) => row.name);
      },
    },

    messages: {
      async insert(tx, sender, recipientType, recipient, body, parentId, pending = false, files, senderId = null, via = null, senderUser = null, human = false) {
        const db = sqliteOf(tx);
        return db.transaction(() => {
          // Before the insert, as Postgres's classified foreign-key failure refuses it (#807 P3 C5 decision 5).
          if (parentId !== null && !db.query<{ id: number }, [number]>("SELECT id FROM messages WHERE id = ?").get(parentId)) throw new MissingParent(parentId);
          const row = db.query<MessageRow, [string, string | null, string, string, string, number | null, number, number, string | null, string | null, number]>(
            `INSERT INTO messages (sender, sender_id, recipient_type, recipient, body, parent_id, created_at, pending, via, sender_user, human)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${MSG_COLS}`,
          ).get(sender, senderId, recipientType, recipient, body, parentId, clock(), pending ? 1 : 0, via, senderUser, human ? 1 : 0)!;
          const attachments = files ? bindAttachments(db, files.ids, files.uploader, { message_id: row.id }, attachmentLimits) : [];
          return attachments.length ? { ...row, attachments } : row;
        })();
      },
      async getById(r, id) {
        const c = sqliteOf(r);
        return c.query<MessageRow, [number]>(`SELECT ${MSG_COLS} FROM messages WHERE id = ?`).get(id) ?? undefined;
      },
      async writerUsers(r, messageIds, postIds) {
        const c = sqliteOf(r);
        const pairs = (table: "messages" | "posts", column: "sender_user" | "author_user", ids: number[]) => new Map(ids.length === 0 ? [] :
          c.query<{ id: number; user: string }, [string]>(`SELECT id, ${column} AS user FROM ${table} WHERE id IN (SELECT value FROM json_each(?)) AND ${column} IS NOT NULL`)
            .all(JSON.stringify(ids)).map((r) => [r.id, r.user] as const));
        const servicePosts = new Map(postIds.length === 0 ? [] :
          c.query<{ id: number; author: string; board: string; scope: string }, [string]>(
            `SELECT p.id, p.author, p.board, b.scope FROM posts p JOIN boards b ON b.name = p.board
              WHERE p.id IN (SELECT value FROM json_each(?)) AND b.scope LIKE 'service:%'`,
          ).all(JSON.stringify(postIds)).map(({ id, ...f }) => [id, f] as const));
        return { messages: pairs("messages", "sender_user", messageIds), posts: pairs("posts", "author_user", postIds), servicePosts };
      },
      // The delegation.requested row is written in the message's own
      // transaction on the same clock, so a window around created_at bounds
      // the (action, target, at) index scan: access_log isn't pruned, and an
      // unbounded join would read every request a launcher ever got per
      // message (principle 11, #878 audit). The window's width only absorbs
      // a slow transaction or a clock step. CROSS JOIN fixes the order
      // (messages first), so the planner can't drive from access_log by
      // action alone.
      async delegationIds(r, messageIds) {
        const c = sqliteOf(r);
        return new Set(c.query<{ id: number }, [string]>(
          `SELECT m.id FROM messages m
           CROSS JOIN access_log a ON a.action = 'delegation.requested' AND a.target = m.recipient
             AND a.at BETWEEN m.created_at - 60000 AND m.created_at + 60000
             AND json_extract(a.detail, '$.message_id') = m.id
           WHERE m.id IN (SELECT value FROM json_each(?))`,
        ).all(JSON.stringify(messageIds)).map((r) => r.id));
      },
      async bouncesFrom(r, id, since = 0) {
        const c = sqliteOf(r);
        return c.query<MessageRow, [string, number]>(`SELECT ${MSG_COLS} FROM messages WHERE sender = ? AND kind = 'bounce' AND created_at >= ? ORDER BY id`).all(id, since);
      },
      async history(r, addresses, peer, limit = 20, beforeId) {
        const c = sqliteOf(r);
        const set = JSON.stringify(addresses);
        const before = beforeId ?? Number.MAX_SAFE_INTEGER;
        const cap = Math.min(limit, 200);
        if (peer) {
          return att(c, c.query<MessageRow, [string, string, number, number]>(
            `SELECT ${MSG_COLS} FROM messages
             WHERE ((sender IN (SELECT value FROM json_each(?1)) AND recipient = ?2)
                 OR (sender = ?2 AND recipient IN (SELECT value FROM json_each(?1))))
               AND recipient_type = 'user' AND id < ?3
             ORDER BY id DESC LIMIT ?4`,
          ).all(set, peer, before, cap));
        }
        return att(c, c.query<MessageRow, [string, number, number]>(
          `SELECT ${MSG_COLS} FROM messages
           WHERE (sender IN (SELECT value FROM json_each(?1))
               OR (recipient IN (SELECT value FROM json_each(?1)) AND recipient_type = 'user'))
             AND id < ?2
           ORDER BY id DESC LIMIT ?3`,
        ).all(set, before, cap));
      },
      // The whole thread containing message `id`: walk up to its root, then down.
      async thread(r, id) {
        const c = sqliteOf(r);
        return att(c, c.query<MessageRow, [number]>(`
          WITH RECURSIVE up(id, parent_id) AS (
            SELECT id, parent_id FROM messages WHERE id = ?
            UNION ALL
            SELECT m.id, m.parent_id FROM messages m JOIN up ON m.id = up.parent_id
          ),
          tree(id) AS (
            SELECT id FROM up WHERE parent_id IS NULL
            UNION ALL
            SELECT m.id FROM messages m JOIN tree t ON m.parent_id = t.id
          )
          SELECT ${M_MSG_COLS} FROM messages m JOIN tree t ON m.id = t.id ORDER BY m.id ASC
        `).all(id));
      },
      async unreadSince(r, streams) {
        const c = sqliteOf(r);
        if (streams.length === 0) return [];
        const all: MessageRow[] = [];
        for (const s of streams) {
          const colType = s.type === "direct" ? "user" : "team";
          const rows = c.query<MessageRow, [string, string, number]>(
            `SELECT ${MSG_COLS} FROM messages WHERE recipient_type = ? AND recipient = ? AND id > ? ORDER BY id ASC`,
          ).all(colType, s.ref, s.since);
          all.push(...rows);
        }
        all.sort((a, b) => a.id - b.id);
        return att(c, all);
      },
      async queuedTo(r, recipients) {
        const c = sqliteOf(r);
        const rows = c.query<{ recipient: string; n: number }, [string]>(
          QUEUED_TO_SQL,
        ).all(JSON.stringify(recipients));
        return new Map(rows.map((r) => [r.recipient, r.n]));
      },
      async undeliveredFrom(r, senders, olderThan = Number.MAX_SAFE_INTEGER) {
        const c = sqliteOf(r);
        return c.query<{ recipient: string; n: number; oldest_id: number }, [string, number]>(
          UNDELIVERED_FROM_SQL,
        ).all(JSON.stringify(senders), olderThan);
      },
      async receivedUnacked(r, readers, since) {
        const c = sqliteOf(r);
        return att(c, c.query<MessageRow, [string, number]>(
          `SELECT ${M_MSG_COLS} FROM messages m
            WHERE m.recipient_type = 'user' AND m.recipient IN (SELECT value FROM json_each(?)) AND m.sender != m.recipient AND m.created_at >= ?
              AND NOT EXISTS (SELECT 1 FROM dm_acks a WHERE a.reader = m.recipient AND a.message_id = m.id)
            ORDER BY m.id ASC`,
        ).all(JSON.stringify(readers), since));
      },
      async sentPending(r, senders, since) {
        const c = sqliteOf(r);
        return att(c, c.query<MessageRow, [string, number]>(
          SENT_PENDING_SQL,
        ).all(JSON.stringify(senders), since));
      },
      // Only a message that exists: an ack never outlives a retract (Postgres locks the message: FOR KEY SHARE).
      async ack(tx, reader, id) {
        sqliteOf(tx).run("INSERT OR IGNORE INTO dm_acks (reader, message_id, acked_at) SELECT ?, id, ? FROM messages WHERE id = ?", [reader, clock(), id]);
      },
      async markDelivered(tx, id, at) {
        sqliteOf(tx).run("UPDATE messages SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL", [at, id]);
      },
      async retract(tx, sender, id, by) {
        const db = sqliteOf(tx);
        return db.transaction((): RetractResult => {
          const m = db.query<{ recipient: string; read: number; replied: number }, [number, string]>(
            RETRACTABLE_SQL,
          ).get(id, sender);
          if (!m) return "gone";
          if (m.read) return "read";
          if (m.replied) return "replied";
          dropAttachments(db, "message", "?", id);
          db.run("DELETE FROM messages WHERE id = ?", [id]);
          db.run("DELETE FROM dm_acks WHERE message_id = ?", [id]);
          insertAudit(db, clock(), by.actor, "message.retracted", `message:${id}`, JSON.stringify({ message_id: id, sender, recipient: m.recipient, session: by.session }));
          return "retracted";
        })();
      },
      async prune(tx, olderThanMs) {
        const db = sqliteOf(tx);
        // Replies outlive pruned parents as roots; parent_id is a foreign key.
        db.transaction(() => {
          db.run(
            "DELETE FROM dm_acks WHERE message_id IN (SELECT id FROM messages WHERE created_at < ?)",
            [olderThanMs],
          );
          db.run(
            "UPDATE messages SET parent_id = NULL WHERE parent_id IN (SELECT id FROM messages WHERE created_at < ?)",
            [olderThanMs],
          );
          dropAttachments(db, "message", "SELECT id FROM messages WHERE created_at < ?", olderThanMs);
          db.run("DELETE FROM messages WHERE created_at < ?", [olderThanMs]);
        })();
      },
      // A session end's (#807 P3 C10d2-a): core endSession's MailPort statements, which the server's end now calls here.
      unreadFor: async (tx, id) => sqliteOf(tx).query<{ id: number; sender: string }, [string]>(
        `SELECT m.id, m.sender FROM messages m
          WHERE m.recipient_type = 'user' AND m.recipient = ?1 AND m.sender <> ?1
            AND m.id > COALESCE((SELECT last_seen_id FROM mailbox_cursors
                                  WHERE address = ?1 AND stream_type = 'direct' AND stream_ref = ?1), 0)
          ORDER BY m.id`,
      ).all(id),
      // A system DM: never the human mark (#1364). The single writer keeps the parent the end just read.
      bounce: async (tx, from, to, parentId, body, now) => sqliteOf(tx).query<MessageRow, [string, string, string, number, number]>(
        `INSERT INTO messages (sender, sender_id, recipient_type, recipient, body, parent_id, created_at, pending, kind, human)
         VALUES (?1, ?1, 'user', ?2, ?3, ?4, ?5, 0, 'bounce', 0) RETURNING ${MSG_COLS}`,
      ).get(from, to, body, parentId, now),
      async dropReader(tx, id) {
        const db = sqliteOf(tx);
        db.run(`DELETE FROM mailbox_cursors WHERE address = ?`, [id]);
        db.run(`DELETE FROM dm_acks WHERE reader = ?`, [id]);
      },
    },

    coreOn: (h) => sqliteOf(h),
    close: () => { db.close(); },

    cursors: {
      async get(r, address, streamType, streamRef) {
        const row = sqliteOf(r).query<{ last_seen_id: number }, [string, string, string]>(
          "SELECT last_seen_id FROM mailbox_cursors WHERE address = ? AND stream_type = ? AND stream_ref = ?",
        ).get(address, streamType, streamRef);
        return row?.last_seen_id ?? 0;
      },
      async directFor(r, address) {
        const row = sqliteOf(r).query<{ last_seen_id: number }, [string, string]>(
          "SELECT last_seen_id FROM mailbox_cursors WHERE address = ? AND stream_type = 'direct' AND stream_ref = ?",
        ).get(address, address);
        return row?.last_seen_id ?? 0;
      },
      async advance(tx, address, streamType, streamRef, messageId) {
        sqliteOf(tx).run(
          `INSERT INTO mailbox_cursors (address, stream_type, stream_ref, last_seen_id) VALUES (?, ?, ?, ?)
           ON CONFLICT(address, stream_type, stream_ref)
           DO UPDATE SET last_seen_id = MAX(excluded.last_seen_id, mailbox_cursors.last_seen_id)`,
          [address, streamType, streamRef, messageId],
        );
      },
    },

    audit: {
      write(tx, row) {
        const db = sqliteOf(tx);
        // sqliteOf takes a Read: refused here, as on Postgres, before the D4 guard refuses the insert in its own words.
        if (!isTx(tx)) throw new Error(AUDIT_WRITE_ON_READ);
        insertAudit(db, row.at, row.actor, row.action, row.target, row.detail);
      },
      async last(r, action, target) {
        return sqliteOf(r).query<AccessLogRow, [string, string]>(ACCESS_LOG_LAST_SQL).get(action, target) ?? undefined;
      },
      // The single writer serializes every body already.
      async lock(tx) { sqliteOf(tx); },
      async prune(tx, olderThanMs) {
        sqliteOf(tx).run("DELETE FROM access_log WHERE at < ?", [olderThanMs]);
      },
    },

    slack: {
      // The single writer serializes every body already.
      async lock(tx) { sqliteOf(tx); },
      async links(r) {
        const db = sqliteOf(r);
        return db.query<SlackLink, []>(
          "SELECT l.*, u.email FROM slack_links l JOIN users u ON u.id = l.user_id ORDER BY l.user_id",
        ).all();
      },
      async linkFor(r, userId) {
        const db = sqliteOf(r);
        return db.query<SlackLink, [number]>(
          "SELECT l.*, u.email FROM slack_links l JOIN users u ON u.id = l.user_id WHERE l.user_id = ?",
        ).get(userId) ?? undefined;
      },
      async linkBySlackUser(r, slackUser) {
        const db = sqliteOf(r);
        return db.query<SlackLink, [string]>(
          "SELECT l.*, u.email FROM slack_links l JOIN users u ON u.id = l.user_id WHERE l.slack_user = ?",
        ).get(slackUser) ?? undefined;
      },
      async link(tx, userId, slackUser, dmChannel) {
        const db = sqliteOf(tx);
        db.transaction(() => {
          // Threads and progress live in the old account's DM; a new account starts fresh.
          for (const table of ["slack_threads", "slack_progress"]) {
            db.run(
              `DELETE FROM ${table} WHERE user_id = ?
                 AND NOT EXISTS (SELECT 1 FROM slack_links WHERE user_id = ? AND slack_user = ? AND dm_channel = ?)`,
              [userId, userId, slackUser, dmChannel],
            );
          }
          db.run(
            `INSERT INTO slack_links (user_id, slack_user, dm_channel, linked_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(user_id) DO UPDATE SET slack_user = excluded.slack_user, dm_channel = excluded.dm_channel, linked_at = excluded.linked_at`,
            [userId, slackUser, dmChannel, clock()],
          );
        })();
      },
      async unlink(tx, userId) {
        const db = sqliteOf(tx);
        db.transaction(() => {
          db.run("DELETE FROM slack_threads WHERE user_id = ?", [userId]);
          db.run("DELETE FROM slack_progress WHERE user_id = ?", [userId]);
          db.run("DELETE FROM slack_links WHERE user_id = ?", [userId]);
        })();
      },
      async thread(r, userId, kind, board, rootId) {
        const db = sqliteOf(r);
        const row = db.query<SlackThread, [number, string, string, number]>(
          "SELECT thread_ts, kind, board, root_id, peer, last_id FROM slack_threads WHERE user_id = ? AND kind = ? AND board = ? AND root_id = ?",
        ).get(userId, kind, board ?? "", rootId);
        return row ? { ...row, board: row.board || null } : undefined;
      },
      async threadByTs(r, userId, threadTs) {
        const db = sqliteOf(r);
        const row = db.query<SlackThread, [number, string]>(
          "SELECT thread_ts, kind, board, root_id, peer, last_id FROM slack_threads WHERE user_id = ? AND thread_ts = ?",
        ).get(userId, threadTs);
        return row ? { ...row, board: row.board || null } : undefined;
      },
      async addThread(tx, userId, t) {
        const db = sqliteOf(tx);
        db.run(
          `INSERT OR IGNORE INTO slack_threads (user_id, thread_ts, kind, board, root_id, peer, last_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [userId, t.thread_ts, t.kind, t.board ?? "", t.root_id, t.peer, t.last_id],
        );
      },
      async advanceThread(tx, userId, threadTs, id, peer) {
        const db = sqliteOf(tx);
        db.run(
          "UPDATE slack_threads SET peer = CASE WHEN ? IS NOT NULL AND ? > last_id THEN ? ELSE peer END, last_id = MAX(last_id, ?) WHERE user_id = ? AND thread_ts = ?",
          [peer ?? null, id, peer ?? null, id, userId, threadTs],
        );
      },
      async progress(r, userId, ref) {
        const db = sqliteOf(r);
        const row = db.query<{ progress: string }, [number, string]>("SELECT progress FROM slack_progress WHERE user_id = ? AND ref = ?").get(userId, ref);
        return row ? JSON.parse(row.progress) as SlackProgress : undefined;
      },
      async setProgress(tx, userId, ref, progress) {
        const db = sqliteOf(tx);
        db.run(
          `INSERT INTO slack_progress (user_id, ref, progress) VALUES (?, ?, ?)
           ON CONFLICT(user_id, ref) DO UPDATE SET progress = excluded.progress`,
          [userId, ref, jsonTextSafe(JSON.stringify(progress))],
        );
      },
      async clearProgress(tx, userId, ref) {
        const db = sqliteOf(tx);
        db.run("DELETE FROM slack_progress WHERE user_id = ? AND ref = ?", [userId, ref]);
      },
    },

    writeReceipts: {
      async find(r, session, sender, fp, since) {
        return sqliteOf(r).query<WriteReceipt, [string, string, string, number]>(
          "SELECT * FROM write_receipts WHERE session = ? AND sender = ? AND fp = ? AND at > ?",
        ).get(session, sender, fp, since) ?? undefined;
      },
      async claim(tx, key, tool, at) {
        // ref_id 0 names no row; ref_kind only satisfies the column's CHECK until `upsert` fills both.
        return !!sqliteOf(tx).query<{ x: number }, [string, string, string, string, number]>(
          `INSERT INTO write_receipts (session, sender, fp, tool, ref_kind, ref_id, result_json, at) VALUES (?, ?, ?, ?, 'message', 0, '', ?)
           ON CONFLICT(session, sender, fp) DO NOTHING RETURNING 1 AS x`,
        ).get(key.session, key.sender, key.fp, tool, at);
      },
      async reclaim(tx, key, stale, at) {
        return !!sqliteOf(tx).query<{ x: number }, [number, string, string, string, string, number]>(
          `UPDATE write_receipts SET ref_id = 0, result_json = '', at = ?
           WHERE session = ? AND sender = ? AND fp = ? AND ref_kind = ? AND ref_id = ? RETURNING 1 AS x`,
        ).get(at, key.session, key.sender, key.fp, stale.ref_kind, stale.ref_id);
      },
      async upsert(tx, r) {
        sqliteOf(tx).run(
          `INSERT INTO write_receipts (session, sender, fp, tool, ref_kind, ref_id, result_json, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(session, sender, fp) DO UPDATE SET
             tool = excluded.tool, ref_kind = excluded.ref_kind, ref_id = excluded.ref_id, result_json = excluded.result_json, at = excluded.at`,
          [r.session, r.sender, r.fp, r.tool, r.ref_kind, r.ref_id, r.result_json, r.at],
        );
      },
      async refExists(r, kind, id) {
        const table = kind === "message" ? "messages" : "posts";
        return !!sqliteOf(r).query<{ x: number }, [number]>(`SELECT 1 AS x FROM ${table} WHERE id = ?`).get(id);
      },
      async pruneSession(tx, session, before) {
        return sqliteOf(tx).run("DELETE FROM write_receipts WHERE session = ? AND at <= ?", [session, before]).changes;
      },
      async prune(tx, before) {
        return sqliteOf(tx).run("DELETE FROM write_receipts WHERE at <= ?", [before]).changes;
      },
    },

    storage: {
      async reclaimFreePages(maxPages) {
        return reclaimFreePages(db, maxPages);
      },
    },

    blobs,
    attachmentLimits,
    attachmentUserQuota,
  };
}

// A CLI session row: sessions.create's, and a login code's redemption's in its own transaction (#928 D8).
function insertSession(db: Database, userId: number, tokenHash: string, label: string | null, now: number): Session {
  const r = db.run(
    `INSERT INTO sessions (user_id, token_hash, created_at, last_used_at, label) VALUES (?, ?, ?, ?, ?)`,
    [userId, tokenHash, now, now, label],
  );
  return db.query<Session, [number]>("SELECT * FROM sessions WHERE id = ?").get(Number(r.lastInsertRowid))!;
}

// The OAuth store over its handle (#807 P1c-8): each method runs its statements on the connection its `Tx` or `Read`
// names (sqliteOf refuses a settled Tx). The hosted sessions a revoked grant or disabled user ends go through the
// hosted store bound to that same connection (P1c-11).
function makeOAuthStore(hosted: HostedStoreOf): OAuthStore {
  const ops = new WeakMap<Database, OAuthOps>();
  const on = (h: Read): OAuthOps => {
    const db = sqliteOf(h);
    let o = ops.get(db);
    if (!o) ops.set(db, o = oauthOps(db, hosted));
    return o;
  };
  return {
    createRequest: async (tx, ...a) => on(tx).createRequest(...a),
    findRequest: async (r, ...a) => on(r).findRequest(...a),
    bindRequestSession: async (tx, ...a) => on(tx).bindRequestSession(...a),
    createBrowserSession: async (tx, ...a) => on(tx).createBrowserSession(...a),
    findBrowserSession: async (r, ...a) => on(r).findBrowserSession(...a),
    revokeBrowserSession: async (tx, ...a) => on(tx).revokeBrowserSession(...a),
    decideRequest: async (tx, ...a) => on(tx).decideRequest(...a),
    findCodeScopes: async (r, ...a) => on(r).findCodeScopes(...a),
    redeemCode: (tx, ...a) => settledOn(() => on(tx).redeemCode(tx, ...a)),
    redeemLoginCode: async (tx, ...a) => on(tx).redeemLoginCode(...a),
    findRefreshGrant: async (r, ...a) => on(r).findRefreshGrant(...a),
    rotateRefresh: (tx, ...a) => settledOn(() => on(tx).rotateRefresh(tx, ...a)),
    revokeToken: (tx, ...a) => settledOn(() => on(tx).revokeToken(tx, ...a)),
    findActiveAccess: async (r, ...a) => on(r).findActiveAccess(...a),
    isGrantActive: async (r, ...a) => on(r).isGrantActive(...a),
    revokePreBuiltinGrants: (tx, ...a) => settledOn(() => on(tx).revokePreBuiltinGrants(tx, ...a)),
    cleanup: async (tx, ...a) => on(tx).cleanup(...a),
    addServiceCredential: async (tx, ...a) => on(tx).addServiceCredential(...a),
    rotateServiceCredential: async (tx, ...a) => on(tx).rotateServiceCredential(...a),
    revokeServiceCredential: (tx, ...a) => settledOn(() => on(tx).revokeServiceCredential(tx, ...a)),
    revokeServiceSecret: async (tx, ...a) => on(tx).revokeServiceSecret(...a),
    findServiceCredential: async (r, ...a) => on(r).findServiceCredential(...a),
    mintServiceToken: async (tx, ...a) => on(tx).mintServiceToken(...a),
  };
}

// A call's promise, its synchronous throw (a settled Tx, a foreign handle) as a rejection: the five revoking OAuth
// methods are forwarded without an async wrapper, whose extra hop would hold the write queue a tick longer.
function settledOn<T>(f: () => Promise<T>): Promise<T> {
  try { return f(); } catch (e) { return Promise.reject(e); }
}

// The store's methods without their handle, bound to one connection.
// Synchronous: the store wraps each async method's result in a promise. The five that can revoke a grant are the
// store's own async methods, on the caller's Tx: a revoked grant ends its hosted sessions, whose released children's
// IDs end through the async session-end port (#807 P3 C10d2-a).
type OAuthRevokes = "redeemCode" | "rotateRefresh" | "revokeToken" | "revokePreBuiltinGrants" | "revokeServiceCredential";
type OAuthOps = { [K in Exclude<keyof OAuthStore, OAuthRevokes>]: OAuthStore[K] extends (h: never, ...a: infer A) => infer R ? (...a: A) => Awaited<R> : never }
  & Pick<OAuthStore, OAuthRevokes>;
function oauthOps(db: Database, hosted: HostedStoreOf): OAuthOps {
  const createSession = (userId: number, tokenHash: string, label: string | null, now: number) => insertSession(db, userId, tokenHash, label, now);
  const audit = (action: AuditAction, g: OAuthGrant, now: number, detail: Record<string, unknown> = {}) => {
    const user = db.query<{ email: string }, [number]>("SELECT email FROM users WHERE id = ?").get(g.userId);
    insertAudit(db, now, user?.email ?? null, action, g.id, JSON.stringify({ client_id: g.clientId, ...detail }));
  };
  const invalid = { status: "invalid" } as const;
  const missing = { status: "not_found" } as const;
  const ok = <T>(value: T) => ({ status: "ok" as const, value });
  // Whether the user exists and is enabled (and, for `service`, is a service principal). `lock` is true in every write
  // that mints for the user (a grant, a code, a browser session, a CLI session, a credential): on Postgres that read
  // takes FOR SHARE on the users row, so a concurrent disable or revoke-all waits for the mint and then sees its row
  // (postgres-server.md D3, the disable and revoke-all row; src/server/store/pg/oauth.ts). SQLite's single writer
  // already orders the two, so here it only names the call sites.
  const activeUser = (id: number, lock: boolean, kind: "service" | null = null) => {
    void lock;
    return !!(kind === "service"
      ? db.query("SELECT 1 FROM users u JOIN principals p ON p.user_id = u.id AND p.kind = 'service' WHERE u.id = ? AND u.disabled_at IS NULL").get(id)
      : db.query("SELECT 1 FROM users WHERE id = ? AND disabled_at IS NULL").get(id));
  };
  const read = <T>(table: "oauth_requests" | "oauth_browsers" | "oauth_codes", h: string, now: number): T | undefined => {
    if (!lookup(h, now)) return undefined;
    const row = db.query<{ data: string }, [string, number]>(`SELECT data FROM ${table} WHERE hash = ? AND expires_at > ?`).get(h, now);
    return row ? JSON.parse(row.data) as T : undefined;
  };
  const grant = (id: string): OAuthGrant | undefined => {
    const row = db.query<{ data: string; revoked_at: number | null }, [string]>("SELECT data, revoked_at FROM oauth_grants WHERE id = ?").get(id);
    return row ? { ...JSON.parse(row.data), revokedAt: row.revoked_at } : undefined;
  };
  // Mints nothing for the user: a rotation's pair goes under an existing grant, which a disable's revoke sees.
  const live = (g: OAuthGrant | undefined, now: number): g is OAuthGrant =>
    !!g && time(now) && g.revokedAt === null && g.expiresAt > now && activeUser(g.userId, false);
  const insertPair = (p: OAuthTokenPair, id: string, now: number) => {
    for (const [h, kind, expiry] of [[p.accessHash, "access", p.accessExpiresAt], [p.refreshHash, "refresh", p.refreshExpiresAt]] as const) {
      db.run("INSERT INTO oauth_tokens(hash, grant_id, kind, expires_at, created_at, access_scopes) VALUES (?, ?, ?, ?, ?, ?)",
        [h, id, kind, expiry, now, kind === "access" ? JSON.stringify(p.scopes) : null]);
    }
  };
  const revokeGrant = async (sp: Tx, id: string, now: number) => {
    testPause("hosted:revoke:in-txn");
    db.run("UPDATE oauth_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [now, id]);
    await endHostedWhere(hosted, sp, "revoked", now, row => row.grant_id === id);
  };
  // A credential whose grant is live and whose service is enabled (#270 D2).
  const liveCredential = (clientId: string, now: number) => !clientLookup(clientId, now) ? undefined :
    db.query<{ id: number; userId: number; grantId: string; source: CredentialSource; tokenSeconds: number }, [string, number]>(`
      SELECT c.id, c.user_id AS userId, c.grant_id AS grantId, c.source, c.token_seconds AS tokenSeconds FROM service_credentials c
      JOIN oauth_grants g ON g.id = c.grant_id JOIN users u ON u.id = c.user_id
      WHERE c.client_id = ? AND g.revoked_at IS NULL AND g.expires_at > ? AND u.disabled_at IS NULL`).get(clientId, now) ?? undefined;
  type Token = { hash: string; grant_id: string; kind: string; expires_at: number; spent_at: number | null; revoked_at: number | null; created_at: number };
  const token = (h: string) => db.query<Token, [string]>("SELECT * FROM oauth_tokens WHERE hash = ?").get(h);
  const browser = (h: string, now: number, lock: boolean) => {
    const b = read<OAuthBrowserSession>("oauth_browsers", h, now);
    return b && activeUser(b.userId, lock) ? b : undefined;
  };
  // A code row and the checks both redeemers share (#928 D8): the code exists and its binding (client, resource,
  // scopes, redirect, fresh S256 challenge) is the presented one. A spent row (grant_id or session_id set) is the
  // caller's replay; `usable` then checks expiry and the user.
  type CodeRow = { data: string; expires_at: number; grant_id: string | null; session_id: number | null };
  const codeRow = (h: string) => db.query<CodeRow, [string]>("SELECT data, expires_at, grant_id, session_id FROM oauth_codes WHERE hash = ?").get(h);
  const presented = (input: OAuthAuthorization & { codeHash: string }, now: number): { c: OAuthCode; row: CodeRow } | OAuthFailure => {
    if (!lookup(input.codeHash, now)) return invalid;
    const row = codeRow(input.codeHash);
    if (!row) return missing;
    const c: OAuthCode = JSON.parse(row.data);
    return sameAuthorization(c, input) ? { c, row } : invalid;
  };
  // Both redeemers mint for the code's user (a grant, a CLI session), so the user read locks.
  const usable = (c: OAuthCode, row: CodeRow, now: number): OAuthFailure | undefined =>
    row.expires_at <= now ? missing : activeUser(c.userId, true) ? undefined : invalid;
  const liveSession = (id: number) => !!db.query("SELECT 1 FROM sessions WHERE id = ? AND revoked_at IS NULL").get(id);
  const sessionAudit = (action: AuditAction, c: OAuthCode, sessionId: number, now: number, detail: Record<string, unknown> = {}) => {
    const user = db.query<{ email: string }, [number]>("SELECT email FROM users WHERE id = ?").get(c.userId);
    insertAudit(db, now, user?.email ?? null, action, null, JSON.stringify({ client_id: c.clientId, token_session: sessionId, ...detail }));
  };
  // Spends a code by naming what it minted; false when another redeemer spent it first.
  const spendCode = (column: "grant_id" | "session_id", minted: string | number, h: string) =>
    !!db.query<{ hash: string }, [string | number, string]>(
      `UPDATE oauth_codes SET ${column} = ? WHERE hash = ? AND grant_id IS NULL AND session_id IS NULL RETURNING hash`).get(minted, h);
  // A replayed code revokes what it minted: the code leaked, so the grant or session may have too.
  const grantCodeReplay = async (sp: Tx, id: string, now: number) => {
    const g = grant(id);
    if (!g || g.expiresAt <= now) return missing;
    await revokeGrant(sp, g.id, now);
    audit("oauth.code_replay_revoked", g, now, { level: "warning" });
    return { status: "replay" } as const;
  };
  const loginCodeReplay = (c: OAuthCode, sessionId: number, now: number) => {
    db.run("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [now, sessionId]);
    sessionAudit("oauth.code_replay_revoked", c, sessionId, now, { level: "warning" });
    return { status: "replay" } as const;
  };
  const refreshReplay = async (sp: Tx, g: OAuthGrant, now: number) => {
    await revokeGrant(sp, g.id, now);
    audit("oauth.refresh_replay_revoked", g, now, { level: "warning" });
    return { status: "replay" } as const;
  };
  return {
    createRequest(input, now) {
      if (!requestInput(input, now)) return invalid;
      return db.transaction(() => {
        db.run("DELETE FROM oauth_requests WHERE expires_at <= ?", [now]);
        const count = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM oauth_requests WHERE browser_hash = ?").get(input.browserHash)!.n;
        const total = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM oauth_requests").get()!.n;
        if (count >= REQUESTS_PER_BROWSER || total >= REQUESTS_TOTAL) return { status: "capacity" } as const;
        db.run("INSERT INTO oauth_requests(hash, browser_hash, expires_at, data) VALUES (?, ?, ?, ?)", [input.requestHash, input.browserHash, input.expiresAt, JSON.stringify(requestData(input))]);
        return ok(input);
      }).immediate();
    },
    findRequest(requestHash, browserHash, now) {
      const r = read<OAuthRequest>("oauth_requests", requestHash, now);
      return r?.browserHash === browserHash ? r : undefined;
    },
    bindRequestSession(requestHash, browserHash, sessionHash, now) {
      return db.transaction(() => {
        const r = read<OAuthRequest>("oauth_requests", requestHash, now);
        // Binding mints nothing: decideRequest re-reads the session's user, locked, before it inserts the code.
        const b = browser(sessionHash, now, false);
        if (!r || !b) return missing;
        if (r.browserHash !== browserHash || (r.consentSessionHash !== null && r.consentSessionHash !== sessionHash)) return invalid;
        const bound = { ...r, consentSessionHash: sessionHash };
        // Binds once in one statement (D3): a binder racing another browser session for the request loses here.
        const set = db.query<{ hash: string }, [string, string, string, string]>(`UPDATE oauth_requests SET data = ? WHERE hash = ?
          AND coalesce(json_extract(data, '$.consentSessionHash'), ?) = ? RETURNING hash`).get(JSON.stringify(bound), requestHash, sessionHash, sessionHash);
        return set ? ok(bound) : missing;
      }).immediate();
    },
    createBrowserSession(input, now, replaceHash) {
      if (!browserSessionInput(input, now)) return invalid;
      return db.transaction(() => {
        if (!activeUser(input.userId, true)) return invalid;
        db.run("DELETE FROM oauth_browsers WHERE expires_at <= ?", [now]);
        const count = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM oauth_browsers").get()!.n;
        if (count >= BROWSER_SESSIONS) return { status: "capacity" } as const;
        if (replaceHash) db.run("DELETE FROM oauth_browsers WHERE hash = ?", [replaceHash]);
        db.run("INSERT INTO oauth_browsers(hash, user_id, expires_at, data) VALUES (?, ?, ?, ?)", [input.sessionHash, input.userId, input.expiresAt, JSON.stringify(browserData(input))]);
        return ok(input);
      }).immediate();
    },
    findBrowserSession: (h, now) => browser(h, now, false),
    revokeBrowserSession(h) { db.run("DELETE FROM oauth_browsers WHERE hash = ?", [h]); },
    decideRequest(input, now) {
      return db.transaction(() => {
        const r = read<OAuthRequest>("oauth_requests", input.requestHash, now);
        const b = browser(input.sessionHash, now, true);
        if (!r || !b) return missing;
        if (r.browserHash !== input.browserHash || r.csrfHash !== input.csrfHash || r.consentSessionHash !== input.sessionHash) return invalid;
        const c = input.code;
        if (input.approve && !codeInput(r, c, b.userId, now)) return invalid;
        // The delete consumes the request (D3): of two concurrent decisions only one deletes a row.
        if (!db.query<{ hash: string }, [string]>("DELETE FROM oauth_requests WHERE hash = ? RETURNING hash").get(input.requestHash)) return missing;
        if (!input.approve) return ok(null);
        db.run("INSERT INTO oauth_codes(hash, user_id, expires_at, data) VALUES (?, ?, ?, ?)", [c.codeHash, c.userId, c.expiresAt, JSON.stringify(codeData(c))]);
        return ok(c);
      }).immediate();
    },
    findCodeScopes(h, clientId, resource, redirectUri, now) {
      if (!lookup(h, now)) return undefined;
      const row = codeRow(h);
      if (!row) return undefined;
      const c: OAuthCode = JSON.parse(row.data);
      if (c.clientId !== clientId || c.resource !== resource || c.redirectUri !== redirectUri || !activeUser(c.userId, false)) return undefined;
      // A spent code stays findable while what it minted lives, so a replay reaches its redeemer and revokes it.
      if (row.grant_id !== null ? !live(grant(row.grant_id), now) : row.session_id !== null ? !liveSession(row.session_id) : row.expires_at <= now) return undefined;
      return [...c.scopes];
    },
    redeemCode(tx, input, now) {
      return tx.savepoint(async sp => {
        const p = presented(input, now);
        if ("status" in p) return p;
        const { c, row } = p;
        // A login code, spent or not, never becomes a grant (#928 D8).
        if (row.session_id !== null || c.scopes.includes(LOGIN_SCOPE)) return invalid;
        if (row.grant_id !== null) return grantCodeReplay(sp, row.grant_id, now);
        const unusable = usable(c, row, now);
        if (unusable) return unusable;
        if (!grantInput(input, c, now)) return invalid;
        const g: OAuthGrant = { id: input.grantId, userId: c.userId, clientId: c.clientId, resource: c.resource,
          scopes: c.scopes, createdAt: now, expiresAt: input.grantExpiresAt, revokedAt: null };
        db.run("INSERT INTO oauth_grants(id, user_id, expires_at, data) VALUES (?, ?, ?, ?)", [g.id, g.userId, g.expiresAt, JSON.stringify(g)]);
        // The statement that sets grant_id spends the code (D3), so of two concurrent redeemers one wins at any isolation
        // level. The grant goes in first because grant_id references it; a loser withdraws it and answers as a replay, or
        // not_found when the code or the winner's grant is gone.
        if (!spendCode("grant_id", g.id, input.codeHash)) {
          db.run("DELETE FROM oauth_grants WHERE id = ?", [g.id]);
          const winner = codeRow(input.codeHash)?.grant_id;
          return winner ? grantCodeReplay(sp, winner, now) : missing;
        }
        insertPair(input.tokens, g.id, now);
        audit("oauth.grant_issued", g, now);
        return ok({ grant: g, tokens: input.tokens });
      });
    },
    redeemLoginCode(input, now) {
      return db.transaction(() => {
        const p = presented(input, now);
        if ("status" in p) return p;
        const { c, row } = p;
        if (row.grant_id !== null || !isLogin(c)) return invalid;
        if (row.session_id !== null) return loginCodeReplay(c, row.session_id, now);
        const unusable = usable(c, row, now);
        if (unusable) return unusable;
        if (!loginInput(input)) return invalid;
        const session = createSession(c.userId, input.tokenHash, input.label, now);
        // As redeemCode: setting session_id spends the code; a loser withdraws its session and answers as a replay (or not_found).
        if (!spendCode("session_id", session.id, input.codeHash)) {
          db.run("DELETE FROM sessions WHERE id = ?", [session.id]);
          const winner = codeRow(input.codeHash)?.session_id;
          return winner ? loginCodeReplay(c, winner, now) : missing;
        }
        sessionAudit("oauth.session_issued", c, session.id, now);
        return ok({ sessionId: session.id, userId: c.userId });
      }).immediate();
    },
    findRefreshGrant(h, clientId, resource, now) {
      if (!lookup(h, now)) return undefined;
      const row = db.query<{ data: string }, [string, number]>(`
        SELECT g.data FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id JOIN users u ON u.id = g.user_id
        WHERE t.hash = ? AND t.kind = 'refresh' AND g.revoked_at IS NULL AND g.expires_at > ? AND u.disabled_at IS NULL`).get(h, now);
      if (!row) return undefined;
      const g: OAuthGrant = JSON.parse(row.data);
      return g.clientId === clientId && g.resource === resource ? g : undefined;
    },
    async rotateRefresh(tx, input, now) {
      if (!lookup(input.refreshHash, now)) return invalid;
      return tx.savepoint(async sp => {
        testPause("oauth:refresh:in-txn");
        const t = token(input.refreshHash);
        if (!t || t.kind !== "refresh") return missing;
        const g = grant(t.grant_id);
        if (!g || !rotationBinding(g, input)) return invalid;
        if (!live(g, now)) return invalid;
        // A recognized ancestor revokes even after its sliding expiry; tombstones outlive it.
        if (t.spent_at !== null) return refreshReplay(sp, g, now);
        if (t.revoked_at !== null || t.expires_at <= now || !successorInput(input, now)) return invalid;
        const tokens = clampPair(input.tokens, g.expiresAt);
        insertPair(tokens, g.id, now);
        // The statement that sets spent_at spends the token (D3): of two concurrent rotations one wins at any isolation
        // level. The new pair goes in first, as a redeemed code's grant does; a loser withdraws it and re-reads the token.
        const spent = db.query<{ hash: string }, [number, string, number]>(`UPDATE oauth_tokens SET spent_at = ?
          WHERE hash = ? AND kind = 'refresh' AND spent_at IS NULL AND revoked_at IS NULL AND expires_at > ? RETURNING hash`).get(now, input.refreshHash, now);
        if (!spent) {
          db.run("DELETE FROM oauth_tokens WHERE hash IN (?, ?)", [tokens.accessHash, tokens.refreshHash]);
          return token(input.refreshHash)?.spent_at != null ? refreshReplay(sp, g, now) : invalid;
        }
        audit("oauth.refreshed", g, now);
        return ok({ grant: g, tokens });
      });
    },
    async revokeToken(tx, h, clientId, now) {
      if (!lookup(h, now)) return;
      await tx.savepoint(async sp => {
        const t = token(h);
        if (!t) return;
        const g = grant(t.grant_id);
        if (!g || g.clientId !== clientId) return;
        if (t.kind === "refresh") await revokeGrant(sp, g.id, now);
        else db.run("UPDATE oauth_tokens SET revoked_at = ? WHERE hash = ? AND revoked_at IS NULL", [now, h]);
        audit("oauth.revoked", g, now, { kind: t.kind });
      });
    },
    findActiveAccess(h, resource, requiredScopes, now) {
      if (!accessLookup(h, requiredScopes, now)) return undefined;
      // One read snapshot binds token, grant and user liveness.
      // A service credential's source rides the same join (#270 D3), so the cached access carries it. A run token's
      // secret must be live too (a primary-key join, no extra query): on SQLite the secret's revoke revokes its tokens
      // in its transaction, but on Postgres a mint racing that revoke can land a token the revoke didn't see (audit L-1).
      const row = db.query<{ data: string; created_at: number; token_expiry: number; access_scopes: string | null; grant_expiry: number; source: CredentialSource | null }, [string, number, number]>(`
        SELECT g.data, t.created_at, t.expires_at AS token_expiry, t.access_scopes, g.expires_at AS grant_expiry, c.source FROM oauth_tokens t
        JOIN oauth_grants g ON g.id = t.grant_id JOIN users u ON u.id = g.user_id LEFT JOIN service_credentials c ON c.grant_id = g.id
        LEFT JOIN service_credential_secrets s ON s.id = t.secret_id
        WHERE t.hash = ? AND t.kind = 'access' AND t.revoked_at IS NULL AND t.expires_at > ? AND (t.secret_id IS NULL OR s.revoked_at IS NULL)
          AND g.revoked_at IS NULL AND g.expires_at > ? AND u.disabled_at IS NULL`).get(h, now, now);
      if (!row) return undefined;
      const g: OAuthGrant = JSON.parse(row.data);
      // Pre-downscope rows were issued with exactly the full grant scope.
      const accessScopes: string[] = row.access_scopes === null ? g.scopes : JSON.parse(row.access_scopes);
      if (!accessFits(g, accessScopes, resource, requiredScopes)) return undefined;
      const a: OAuthAccess = { tokenHash: h, grantId: g.id, userId: g.userId, clientId: g.clientId,
        resource: g.resource, scopes: accessScopes, createdAt: row.created_at, expiresAt: row.token_expiry, grantExpiresAt: row.grant_expiry,
        source: row.source };
      return a;
    },
    isGrantActive(id, now) {
      if (!time(now)) return false;
      return !!db.query(`SELECT 1 FROM oauth_grants g JOIN users u ON u.id = g.user_id
        WHERE g.id = ? AND g.revoked_at IS NULL AND g.expires_at > ? AND u.disabled_at IS NULL`).get(id, now);
    },
    // Not async: its no-grant run answers with an already-resolved promise, so a boot holds the write queue no longer
    // than before C10d2-a (a request's posted audit row lands as it did).
    revokePreBuiltinGrants(tx, clientIds, now, key = "builtin_clients") {
      if (!time(now)) return Promise.reject(new RangeError("invalid OAuth cutover time"));
      // The key is claimed first: a second run, or on Postgres a second pod booting at once, finds it taken and returns
      // 0 without revoking or auditing anything (postgres-server.md D3, the boot cutover row; pg/oauth.pg.test.ts T-C4-10).
      // Its value is the time of the first run. A run with no grant to revoke writes synchronously, as before C10d2-a,
      // so a boot holds the write queue no longer than it did.
      const ids = JSON.stringify(clientIds);
      const claim = () => !!db.query("INSERT INTO server_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING RETURNING key").get(key, now);
      const dropCodes = () => db.run("DELETE FROM oauth_codes WHERE grant_id IS NULL AND json_extract(data, '$.clientId') IN (SELECT value FROM json_each(?))", [ids]);
      // An operator client could use these IDs before #429; its grants and codes must not
      // become a built-in's (write-capable, refreshed with no secret).
      const live = () => db.query<{ id: string }, [string]>(
        "SELECT id FROM oauth_grants WHERE revoked_at IS NULL AND json_extract(data, '$.clientId') IN (SELECT value FROM json_each(?))").all(ids);
      if (!live().length) {
        try { db.transaction(() => { if (claim()) dropCodes(); })(); } catch (e) { return Promise.reject(e); }
        return Promise.resolve(0);
      }
      return tx.savepoint(async sp => {
        if (!claim()) return 0;
        const grants = live();
        for (const { id } of grants) {
          await revokeGrant(sp, id, now);
          audit("oauth.builtin_client_grant_revoked", grant(id)!, now);
        }
        dropCodes();
        return grants.length;
      });
    },
    cleanup(now) {
      if (!time(now)) throw new RangeError("invalid OAuth cleanup time");
      db.transaction(() => {
        for (const table of ["oauth_requests", "oauth_browsers"]) db.run(`DELETE FROM ${table} WHERE expires_at <= ?`, [now]);
        // A spent login code is kept while its session lives, as a grant code is while its grant does (replay).
        db.run(`DELETE FROM oauth_codes WHERE grant_id IS NULL AND expires_at <= ?
          AND (session_id IS NULL OR session_id NOT IN (SELECT id FROM sessions WHERE revoked_at IS NULL))`, [now]);
        db.run("DELETE FROM oauth_tokens WHERE kind = 'access' AND expires_at <= ?", [now]);
        // A revoked service secret once its last token is gone (#270 D2); an expired credential goes with its grant.
        db.run(`DELETE FROM service_credential_secrets WHERE revoked_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.secret_id = service_credential_secrets.id)`);
        // Keep refresh tombstones until the absolute family deadline, including revoked families.
        db.run("DELETE FROM oauth_grants WHERE expires_at <= ?", [now]);
      }).immediate();
    },
    addServiceCredential(input, now) {
      const { userId, clientId, grantId, resource, source, tokenSeconds, expiresAt, secretHash } = input;
      if (!serviceCredentialInput(input, now)) return invalid;
      return db.transaction(() => {
        // Only an enabled service holds a credential (D1): a person's grant comes from consent, never from here.
        if (!activeUser(userId, true, "service")) return invalid;
        const g: OAuthGrant = { id: grantId, userId, clientId, resource, scopes: [...OAUTH_SCOPES], createdAt: now, expiresAt, revokedAt: null };
        db.run("INSERT INTO oauth_grants(id, user_id, expires_at, data) VALUES (?, ?, ?, ?)", [g.id, g.userId, g.expiresAt, JSON.stringify(g)]);
        const { id } = db.query<{ id: number }, [string, number, string, string, number, number]>(`INSERT INTO service_credentials(client_id, user_id, grant_id, source, token_seconds, created_at)
          VALUES (?, ?, ?, ?, ?, ?) RETURNING id`).get(clientId, userId, grantId, source, tokenSeconds, now)!;
        const secret = db.query<{ id: number }, [number, string, number]>("INSERT INTO service_credential_secrets(credential_id, hash, created_at) VALUES (?, ?, ?) RETURNING id").get(id, secretHash, now)!;
        return ok({ secretId: secret.id });
      }).immediate();
    },
    rotateServiceCredential({ clientId, secretHash }, now) {
      if (!serviceSecretInput({ clientId, secretHash }, now)) return invalid;
      return db.transaction(() => {
        const c = liveCredential(clientId, now);
        if (!c) return missing;
        // At most two live secrets (D2), counted in the insert: on Postgres, after the credential's secrets advisory lock
        // (postgres-server.md D3, the OAuth caps row).
        const secret = db.query<{ id: number }, [number, string, number, number]>(`INSERT INTO service_credential_secrets(credential_id, hash, created_at)
          SELECT ?1, ?2, ?3 WHERE (SELECT COUNT(*) FROM service_credential_secrets WHERE credential_id = ?1 AND revoked_at IS NULL) < ?4
          RETURNING id`).get(c.id, secretHash, now, LIVE_SECRETS);
        return secret ? ok({ secretId: secret.id, userId: c.userId }) : { status: "capacity" } as const;
      }).immediate();
    },
    async revokeServiceCredential(tx, clientId, now) {
      if (!clientLookup(clientId, now)) return invalid;
      return tx.savepoint(async sp => {
        const c = db.query<{ grant_id: string; user_id: number }, [string]>(`SELECT c.grant_id, c.user_id FROM service_credentials c
          JOIN oauth_grants g ON g.id = c.grant_id WHERE c.client_id = ? AND g.revoked_at IS NULL`).get(clientId);
        if (!c) return missing;
        // The grant's revocation ends every session attached to it here, in this transaction (D2, #226 §3.4).
        await revokeGrant(sp, c.grant_id, now);
        return ok({ userId: c.user_id });
      });
    },
    revokeServiceSecret(secretId, now) {
      if (!secretLookup(secretId, now)) return invalid;
      return db.transaction(() => {
        const s = db.query<{ credential_id: number; client_id: string; user_id: number; grant_revoked: number | null }, [number]>(`SELECT s.credential_id, c.client_id, c.user_id,
          g.revoked_at AS grant_revoked FROM service_credential_secrets s JOIN service_credentials c ON c.id = s.credential_id
          JOIN oauth_grants g ON g.id = c.grant_id WHERE s.id = ? AND s.revoked_at IS NULL`).get(secretId);
        if (!s || s.grant_revoked !== null) return missing;
        // The last live secret stays: revoking it would leave a live grant no one can mint under; revoke the credential.
        const others = db.query<{ n: number }, [number, number]>("SELECT COUNT(*) AS n FROM service_credential_secrets WHERE credential_id = ? AND id <> ? AND revoked_at IS NULL").get(s.credential_id, secretId)!.n;
        if (others === 0) return invalid;
        db.run("UPDATE service_credential_secrets SET revoked_at = ? WHERE id = ?", [now, secretId]);
        db.run("UPDATE oauth_tokens SET revoked_at = ? WHERE secret_id = ? AND revoked_at IS NULL", [now, secretId]);
        return ok({ clientId: s.client_id, userId: s.user_id });
      }).immediate();
    },
    findServiceCredential(clientId, now) {
      const c = liveCredential(clientId, now);
      if (!c) return undefined;
      const secrets = db.query<{ id: number; hash: string }, [number]>("SELECT id, hash FROM service_credential_secrets WHERE credential_id = ? AND revoked_at IS NULL ORDER BY id").all(c.id);
      const found: ServiceCredential = { clientId, userId: c.userId, grantId: c.grantId, source: c.source, tokenSeconds: c.tokenSeconds, secrets };
      return found;
    },
    mintServiceToken({ clientId, secretId, tokenHash, scopes: selected, limits }, now) {
      if (!mintInput({ secretId, tokenHash, scopes: selected, limits }, now)) return invalid;
      return db.transaction(() => {
        // One INSERT … SELECT: the credential, its grant, the secret and the service all live, the bucket (mints in the
        // last minute, revoked ones included) and the cap (unexpired, unrevoked tokens) unspent. That holds under
        // SQLite's single writer; at Postgres's READ COMMITTED the counts need the credential's mint advisory lock first,
        // and a token minted past a secret's revoke is refused by findActiveAccess's secret join (postgres-server.md D3,
        // the OAuth caps row).
        // The expiry is the credential's lifetime, clamped to the ceiling and to the grant's expiry.
        const row = db.query<{ expires_at: number }, [string, number, number, string, string, number, number, number, number]>(`
          INSERT INTO oauth_tokens(hash, grant_id, kind, expires_at, created_at, access_scopes, secret_id)
          SELECT ?1, g.id, 'access', MIN(?2 + MIN(c.token_seconds, ?3) * 1000, g.expires_at), ?2, ?4, s.id
          FROM service_credentials c JOIN oauth_grants g ON g.id = c.grant_id JOIN users u ON u.id = c.user_id
          JOIN service_credential_secrets s ON s.credential_id = c.id
          WHERE c.client_id = ?5 AND s.id = ?6 AND s.revoked_at IS NULL AND g.revoked_at IS NULL AND g.expires_at > ?2 AND u.disabled_at IS NULL
            AND (SELECT COUNT(*) FROM oauth_tokens t WHERE t.grant_id = g.id AND t.created_at > ?2 - ?9) < ?7
            AND (SELECT COUNT(*) FROM oauth_tokens t WHERE t.grant_id = g.id AND t.revoked_at IS NULL AND t.expires_at > ?2) < ?8
          RETURNING expires_at`).get(tokenHash, now, limits.maxSeconds, JSON.stringify(selected), clientId, secretId, limits.mintsPerMinute, limits.unexpired, MINT_WINDOW_MS);
        if (!row) {
          const live = liveCredential(clientId, now);
          const secret = live && db.query("SELECT 1 FROM service_credential_secrets WHERE id = ? AND credential_id = ? AND revoked_at IS NULL").get(secretId, live.id);
          return secret ? { status: "capacity" } as const : invalid;
        }
        const g = grant(liveCredential(clientId, now)!.grantId)!;
        audit("oauth.token_issued", g, now, { secret_id: secretId, expires_at: row.expires_at });
        return ok({ expiresAt: row.expires_at });
      }).immediate();
    },
  };
}

// The writes take the body's `Tx` (#807 P1c-11), resolved to its connection before any argument is read, so a
// kept `Tx` is refused whatever the call; the reads take a `Read` the same way (P1c-12).
// `ends`: the store's two ends unwrapped (no change notice), for the users, sessions and OAuth stores' revokes, which
// notify themselves.
type HostedStoreOf = RepoHosted & { ends: HostedEnds };
// `port`: the session end a released child's ID ends through (SessionEndPort), injected by openDatabase's caller.
function makeHostedStore(db: Database, port: () => SessionEndPort): HostedStoreOf {
  // The child IDs ended since the last take, queued at commit by whichever connection ended them (#475 item 1).
  const ended: { list: EndedChild[] } = { list: [] };
  const ops = new WeakMap<Database, HostedWrites>();
  const writesOn = (c: Database): HostedWrites => {
    let o = ops.get(c);
    if (!o) ops.set(c, o = hostedWrites(c, ended));
    return o;
  };
  const on = (tx: Tx): HostedWrites => writesOn(sqliteOf(tx));
  const lockOn = (tx: Tx) => { const conn = sqliteOf(tx); if (!isTx(tx)) throw new Error("a hosted lock needs the body's Tx, not a pool Read"); return conn; };
  const ends = hostedEnds(ended, port);
  const store: HostedStoreOf = {
    ends,
    write: (fn, committed) => queued(db, fn, committed),
    subscribe: () => () => {},
    get: async (r, id) => hostedRow(sqliteOf(r), id),
    // The single writer serializes every body, so the three lock seams lock nothing here (#807 P3 C8 decision 1): `lock`
    // reads the row on the Tx, `lockCapacity` only checks its handle, and `grantLive` reads the grant. Each refuses a
    // pool Read (sqliteOf alone accepts one): on Postgres a lock outside a transaction would be released at once.
    lock: async (tx, id) => hostedRow(lockOn(tx), id),
    async lockCapacity(tx) { lockOn(tx); },
    grantLive: async (tx, grantId, now) => lockOn(tx).query<{ n: number }, [string, number]>(
      "SELECT 1 AS n FROM oauth_grants WHERE id = ? AND revoked_at IS NULL AND expires_at > ?").get(grantId, now) !== null,
    owned: async (r, id) => sqliteOf(r).query<{ n: number }, [string, string]>(
      "SELECT 1 AS n WHERE EXISTS (SELECT 1 FROM hosted_ownerships WHERE session_id = ?1) OR EXISTS (SELECT 1 FROM hosted_sessions WHERE session_id = ?2)",
    ).get(id, id) !== null,
    all: async (r) => sqliteOf(r).query<HostedSession, []>("SELECT * FROM hosted_sessions WHERE parked_at IS NULL").all(),
    counts: async (r, user) => sqliteOf(r).query<{ total: number; user: number }, [number]>(
      "SELECT (SELECT count(*) FROM hosted_sessions WHERE parked_at IS NULL) AS total, (SELECT count(*) FROM hosted_sessions WHERE user_id = ?1 AND parked_at IS NULL) AS user").get(user)!,
    ofOwnership: async (r, ownership) => sqliteOf(r).query<HostedSession, [number]>("SELECT * FROM hosted_sessions WHERE ownership_id = ? AND parked_at IS NULL").all(ownership),
    children: async (r, root) => sqliteOf(r).query<HostedSession, [string]>("SELECT * FROM hosted_sessions WHERE root_session_id = ?").all(root),
    roots: async (r, user) => sqliteOf(r).query<HostedSession, [number]>(
      "SELECT * FROM hosted_sessions WHERE user_id = ? AND +root_session_id IS NULL ORDER BY created_at, session_id").all(user),
    park: async (tx, ...a) => on(tx).park(...a),
    unpark: async (tx, ...a) => on(tx).unpark(...a),
    start: async (tx, ...a) => on(tx).start(...a),
    insert: async (tx, ...a) => on(tx).insert(...a),
    update: async (tx, ...a) => on(tx).update(...a),
    touch: async (tx, ...a) => on(tx).touch(...a),
    // The unary `+` keeps the planner off idx_hosted_root, which every root matches, so these two read
    // idx_hosted_deadline and idx_hosted_user (#399).
    expired: async (r, now) => sqliteOf(r).query<HostedSession, [number]>(
      "SELECT * FROM hosted_sessions WHERE lease_deadline <= ? AND +root_session_id IS NULL").all(now),
    idle: async (r, cutoff) => sqliteOf(r).query<HostedSession, [number]>(`SELECT * FROM hosted_sessions h WHERE h.parked_at IS NULL AND h.last_seen_at < ?
      AND (h.root_session_id IS NOT NULL OR (h.lease_deadline IS NULL AND NOT EXISTS (SELECT 1 FROM alias_holds a WHERE a.id = h.session_id)))`).all(cutoff),
    disabled: async (r) => sqliteOf(r).query<HostedSession, []>(
      "SELECT * FROM hosted_sessions WHERE user_id IN (SELECT id FROM users WHERE disabled_at IS NOT NULL) AND +root_session_id IS NULL").all(),
    childEnd: ends.childEnd,
    takeEnded() {
      const taken = ended.list;
      ended.list = [];
      return taken;
    },
    end: ends.end,
    lose: async (tx, ...a) => on(tx).lose(...a),
    lost: async (r, session, reader) => hostedLostOf(sqliteOf(r))(session, `${LOST_READ[reader]} IS NULL`),
    tellLost: async (tx, ...a) => on(tx).tellLost(...a),
    reportLost: async (tx, ...a) => on(tx).reportLost(...a),
    seeLost: async (tx, ...a) => on(tx).seeLost(...a),
    forgetLost: async (tx, ...a) => on(tx).forgetLost(...a),
    aliveAt: async (r) => sqliteOf(r).query<{ value: number }, []>("SELECT value FROM server_state WHERE key = 'alive_at'").get()?.value,
    heartbeat: async (tx, ...a) => on(tx).heartbeat(...a),
    setRoot: async (tx, id, root) => { sqliteOf(tx).query("UPDATE ids SET root_id = ? WHERE id = ? AND root_id IS NOT ?").run(root, id, root); },
    reopenId: async (tx, id) => { sqliteOf(tx).query("UPDATE ids SET ended_at = NULL, held_aliases_json = NULL WHERE id = ?").run(id); },
    restateWritesAs: async (tx, id, writesAs) => { sqliteOf(tx).query("UPDATE ids SET writes_as = ? WHERE id = ? AND writes_as IS NULL").run(writesAs, id); },
    declareLauncher: async (tx, id) => sqliteOf(tx).query("UPDATE ids SET launcher = 1 WHERE id = ? AND launcher IS NOT 1").run(id).changes > 0,
    launcher: async (r, id) => launcherOf(sqliteOf(r), id),
    holds: async (r) => sqliteOf(r).query<{ id: string; address: string }, []>(`SELECT id, address FROM alias_holds ${HOLD_ORDER}`).all(),
  };
  return store;
}

const launcherOf = (db: Database, id: string) => db.query<{ launcher: number | null }, [string]>("SELECT launcher FROM ids WHERE id = ?").get(id)?.launcher === 1;
const hostedRow = (db: Database, id: string) => db.query<HostedSession, [string]>("SELECT * FROM hosted_sessions WHERE session_id = ?").get(id) ?? undefined;
// The columns a hosted row's update may write (HostedPatch), in a fixed order.
const PATCH_COLUMNS = ["grant_id", "bind_gen", "place", "lease_deadline", "last_seen_at"] as const satisfies readonly (keyof HostedPatch)[];
// The hosted_alias_lost column each reader's take marks (#453).
const LOST_READ: Record<LostReader, string> = { agent: "told_at", controller: "seen_at" };
const hostedLostOf = (db: Database) => (session: string, where: string): HostedLost[] => db.query<{ alias: string; reason: string; was_primary: number }, [string]>(
  `SELECT alias, reason, was_primary FROM hosted_alias_lost WHERE session_id = ? AND ${where} ORDER BY at, rowid`,
).all(session).map(r => ({ alias: r.alias, reason: r.reason, primary: r.was_primary === 1 }));

type HostedWriteName = "park" | "unpark" | "start" | "insert" | "update" | "touch" | "lose" | "tellLost" | "reportLost" | "seeLost" | "forgetLost" | "heartbeat";
// The hosted store's synchronous writes without their handle, bound to one connection.
type HostedWrites = { [K in HostedWriteName]: HostedStore[K] extends (tx: Tx, ...a: infer A) => infer R ? (...a: A) => Awaited<R> : never };
// db.ts hostedWrites' audit: the session's latest ownership names the actor and the client.
function hostedAudit(db: Database, session: string, action: AuditAction, detail: Record<string, unknown>, now: number): void {
  const owner = db.query<{ email: string; client_id: string }, [string]>(`SELECT u.email, o.client_id FROM hosted_ownerships o JOIN users u ON u.id = o.user_id
    WHERE o.session_id = ? ORDER BY o.id DESC LIMIT 1`).get(session);
  insertAudit(db, now, owner?.email ?? null, action, session, JSON.stringify({ ...detail, client_id: owner?.client_id ?? null }));
}

type HostedEnds = Pick<HostedStore, "childEnd" | "end">;
// The hosted store's two ends, on the caller's Tx (#807 P3 C10d2-a): async, since a released child's ID ends through
// the session-end port, the server's end composed over the Repo's groups.
function hostedEnds(ended: { list: EndedChild[] }, port: () => SessionEndPort): HostedEnds {
  // A released child's ID ends in the release's transaction, with its reason (#475 item 1): left unended,
  // nothing owns it, and the next start would end it as a WSS leftover. The ends' wakes wait in `ended`,
  // queued at commit, for the application to run (`takeEnded`). Its id.ended row goes to access_log at `now`.
  const endChild = async (tx: Tx, db: Database, child: string, why: string, now: number) => {
    const audit: EndAuditSink = async (action, actor, target, detail) => insertAudit(db, now, actor, action, target, detail ? JSON.stringify(detail) : null);
    const end = await port().end(tx, child, { why, now, audit });
    if (!end.ended) return;
    const bounces = db.query<MessageRow, [string, number]>(`SELECT ${MSG_COLS} FROM messages WHERE sender = ? AND kind = 'bounce' AND created_at >= ? ORDER BY id`).all(child, now);
    // Queued at commit, so a rolled-back release wakes nobody and bounces nothing.
    afterCommit(db, () => { ended.list.push({ id: child, at: now, wake: end.wake, bounces }); });
  };
  return {
    async childEnd(tx, session, now, reason) {
      const db = sqliteOf(tx);
      const row = hostedRow(db, session);
      // An eviction re-checks the row it ends: a request that woke the child since the sweep's read keeps it (#807 P3 C8).
      if (!row?.root_session_id || (reason === "evicted" && row.parked_at === null)) return;
      db.run("DELETE FROM hosted_sessions WHERE session_id = ?", [session]);
      hostedAudit(db, row.root_session_id, "hosted.child_released", { child: session, reason }, now);
      await endChild(tx, db, session, reason, now);
    },
    async end(tx, session, reason, now, deadline, idleBefore) {
      const db = sqliteOf(tx);
      const row = hostedRow(db, session);
      if (!row || row.root_session_id || (deadline !== undefined && row.lease_deadline !== deadline)) return false;
      // An idle end re-checks idleness on the row it ends: a touch since the sweep's read keeps it (#807 P3 C8).
      if (idleBefore !== undefined && !(row.last_seen_at < idleBefore)) return false;
      testPause(reason === "expired" ? "hosted:lease-expire:in-txn" : "hosted:release:in-txn");
      // The children in start order, whatever order the DELETE returns them in.
      const children = db.query<HostedSession, [number]>("DELETE FROM hosted_sessions WHERE ownership_id = ? RETURNING *").all(row.ownership_id)
        .sort((a, b) => a.created_at - b.created_at || (a.session_id < b.session_id ? -1 : a.session_id > b.session_id ? 1 : 0));
      db.run("UPDATE hosted_ownerships SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL", [now, reason, row.ownership_id]);
      // A hosted root's ID row is never ended (the ID is the store's), so a tools-only root's writes_as would keep the
      // alias in use (aliasUser, aliasUses) after its ownership ends; the next ownership restates it. The
      // launcher flag (#473) is the ownership's too: a resumed session that no longer declares one isn't one. Clearing
      // it is audited as its setting is (#532), so the trail shows when a hosted launcher stopped being one.
      const launcher = db.query<{ launcher: number | null }, [string]>("SELECT launcher FROM ids WHERE id = ?").get(session)?.launcher === 1;
      db.run("UPDATE ids SET writes_as = NULL, launcher = 0 WHERE id = ?", [session]);
      if (launcher) hostedAudit(db, session, "handle.launcher_set", { on: false, ownership: row.ownership_id, reason }, now);
      // Every hold the ownership has, not one name's (#451): ending it releases them all, oldest first (HOLD_ORDER), so
      // its binding events land in the order Postgres writes them (pg/hosted.ts).
      for (const { address } of db.query<{ address: string }, [string]>(`SELECT address FROM alias_holds WHERE id = ? ${HOLD_ORDER}`).all(session)) {
        dropHold(db, address, session);
        logBinding(db, session, address, "released", reason, now);
      }
      for (const child of children) if (child.root_session_id) {
        hostedAudit(db, session, "hosted.child_released", { child: child.session_id, reason }, now);
        await endChild(tx, db, child.session_id, reason, now);
      }
      if (row.lease_deadline !== null) hostedAudit(db, session, "hosted.lease_closed", { reason, ownership: row.ownership_id }, now);
      return true;
    },
  };
}

function hostedWrites(db: Database, ended: { list: EndedChild[] }): HostedWrites {
  const audit = (session: string, action: AuditAction, detail: Record<string, unknown>, now: number) => hostedAudit(db, session, action, detail, now);
  const lostOf = hostedLostOf(db);
  // Marks `where`'s rows' `column` in one statement and returns what it marked, oldest first, so two takers get each row
  // once between them (#807 P3 C8); then deletes the rows both readers took.
  const takeLost = (session: string, where: string, column: string, now: number): HostedLost[] => {
    const taken = db.query<{ alias: string; reason: string; was_primary: number; at: number; seq: number }, [number, string]>(
      `UPDATE hosted_alias_lost SET ${column} = ? WHERE session_id = ? AND ${where} RETURNING alias, reason, was_primary, at, rowid AS seq`,
    ).all(now, session).sort((a, b) => a.at - b.at || a.seq - b.seq);
    if (!taken.length) return [];
    db.run("DELETE FROM hosted_alias_lost WHERE session_id = ? AND told_at IS NOT NULL AND seen_at IS NOT NULL", [session]);
    return taken.map(r => ({ alias: r.alias, reason: r.reason, primary: r.was_primary === 1 }));
  };
  return {
    park(session, now, idleBefore) {
      return db.run("UPDATE hosted_sessions SET parked_at = ? WHERE session_id = ? AND root_session_id IS NOT NULL AND parked_at IS NULL AND last_seen_at < ?",
        [now, session, idleBefore]).changes > 0;
    },
    unpark(session, grant, now) {
      db.run("UPDATE hosted_sessions SET parked_at = NULL, grant_id = ?, last_seen_at = ? WHERE session_id = ?", [grant, now, session]);
    },
    start(session, user, client, now, suggested) {
      const r = db.run("INSERT INTO hosted_ownerships(session_id, user_id, client_id, started_at) VALUES (?, ?, ?, ?)", [session, user, client, now]);
      const id = Number(r.lastInsertRowid);
      audit(session, "hosted.ownership_started", { ownership: id, ...(suggested ? { suggested } : {}) }, now);
      return id;
    },
    insert(row) {
      db.run("INSERT INTO hosted_sessions(session_id, ownership_id, user_id, client_id, grant_id, source_session_id, writes_as, bind_gen, root_session_id, place, lease_deadline, created_at, last_seen_at, suggested) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [row.session_id, row.ownership_id, row.user_id, row.client_id, row.grant_id, row.source_session_id, row.writes_as, row.bind_gen, row.root_session_id, row.place, row.lease_deadline, row.created_at, row.last_seen_at, row.suggested]);
    },
    update(id, patch) {
      // The column names come from this fixed list, never from the patch's keys.
      const cols = PATCH_COLUMNS.filter(c => patch[c] !== undefined);
      if (!cols.length) return;
      db.run(`UPDATE hosted_sessions SET ${cols.map(c => `${c} = ?`).join(", ")} WHERE session_id = ?`, [...cols.map(c => patch[c]!), id]);
    },
    touch(session, now) {
      db.run("UPDATE hosted_sessions SET last_seen_at = ? WHERE session_id = ?", [now, session]);
    },
    lose(session, lost, now) {
      db.run(`INSERT INTO hosted_alias_lost(session_id, alias, reason, was_primary, at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(session_id, alias) DO UPDATE SET reason = excluded.reason, was_primary = excluded.was_primary, at = excluded.at, told_at = NULL, reported_at = NULL, seen_at = NULL`,
        [session, lost.alias, lost.reason, lost.primary ? 1 : 0, now]);
    },
    tellLost: (session, now) => takeLost(session, "told_at IS NULL", "told_at", now),
    reportLost(session, now) {
      db.run("UPDATE hosted_alias_lost SET reported_at = ? WHERE session_id = ? AND seen_at IS NULL AND reported_at IS NULL", [now, session]);
      return lostOf(session, "seen_at IS NULL");
    },
    seeLost: (session, now) => takeLost(session, "seen_at IS NULL AND reported_at IS NOT NULL", "seen_at", now),
    forgetLost(session, alias) {
      db.run("DELETE FROM hosted_alias_lost WHERE session_id = ? AND alias = ?", [session, alias]);
    },
    heartbeat(now) {
      db.run("INSERT INTO server_state(key, value) VALUES ('alive_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [now]);
    },
  };
}

// The repo's own hosted store, never a fresh one: a child's end queues its wakes in that store's `ended`,
// which the application drains (#475 item 1).
// `db`: the connection of the caller's transaction, already resolved from its handle; the candidates are read on it
// too (the same rows `all` reads).
async function endHostedWhere(hosted: HostedStoreOf, tx: Tx, reason: HostedEnd, now: number, predicate: (row: HostedSession) => boolean): Promise<void> {
  const rows = sqliteOf(tx).query<HostedSession, []>("SELECT * FROM hosted_sessions WHERE parked_at IS NULL").all();
  for (const row of rows) if (!row.root_session_id && predicate(row)) await hosted.ends.end(tx, row.session_id, reason, now);
}
