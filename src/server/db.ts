import type { Database } from "bun:sqlite";
import type { EndedChild, HostedStore, HostedSession, HostedEnd, LostReader, HostedLost } from "./hosted-types.ts";
import { testPause } from "../shared/testpause.ts";
import { queueFor } from "./store/queue.ts";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { ALIAS_SESSION_SQL, HOLD_ORDER, setAccess, type CoreDb } from "../core/boards.ts";
import { dropHold, logBinding } from "../core/bindings.ts";
import type { AuditAction } from "./audit.ts";
import { bindAttachments, dropAttachments, withAttachments, type BlobStore, type Uploader } from "../core/attachments.ts";
import { addressParts, type ScopeKind } from "../core/addresses.ts";
import { HUMAN_NAME } from "../shared/addressing.ts";
import type { Principal, Resolver } from "../core/resolver.ts";
import { initCoreSchema } from "../core/schema.ts";
import { countOpenDelegations } from "../core/delegation.ts";
import { endSession, type MailPort } from "../core/session_end.ts";
import type { AuditSink } from "../core/audit.ts";
import { afterCommit, type Boundary, onCommit, openBoundary, openReader, openSqlite, ownsTx, ownWriter, reclaimFreePages, routeReads } from "../core/sqlite.ts";
import type { WriteTx } from "../core/write_tx.ts";
import { type Read, type Tx, sqliteOf, sqliteRead, sqliteTx } from "./store/tx.ts";
import { serverAccess } from "./access.ts";
import type { HumanReach } from "./policy.ts";
import { DEFAULT_ATTACHMENT_LIMITS, DEFAULT_ATTACHMENT_USER_QUOTA, type AttachmentInfo, type AttachmentLimits } from "../shared/attachments.ts";
import { DiskBlobs } from "./blobs.ts";
import { detached, inRequest, requestOrigin } from "./request_context.ts";
import { GOOGLE_ISSUER } from "./idp_google.ts";
import { LOGIN_SCOPE } from "./oauth-config.ts";
import { OAUTH_TTL, type OAuthStore, type OAuthBinding, type OAuthAuthorization, type OAuthRequest, type OAuthBrowserSession, type OAuthCode, type OAuthGrant, type OAuthTokenPair, type OAuthAccess, type OAuthFailure } from "./oauth-types.ts";

// Row types
// idp_issuer + idp_subject: the IdP that proved the user's email and its stable
// account ID there (Google `sub`), keyed together (security audit F-13, #928
// D3). Both: linked. Issuer only: a pre-F-13 row, reserved for that IdP.
// Neither: a dev-auth user, or one an admin unlinked.
export type User     = { id: number; email: string; display_name: string | null; created_at: number; disabled_at: number | null; idp_issuer: string | null; idp_subject: string | null };
// What an IdP sign-in resolved to (security audit F-13, #928 D4). `linked`: the
// user had no subject yet and now has this one. Refusals: `subject_mismatch`,
// the email's user belongs to another account at the same IdP (the email was
// reassigned); `issuer_mismatch`, the email's user belongs to another IdP
// (`issuer`, the one holding it); `email_changed`, this IdP account's user has
// another email.
export type IdpSignIn =
  | { status: "ok"; user: User; linked: boolean }
  | { status: "subject_mismatch" | "email_changed"; user: User }
  | { status: "issuer_mismatch"; user: User; issuer: string };
// The label `grayboard login --dev` sessions carry: a server started without dev auth revokes them (#805 F-04).
export const DEV_SESSION_LABEL = "dev";
export type Session  = { id: number; user_id: number; token_hash: string; created_at: number; last_used_at: number; revoked_at: number | null; label: string | null };
// An alias (#284): a name in a scope, `<scope_ref>/<name>`. A person scope's
// ref is the user's email; a team or service scope's is the principal's name.
export type Alias = { id: number; address: string; scope_kind: ScopeKind; scope_ref: string; name: string; created_at: number };
// A scope owner (#284 decision 5): a user (name = email), a team or a service principal.
export type PrincipalRow = { id: number; kind: Principal["kind"]; name: string; user_id: number | null; team_id: number | null; parent_id: number | null; created_at: number };

export type Team     = { id: number; name: string; created_by: number; policy: string; created_at: number };
// A team's wake policy (#806): 'open' (the default) isolates members' agents
// from each other's wakes, as from anyone's; 'collaborative' grants members'
// agents a wake across users (vision.md principle 9); 'delegating' (#256)
// is collaborative and also lets a member's session name another member's
// launcher in `delegate`'s `to`.
export type TeamPolicy = "open" | "collaborative" | "delegating";
export const TEAM_POLICIES: readonly TeamPolicy[] = ["open", "collaborative", "delegating"];
// attachments: present on reads when the message carries files.
// delivered_at: when it was handed to the recipient's harness; null until then, and for mail delivered before the column.
// via: the child session (a harness subagent, #523) that wrote it under its root's addresses; null for a root's own write.
export type MessageRow = { id: number; sender: string; recipient_type: "user" | "team"; recipient: string; body: string; parent_id: number | null; created_at: number; delivered_at: number | null; pending: number; kind: "bounce" | null; via: string | null; attachments?: AttachmentInfo[] };
// A message's files: upload ids and the uploader they must belong to (#391).
export type MessageFiles = { ids: number[]; uploader: Uploader };
// Only a direct message's sender and recipient can see it, its thread, or
// the files it carries. One you're not in reads as missing, so its existence
// doesn't leak. `me`: every address the caller reads as (#284 S8).
export function participant(m: MessageRow | undefined, me: string[]): m is MessageRow {
  return !!m && m.recipient_type === "user" && (me.includes(m.sender) || me.includes(m.recipient));
}
// A user's Slack link: their member ID and their DM with the bridge's app.
export type SlackLink = { user_id: number; email: string; slack_user: string; dm_channel: string; linked_at: number };
// thread_ts: the Slack top-level message. root_id: the grayboard thread's root
// (message id for dm, post id for board). peer: the other party in a dm.
// last_id: the newest grayboard id in the thread, the parent for a reply.
export type SlackThread = { thread_ts: string; kind: "dm" | "board"; board: string | null; root_id: number; peer: string | null; last_id: number };
export type AccessLogRow = { at: number; actor: string | null; action: string; target: string | null; detail: string | null };
// An append write's receipt (#254, src/server/write_dedup.ts): which row the
// first call made and the result it answered, so a repeat replays it.
export type WriteReceipt = {
  session: string; sender: string; fp: string; tool: string;
  ref_kind: "message" | "post"; ref_id: number; result_json: string; at: number;
};
export type WriteReceiptKey = Pick<WriteReceipt, "session" | "sender" | "fp">;

// A message's columns as readers see them. sender_id (#284) is the sending
// session's provenance, kept in the database and left out of reads and pushes;
// via (#523) is shown, since it names a child writer its root's address hides.
const MSG_COLS = `id, sender, recipient_type, recipient, body, parent_id, created_at, delivered_at, pending, kind, via`;
const M_MSG_COLS = `m.id, m.sender, m.recipient_type, m.recipient, m.body, m.parent_id, m.created_at, m.delivered_at, m.pending, m.kind, m.via`;
const ALIAS_COLS = `id, address, scope_kind, scope_ref, name, created_at`;

// A synchronous callback's result: a promise is refused at compile time, so
// nothing can await between a transaction's reads and its writes.
export type Sync<T> = T extends PromiseLike<unknown> ? never : T;

// A top-level write transaction, through db's write queue. `committed` runs after the commit and before the queue's
// next body (D4: in-memory state a transaction reads changes only inside one or right after its commit, never in
// the gap before its caller resumes). Its result is boxed, so a promise it returns doesn't hold the queue.
// fn may await (#807 P1b-4e): the transaction stays open, and the queue held, until its promise settles; it commits
// on fulfilment and rolls back on rejection. Meanwhile other tasks read committed state on the reader and their
// writes wait in the queue (core/sqlite.ts ownWriter).
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
    if (!isThenable(out)) return settle(out as T);
    // Reactions attached here run as the holder (the queue's context follows them), so the commit is the writer's.
    return Promise.resolve(out).then(settle, fail);
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

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  v !== null && (typeof v === "object" || typeof v === "function") && typeof (v as { then?: unknown }).then === "function";

// Core's shared writes (attachment store/release/sweep, claim expiry, #807 D4) through repo's write queue, each body
// given the connection its queued body's `Tx` resolves to (P1c-15c-2). Core's bodies are synchronous, so the cast
// only restates that.
export function queuedTx(repo: Repo): WriteTx {
  return <T>(fn: (db: CoreDb) => T) => repo.write((tx: Tx) => fn(repo.coreOn(tx)) as Sync<T>) as Promise<T>;
}

// queuedTx, plus the core-shaped guard (`() => void`) core calls inside those bodies (attachment store and release):
// it runs the server's `guard` on the body's own `Tx` (#1053), so the check reads the writer, not a second pool
// connection. Bodies are synchronous and the queue runs one at a time, so one `body` slot serves them all.
export function queuedGuardTx(repo: Repo, guard?: (r: Read) => void): { tx: WriteTx; guard?: () => void } {
  let body: Tx | undefined;
  const tx: WriteTx = <T>(fn: (db: CoreDb) => T) => repo.write((t: Tx) => {
    body = t;
    try { return fn(repo.coreOn(t)) as Sync<T>; } finally { body = undefined; }
  }) as Promise<T>;
  return { tx, guard: guard && (() => {
    if (!body) throw new Error("an attachment guard ran outside its transaction body");
    guard(body);
  }) };
}

// A write no caller waits for (an audit row, a closing session's last-seen touch, a lapsed lease's settle; #807 P1b-4b),
// for code that can't await: a sync finally, a timer, a sync check on the request path. It runs as its own transaction
// when the caller holds the queue outside one (its committed callback, its afterCommit flush), or through the queue:
// now when it's idle and fn is synchronous, else when fn settles or after the bodies ahead of it. Inside an open
// transaction it refuses (#807 P3 A3): a write that belongs to a body goes on that body's Tx. fn may be async, except
// from the holder: the holder resumes while fn awaits, so a thenable there rolls fn back and throws. True when it ran
// now (its error, and committed's, thrown), false when it waits or awaits; a failure then is logged as `what` failed.
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
  // another body or awaits, its failure then logged as `what` failed. It refuses inside an open transaction (a body's
  // write goes on its Tx). A promise `committed` returns is caught and its rejection logged as `what` failed on every
  // branch (#1051). fn may be async (#807 P3 A3), except from the queue's holder; its Tx is live until fn settles.
  post<T>(fn: (tx: Tx) => T | Promise<T>, committed?: (value: T) => unknown, what?: string): boolean;
  // The store's read handle outside any transaction (#807 P1c): reads committed state.
  read: Read;
  // Runs fn, which writes none of the generation's tables, with the auth cache's generation read once for its whole
  // body (#881): one authorization's token and user reads share it. Inside the caller's own transaction, nested, or
  // with no generation to read, it's plain fn().
  authRead<T>(fn: () => Sync<T>): T;
  // The auth cache's generation: authRead's pinned one inside its body, else read now; undefined inside the caller's
  // own transaction. Another task's open transaction doesn't move it: it reflects commits only (#996). Equal values
  // mean no committed write to oauth_tokens, oauth_grants or users from this connection, and no commit at all from
  // another, came between them (#899).
  authGeneration(): string | undefined;
  oauth: OAuthStore;
  hosted: HostedStore;
  users: {
    upsertByEmail(tx: Tx, email: string, displayName: string | null): Promise<User>;
    // An IdP sign-in: matches (issuer, subject) first, then the email (F-13, #928 D4).
    signIn(tx: Tx, issuer: string, subject: string, email: string, displayName: string | null): Promise<IdpSignIn>;
    // Forgets a user's IdP issuer and subject, so the next sign-in with the email, from any IdP, links its account.
    clearSubject(tx: Tx, userId: number): Promise<void>;
    findByEmail(email: string): User | undefined;
    findById(userId: number): User | undefined;
    // findById(id)?.disabled_at != null, cached on authGeneration (#853).
    isDisabled(userId: number): boolean;
    // The user's email while it exists and isn't disabled, cached on authGeneration (#853).
    activeEmail(userId: number): string | undefined;
    setDisabled(tx: Tx, userId: number, disabled: boolean): Promise<void>;
  };
  sessions: {
    create(tx: Tx, userId: number, tokenHash: string, label: string | null): Promise<Session>;
    findByTokenHash(r: Read, hash: string): Promise<Session | undefined>;
    findById(r: Read, sessionId: number): Promise<Session | undefined>;
    revoke(tx: Tx, sessionId: number): Promise<void>;
    revokeAllForUser(tx: Tx, userId: number): Promise<void>;
    // Revokes every live dev-auth session (`grayboard login --dev`); returns how many.
    revokeDev(tx: Tx): Promise<number>;
    touch(tx: Tx, sessionId: number, now: number): Promise<void>;
  };
  principals: {
    findByName(name: string): PrincipalRow | undefined;
  };
  // Who an address acts for (#284 S12): an ID's registering user, an
  // alias's scope owner, a team broadcast's team.
  resolver: Resolver;
  // Names in scopes, keyed by address.
  aliases: {
    // createdBy: the principal that made it (the binder's user for a lazy create).
    create(tx: Tx, scope: { scope_kind: ScopeKind; scope_ref: string; name: string }, createdBy: string): Alias;
    find(r: Read, address: string): Alias | undefined;
    listForScope(r: Read, kind: ScopeKind, ref: string): Alias[];
    // The scope's names less the Slack link's human, for the cap (#347).
    countForScope(r: Read, kind: ScopeKind, ref: string): number;
    // Every scope's alias of this name.
    findAllByName(r: Read, name: string): Alias[];
    // When each of these addresses was last used, and the cwd or place of the
    // session that holds or last held it (ALIAS_SESSION_SQL); unused ones are absent.
    seen(r: Read, addresses: string[]): Map<string, { last_seen: number; cwd: string | null; place: string | null }>;
    // Also deletes the alias's read points.
    remove(tx: Tx, address: string): void;
  };
  teams: {
    // Inserts the team's principal in the same transaction; throws
    // PrincipalTaken if another principal has the name.
    create(tx: Tx, name: string, createdBy: number): Team;
    findByName(name: string): Team | undefined;
    listForUser(userId: number): Team[];
    // Adds a member with an explicit role; an existing member is left as is
    // (false). Roles change through setRole.
    addMember(tx: Tx, teamId: number, userId: number, role?: TeamRole): boolean;
    // Both throw LastOwner rather than leave a team with members and no
    // owner (security audit F-02); the check and the write share one
    // transaction. A team that already has no owner isn't guarded.
    removeMember(tx: Tx, teamId: number, userId: number): void;
    // The member's previous role, or null when it isn't a member.
    setRole(tx: Tx, teamId: number, userId: number, role: TeamRole): TeamRole | null;
    isOwner(teamId: number, userId: number): boolean;
    listMembers(teamId: number): { user_id: number; email: string; role: TeamRole }[];
    listMemberUserIds(teamId: number): number[];
    isMember(teamId: number, userId: number): boolean;
    // The previous policy, or null when the team is gone.
    setPolicy(tx: Tx, teamId: number, policy: TeamPolicy): TeamPolicy | null;
    // Whether two users share a team whose policy is 'collaborative' or
    // 'delegating': the grant under which one's agents may wake the other's (#806).
    shareCollaborative(userA: number, userB: number): boolean;
    // Whether two users share a team whose policy is 'delegating': the grant
    // under which one's session may delegate to the other's launcher (#256).
    shareDelegating(userA: number, userB: number): boolean;
  };
  messages: {
    // files: unbound uploads (ids) of their uploader (the sending session's
    // address set, #284 PR 4 S5, and its user, #367), bound in the insert's
    // transaction (a refused id throws CoreError and nothing is written);
    // the ids and their uploader travel together, so the type requires one
    // with the other (#391). senderId: the sending session's ID (#284); null
    // for a writer with no session. via: the child session that wrote it
    // (#523), else null. senderUser: the writer's signed-in user (security
    // audit F-10), kept out of reads like sender_id.
    insert(
      tx: Tx, sender: string, recipientType: "user" | "team", recipient: string, body: string, parentId: number | null, pending?: boolean,
      files?: MessageFiles, senderId?: string | null, via?: string | null, senderUser?: string | null,
    ): MessageRow;
    // The writer's signed-in user of each message and post that has one
    // recorded (rows from before F-10, bounces and system posts have none).
    writerUsers(r: Read, messageIds: number[], postIds: number[]): { messages: Map<number, string>; posts: Map<number, string> };
    // Which of these messages `delegate` wrote: each has a delegation.requested row targeting its recipient (#256).
    delegationIds(r: Read, messageIds: number[]): Set<number>;
    // The row alone, without its attachments: an access or ack check.
    getById(r: Read, id: number): MessageRow | undefined;
    // The bounces an ended session's end sent (#284 decision 4): an ID ends once.
    // since: only an end's own bounces, made at or after its time (a reopened ID can end again, #475).
    bouncesFrom(r: Read, id: string, since?: number): MessageRow[];
    // A session's direct messages, sent or received by any of its addresses
    // (#284 S8): with peer, only those between the set and peer.
    history(r: Read, addresses: string[], peer?: string, limit?: number, beforeId?: number): MessageRow[];
    thread(r: Read, id: number): MessageRow[];
    unreadSince(r: Read, streams: { type: "direct" | "team"; ref: string; since: number }[]): MessageRow[];
    // Direct messages to each of recipients still past its cursor, sent by
    // someone else; recipients with none are absent.
    queuedTo(r: Read, recipients: string[]): Map<string, number>;
    // Direct messages from any of senders still past each recipient's cursor, per recipient.
    undeliveredFrom(r: Read, senders: string[], olderThan?: number): { recipient: string; n: number; oldest_id: number }[];
    // Direct messages to any of readers since `since` that their recipient hasn't acked, oldest first.
    receivedUnacked(r: Read, readers: string[], since: number): MessageRow[];
    // Direct messages from any of senders since `since` sent pending and not acked by their sender, oldest first.
    sentPending(r: Read, senders: string[], since: number): MessageRow[];
    ack(tx: Tx, reader: string, id: number): void;
    // A launcher's delegation requests since `since` it hasn't taken (#252, countOpenDelegations).
    openDelegations(r: Read, launcher: string, since: number): number;
    // Stamps delivered_at on a direct message handed to its recipient's harness; the first stamp stands.
    markDelivered(tx: Tx, id: number, at: number): void;
    // Deletes a direct message from sender that's past the recipient's cursor
    // and has no reply. False if any of that doesn't hold. Audited as
    // message.retracted in the delete's transaction (#306), as local's
    // retractMessage is, so every caller writes the row a repeat is answered from.
    retract(tx: Tx, sender: string, id: number, by: { actor: string | null; session: string | null }): boolean;
    prune(tx: Tx, olderThanMs: number): void;
  };
  // An ended session's mail, as core endSession reaches it (#284 decision 4), on the body's `Tx` (#807 P1c-14):
  // core's MailPort names no handle, so the port is bound to the connection the `Tx` resolves to.
  mailOn(tx: Tx): MailPort;
  // The connection a handle resolves to, for core helpers that take a `db` (#807 P1c-15b; D1 keeps core's signatures until
  // P3 forks it): a body's `Tx` inside one, `repo.read` outside. Resolved at the call, so a settled `Tx` is refused there.
  coreOn(h: Read): CoreDb;
  // Closes the database: the reader, then the writer (#807 P1c-15c-2: the server holds no raw connection to close).
  close(): void;
  // Read points (#284), keyed by the reading address: how far it has
  // received a stream (its direct messages, stream_ref = the address itself).
  cursors: {
    get(r: Read, address: string, streamType: "direct" | "team", streamRef: string): Promise<number>;
    // How far an address has received its direct messages.
    directFor(r: Read, address: string): Promise<number>;
    advance(tx: Tx, address: string, streamType: "direct" | "team", streamRef: string, messageId: number): Promise<void>;
  };
  audit: {
    write(tx: Tx, row: AccessLogRow): void;
    // The most recent row for this action+target, for dedup windows and
    // "has this happened recently" checks. Undefined when none exists.
    last(r: Read, action: string, target: string): AccessLogRow | undefined;
    prune(tx: Tx, olderThanMs: number): void;
  };
  slack: {
    links(r: Read): Promise<SlackLink[]>;
    // Synchronous for now (#807 P3 A6b): helloOkFields reads it in application.hostedSession, whose callers (hosted
    // reconcile, the delivery lease's committed callback) are synchronous, and core's delegation fallback calls it.
    linkFor(r: Read, userId: number): SlackLink | undefined;
    linkBySlackUser(r: Read, slackUser: string): Promise<SlackLink | undefined>;
    // Replaces the user's earlier link, if any.
    link(tx: Tx, userId: number, slackUser: string, dmChannel: string): Promise<void>;
    // Also forgets the user's thread map.
    unlink(tx: Tx, userId: number): Promise<void>;
    thread(r: Read, userId: number, kind: "dm" | "board", board: string | null, rootId: number): Promise<SlackThread | undefined>;
    threadByTs(r: Read, userId: number, threadTs: string): Promise<SlackThread | undefined>;
    addThread(tx: Tx, userId: number, t: SlackThread): Promise<void>;
    // Moves a thread's reply target forward, never back; a DM item's sender becomes its peer (#524).
    advanceThread(tx: Tx, userId: number, threadTs: string, id: number, peer?: string): Promise<void>;
    // How far an outbound item got in Slack, keyed by its grayboard ref
    // ("dm:<message id>" or "post:<post id>"); cleared once it's done.
    progress(r: Read, userId: number, ref: string): Promise<unknown>;
    setProgress(tx: Tx, userId: number, ref: string, progress: unknown): Promise<void>;
    clearProgress(tx: Tx, userId: number, ref: string): Promise<void>;
  };
  writeReceipts: {
    // The receipt for (session, sender, fp) written after `since`.
    find(r: Read, session: string, sender: string, fp: string, since: number): Promise<WriteReceipt | undefined>;
    // Takes (session, sender, fp) for a write about to run, as a placeholder the write's `upsert` fills in the same
    // transaction; false when a receipt for it exists (D3: one statement, so of two identical calls one claims it).
    claim(tx: Tx, key: WriteReceiptKey, tool: string, at: number): Promise<boolean>;
    // Takes over the receipt for `key` only while it still names `stale` (a row since retracted or pruned, #306);
    // false when another call replaced it first.
    reclaim(tx: Tx, key: WriteReceiptKey, stale: { ref_kind: "message" | "post"; ref_id: number }, at: number): Promise<boolean>;
    // Replaces any receipt for the same (session, sender, fp).
    upsert(tx: Tx, r: WriteReceipt): Promise<void>;
    // Whether the row a receipt names still exists (a retract or retention removes it).
    refExists(r: Read, kind: "message" | "post", id: number): Promise<boolean>;
    // Deletes receipts written at or before `before`: one session's, or all. Returns how many.
    pruneSession(tx: Tx, session: string, before: number): Promise<number>;
    prune(tx: Tx, before: number): Promise<number>;
  };
  // The database file's free pages (#137).
  storage: {
    // Returns up to `maxPages` (> 0) free pages to the filesystem with
    // `PRAGMA incremental_vacuum`. A file without auto_vacuum=INCREMENTAL
    // (created before #170) reclaims nothing until a one-time VACUUM converts it.
    reclaimFreePages(maxPages: number): { reclaimed: number; remaining: number; incremental: boolean };
  };
  // Attachment bytes, by sha256; the attachment rows are metadata in this database.
  blobs: BlobStore;
  // The server's per-file and per-message caps; insert binds files under them.
  attachmentLimits: AttachmentLimits;
  // The bytes of attachments one user may store, sent or not.
  attachmentUserQuota: number;
}

// `now` is the hub's clock (application.ts): rows, audit and write receipts read one clock, so a test clock moves them together (#297).
export type OpenOptions = { blobDir: string; humanReach?: HumanReach; attachmentLimits?: AttachmentLimits; attachmentUserQuota?: number; now?: () => number };

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

// retract: the sender's message, still unread and unanswered. Exported for
// the same EXPLAIN pin.
export const RETRACTABLE_SQL = `SELECT recipient FROM messages WHERE id = ? AND sender = ? AND recipient_type = 'user'
               AND id > COALESCE((SELECT last_seen_id FROM mailbox_cursors
                                   WHERE address = messages.recipient AND stream_type = 'direct' AND stream_ref = messages.recipient), 0) AND delivered_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.parent_id = messages.id)`;

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
    initSchema(d);
    initCoreSchema(d);
    migrateHostedHolds(d);
    recordChildRoots(d);
    sweepStaleLaunchers(d, (opts.now ?? Date.now)());
    seedSchema(d, first);
  });
  authGenerationTriggers(db);
  routeReads(db, openReader(path));
  const queue = queueFor(db);
  ownWriter(db, { holds: () => queue.mine, check: () => queue.assertMine() });
  const repo = makeRepo(db, new DiskBlobs(opts.blobDir), opts.attachmentLimits ?? DEFAULT_ATTACHMENT_LIMITS, opts.attachmentUserQuota ?? DEFAULT_ATTACHMENT_USER_QUOTA, opts.now);
  setAccess(db, serverAccess(repo, db, opts.humanReach ?? "team"));
  return { db, repo };
}

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
  // role: 'owner' or 'member' (security audit F-02); null on rows from
  // before it, read through OWNER_SQL.
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
 */
function insertAudit(db: Database, at: number, actor: string | null, action: string, target: string | null, detail: string | null): void {
  const o = requestOrigin();
  db.run("INSERT INTO access_log (at, actor, action, target, detail, ip, ua, client_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [at, actor, action, target, detail, o?.ip ?? null, o?.ua ?? null, o?.client_id ?? null]);
}

// #284's seeds, inside the schema transaction. Principals follow users and
// teams on every open (their writers insert them too). Aliases and read
// points come from the 1.x identities, handles and cursors once, on the open
// that creates aliases (`first`): after it, nothing reads or writes those
// tables, and a later seed would bring back an alias deleted since.
function seedSchema(db: Database, first: boolean): void {
  db.exec(`
    INSERT OR IGNORE INTO principals (kind, name, user_id, created_at) SELECT 'user', email, id, created_at FROM users;
    INSERT OR IGNORE INTO principals (kind, name, team_id, created_at) SELECT 'team', name, id, created_at FROM teams;
  `);
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

/** A team's name another principal already has (#284 decision 5). */
// A team member's role (security audit F-02). Owners (and admins) manage
// membership; members read. A row written before roles existed has a null
// role and reads as owner only for the team's creator (OWNER_SQL), so no
// backfill is needed; every write since stores an explicit role.
export type TeamRole = "owner" | "member";
const OWNER_SQL = `(tm.role = 'owner' OR (tm.role IS NULL AND tm.user_id = (SELECT created_by FROM teams WHERE id = tm.team_id)))`;

export class LastOwner extends Error {
  constructor(readonly team: string) {
    super(`the last owner of team "${team}" can't leave while others remain; make another member an owner first: grayboard team add ${team} <email> --role owner`);
  }
}

export class PrincipalTaken extends Error {
  constructor(readonly name: string) {
    super(`the name "${name}" belongs to another team or service principal`);
  }
}

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
    const user = db.query<User, [string]>("SELECT * FROM users WHERE email = ?").get(email)!;
    db.run(`INSERT OR IGNORE INTO principals (kind, name, user_id, created_at) VALUES ('user', ?, ?, ?)`, [email, user.id, now]);
    return user;
  })();
}

function makeRepo(db: Database, blobs: BlobStore, attachmentLimits: AttachmentLimits, attachmentUserQuota: number, clock: () => number = Date.now): Repo {
  const att = (c: Database, rows: MessageRow[]) => withAttachments(c, "message", rows);
  // Refuses to take `userId`'s ownership away when it is the team's last
  // owner and other members remain. A sole member may leave; a team with
  // no owner (its creator left before roles existed) has nothing to guard.
  const guardLastOwner = (db: Database, teamId: number, userId: number): void => {
    const c = db.query<{ owners: number; members: number; me: number }, [number, number]>(
      `SELECT COALESCE(SUM(${OWNER_SQL}), 0) AS owners, COUNT(*) AS members,
              COALESCE(SUM(tm.user_id = ? AND ${OWNER_SQL}), 0) AS me
       FROM team_members tm WHERE tm.team_id = ?`,
    ).get(userId, teamId)!;
    if (c.me && c.owners === 1 && c.members > 1) {
      throw new LastOwner(db.query<{ name: string }, [number]>("SELECT name FROM teams WHERE id = ?").get(teamId)!.name);
    }
  };
  // Whether two users share a team whose policy is one of `policies`: one indexed lookup (principle 11).
  const sharePolicy = (userA: number, userB: number, policies: readonly TeamPolicy[]): boolean =>
    !!db.query<{ x: number }, (number | string)[]>(
      `SELECT 1 AS x FROM team_members a
       JOIN team_members b ON b.team_id = a.team_id AND b.user_id = ?
       JOIN teams t ON t.id = a.team_id AND t.policy IN (${policies.map(() => "?").join(", ")})
       WHERE a.user_id = ? LIMIT 1`,
    ).get(userB, ...policies, userA);
  const principalByName = (name: string): PrincipalRow | undefined =>
    db.query<PrincipalRow, [string]>("SELECT * FROM principals WHERE name = ?").get(name) ?? undefined;
  // Each changed row tells the observers after its transaction commits (#399); a rollback drops the notice with
  // the change. `null`: any row may have changed (a grant or a user), so observers check every one.
  const observers = new Set<(changed: string | null) => void>();
  const changed = (id: string | null) => afterCommit(db, () => { for (const fn of observers) { try { fn(id); } catch (error) { console.error("hosted invalidation failed", error); } } });
  const change = <A extends unknown[], R>(fn: (...args: A) => R) => (...args: A): R => {
    const value = fn(...args);
    changed(null);
    return value;
  };
  const marks = <A extends unknown[], R>(fn: (...args: A) => R, id: (...args: A) => string) => (...args: A): R => {
    const value = fn(...args);
    changed(id(...args));
    return value;
  };
  const hosted = makeHostedStore(db);
  const { writesOn: _writesOn, ...hostedStore } = hosted;
  const oauth = makeOAuthStore(hosted);
  // The trigger counter (this connection's commits) and data_version (another connection's) (#853).
  // Two plain statements: a pragma_data_version subselect costs over twice as much per call, and this runs
  // on every cached auth read.
  const counter = db.query<{ n: number }, []>("SELECT n FROM temp.auth_generation");
  const dataVersion = db.query<{ data_version: number }, []>("PRAGMA data_version");
  // Changes whenever a committed write touches oauth_tokens, oauth_grants or users, from this connection or
  // another (#853). The counter's part is the value at this connection's last commit (#996), not the live one: while
  // a write body holds a transaction open across an await, other tasks read committed rows (the reader) and must not
  // key a cache entry on the holder's uncommitted bump, which its rollback would undo. Undefined to the holder inside
  // its own transaction, whose reads see writes that may yet roll back, and after a failed counter read until the
  // next commit reads it again (uncached rather than stale).
  // `pinned`: the generation authRead read for its body (#881); null outside one.
  let pinned: string | null = null;
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
  const authGeneration = () => ownsTx(db) ? undefined : pinned ?? readGeneration();
  const userById = (userId: number) => db.query<User, [number]>("SELECT * FROM users WHERE id = ?").get(userId) ?? undefined;
  // Caches of what the auth tables say, cleared when authGeneration moves: a live access token only (an
  // unknown or dead one is re-read every time); a user row, or its absence, as read (#853). They sit
  // here, under the store's own methods, so a test that replaces one of those methods replaces the cache too.
  let userGeneration: string | undefined;
  const users = new Map<number, User | null>();
  const cachedUser = (userId: number): User | undefined => {
    const g = authGeneration();
    if (g === undefined) return userById(userId);
    if (g !== userGeneration) { users.clear(); userGeneration = g; }
    let u = users.get(userId);
    if (u === undefined) users.set(userId, u = userById(userId) ?? null);
    return u ?? undefined;
  };
  // A live access token by hash: held while the generation is unchanged and both the token and its grant
  // are unexpired, the join's own time conditions; required scopes are checked against the held scopes.
  let accessGeneration: string | undefined;
  const accesses = new Map<string, OAuthAccess>();
  // Inside a transaction (authGeneration undefined) it reads on the caller's handle, uncached. The handle is
  // resolved first, so a kept Tx is refused on a cache hit too.
  const findActiveAccess: OAuthStore["findActiveAccess"] = (r, h, resource, requiredScopes, now) => {
    sqliteOf(r);
    const g = authGeneration();
    if (g === undefined || !Array.isArray(requiredScopes)) return oauth.findActiveAccess(r, h, resource, requiredScopes, now);
    if (g !== accessGeneration) { accesses.clear(); accessGeneration = g; }
    const key = `${resource}\n${h}`;
    let a = accesses.get(key);
    if (!a || !(now < a.expiresAt && now < a.grantExpiresAt)) {
      a = oauth.findActiveAccess(r, h, resource, [], now);
      if (!a) { accesses.delete(key); return undefined; }
      accesses.set(key, a);
    }
    const held = a;
    return requiredScopes.every(s => held.scopes.includes(s)) ? held : undefined;
  };
  return {
    now: clock,
    write: <T, R = T>(fn: (tx: Tx) => T | Promise<T>, committed?: (value: T) => R) => queued(db, fn, committed),
    post: <T>(fn: (tx: Tx) => T | Promise<T>, committed?: (value: T) => unknown, what = "write") => posted(db, fn, committed, what),
    read: sqliteRead(db),
    authRead<T>(fn: () => Sync<T>): T {
      if (pinned !== null || ownsTx(db)) return fn() as T;
      const g = readGeneration();
      if (g === undefined) return fn() as T;
      pinned = g;
      try { return fn() as T; } finally { pinned = null; }
    },
    authGeneration,

    oauth: { ...oauth, findActiveAccess, redeemCode: change(oauth.redeemCode), rotateRefresh: change(oauth.rotateRefresh), revokeToken: change(oauth.revokeToken) },
    hosted: { ...hostedStore, insert: marks(hosted.insert, (_tx, row) => row.session_id), update: marks(hosted.update, (_tx, row) => row.session_id),
      end: marks(hosted.end, (_tx, session) => session), childEnd: marks(hosted.childEnd, (_tx, session) => session),
      park: marks(hosted.park, (_tx, session) => session), unpark: marks(hosted.unpark, (_tx, session) => session),
      subscribe(fn) { observers.add(fn); return () => { observers.delete(fn); }; } },
    users: {
      async upsertByEmail(tx, email, displayName) {
        return upsertUser(sqliteOf(tx), email, displayName, clock());
      },
      async signIn(tx, issuer, subject, email, displayName) {
        const db = sqliteOf(tx);
        return db.transaction((): IdpSignIn => {
          // A link is conditional on the row still being unlinked (D3): on Postgres another sign-in may link it
          // between the read and the write. Zero rows: re-read and decide again, now a refusal.
          const link = (id: number) => db.run(
            `UPDATE users SET idp_issuer = ?, idp_subject = ?, display_name = ?
             WHERE id = ? AND idp_subject IS NULL AND (idp_issuer IS NULL OR idp_issuer = ?)`,
            [issuer, subject, displayName, id, issuer]).changes === 1;
          for (let attempt = 0; attempt < 3; attempt++) {
            // 1. This IdP account's user.
            const bySubject = db.query<User, [string, string]>("SELECT * FROM users WHERE idp_issuer = ? AND idp_subject = ?").get(issuer, subject);
            if (bySubject) {
              if (bySubject.email !== email) return { status: "email_changed", user: bySubject };
              db.run("UPDATE users SET display_name = ? WHERE id = ?", [displayName, bySubject.id]);
              return { status: "ok", user: { ...bySubject, display_name: displayName }, linked: false };
            }
            const byEmail = db.query<User, [string]>("SELECT * FROM users WHERE email = ?").get(email);
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
      findByEmail(email) {
        return db.query<User, [string]>("SELECT * FROM users WHERE email = ?").get(email) ?? undefined;
      },
      findById: userById,
      isDisabled(userId) {
        return cachedUser(userId)?.disabled_at != null;
      },
      activeEmail(userId) {
        const u = cachedUser(userId);
        return u && u.disabled_at === null ? u.email : undefined;
      },
      async setDisabled(tx, userId, disabled) {
        const db = sqliteOf(tx);
        db.transaction(() => {
          const now = clock();
          db.run("UPDATE users SET disabled_at = ? WHERE id = ?", [disabled ? now : null, userId]);
          if (disabled) {
            // CLI tokens too, so enable-user doesn't revive them (security audit F-14).
            db.run("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", [now, userId]);
            endHostedWhere(hosted, db, "disabled", now, row => row.user_id === userId);
            db.run("UPDATE oauth_grants SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", [now, userId]);
            db.run("DELETE FROM oauth_browsers WHERE user_id = ?", [userId]);
            db.run("DELETE FROM oauth_codes WHERE user_id = ? AND grant_id IS NULL", [userId]);
          }
        }).immediate();
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
        const db = sqliteOf(tx);
        db.transaction(() => {
          const now = clock();
          db.run("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", [now, userId]);
          endHostedWhere(hosted, db, "revoked", now, row => row.user_id === userId);
          db.run("UPDATE oauth_grants SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", [now, userId]);
          db.run("DELETE FROM oauth_codes WHERE user_id = ? AND grant_id IS NULL", [userId]);
        }).immediate();
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
      findByName: principalByName,
    },

    resolver: {
      principalOf(address) {
        const p = addressParts(address);
        if (!p || p.kind === "bare") return null;
        const name = p.kind === "id"
          ? db.query<{ principal: string | null }, [string]>("SELECT principal FROM ids WHERE id = ?").get(p.address)?.principal
          : p.kind === "alias" ? p.scope : p.name;
        const row = name ? principalByName(name) : undefined;
        // team:x names a team, never a service; a person scope (an email) is only a user's.
        if (!row || (p.kind === "team" && row.kind !== "team")) return null;
        if (p.kind === "alias" && (p.scopeKind === "person") !== (row.kind === "user")) return null;
        return { kind: row.kind, name: row.name };
      },
    },

    aliases: {
      create(tx, scope, createdBy) {
        const db = sqliteOf(tx);
        const { scope_kind, scope_ref, name } = scope;
        return db.query<Alias, [string, string, string, string, string, number]>(
          `INSERT INTO aliases (address, scope_kind, scope_ref, name, created_by_principal, created_at)
           VALUES (?, ?, ?, ?, ?, ?) RETURNING ${ALIAS_COLS}`,
        ).get(`${scope_ref}/${name}`, scope_kind, scope_ref, name, createdBy, clock())!;
      },
      find(r, address) {
        return sqliteOf(r).query<Alias, [string]>(`SELECT ${ALIAS_COLS} FROM aliases WHERE address = ?`).get(address) ?? undefined;
      },
      listForScope(r, kind, ref) {
        return sqliteOf(r).query<Alias, [string, string]>(
          `SELECT ${ALIAS_COLS} FROM aliases WHERE scope_ref = ? AND scope_kind = ? ORDER BY name`,
        ).all(ref, kind);
      },
      countForScope(r, kind, ref) {
        return sqliteOf(r).query<{ n: number }, [string, string, string]>(
          `SELECT COUNT(*) AS n FROM aliases WHERE scope_ref = ? AND scope_kind = ? AND name != ?`,
        ).get(ref, kind, HUMAN_NAME)!.n;
      },
      findAllByName(r, name) {
        return sqliteOf(r).query<Alias, [string]>(`SELECT ${ALIAS_COLS} FROM aliases WHERE name = ? ORDER BY address`).all(name);
      },
      seen(r, addresses) {
        const rows = sqliteOf(r).query<{ address: string; last_seen: number; cwd: string | null; place: string | null }, [string]>(
          `SELECT a.address, a.last_seen, i.cwd, i.place FROM aliases a LEFT JOIN ids i ON i.id = ${ALIAS_SESSION_SQL}
            WHERE a.address IN (SELECT value FROM json_each(?)) AND a.last_seen IS NOT NULL`,
        ).all(JSON.stringify(addresses));
        return new Map(rows.map(({ address, ...facts }) => [address, facts]));
      },
      remove(tx, address) {
        const db = sqliteOf(tx);
        db.transaction(() => {
          db.run("DELETE FROM mailbox_cursors WHERE address = ?", [address]);
          db.run("DELETE FROM aliases WHERE address = ?", [address]);
        })();
      },
    },

    teams: {
      create(tx, name, createdBy) {
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
      findByName(name) {
        return db.query<Team, [string]>("SELECT * FROM teams WHERE name = ?").get(name) ?? undefined;
      },
      listForUser(userId) {
        return db.query<Team, [number]>(
          `SELECT t.* FROM teams t JOIN team_members tm ON tm.team_id = t.id WHERE tm.user_id = ?`,
        ).all(userId);
      },
      addMember(tx, teamId, userId, role = "member") {
        const db = sqliteOf(tx);
        return db.run(
          "INSERT OR IGNORE INTO team_members (team_id, user_id, joined_at, role) VALUES (?, ?, ?, ?)",
          [teamId, userId, clock(), role],
        ).changes > 0;
      },
      removeMember(tx, teamId, userId) {
        const db = sqliteOf(tx);
        db.transaction(() => {
          guardLastOwner(db, teamId, userId);
          db.run("DELETE FROM team_members WHERE team_id = ? AND user_id = ?", [teamId, userId]);
        })();
      },
      setRole(tx, teamId, userId, role) {
        const db = sqliteOf(tx);
        return db.transaction(() => {
          const row = db.query<{ owner: number }, [number, number]>(
            `SELECT ${OWNER_SQL} AS owner FROM team_members tm WHERE tm.team_id = ? AND tm.user_id = ?`,
          ).get(teamId, userId);
          if (!row) return null;
          if (role === "member") guardLastOwner(db, teamId, userId);
          db.run("UPDATE team_members SET role = ? WHERE team_id = ? AND user_id = ?", [role, teamId, userId]);
          return row.owner ? "owner" : "member";
        })();
      },
      isOwner(teamId, userId) {
        return !!db.query<{ x: number }, [number, number]>(
          `SELECT 1 AS x FROM team_members tm WHERE tm.team_id = ? AND tm.user_id = ? AND ${OWNER_SQL}`,
        ).get(teamId, userId);
      },
      listMembers(teamId) {
        return db.query<{ user_id: number; email: string; owner: number }, [number]>(
          `SELECT u.id as user_id, u.email, ${OWNER_SQL} AS owner FROM users u
           JOIN team_members tm ON tm.user_id = u.id WHERE tm.team_id = ?`,
        ).all(teamId).map(({ owner, ...m }) => ({ ...m, role: owner ? "owner" : "member" }));
      },
      listMemberUserIds(teamId) {
        return db.query<{ user_id: number }, [number]>(
          "SELECT user_id FROM team_members WHERE team_id = ?",
        ).all(teamId).map(r => r.user_id);
      },
      isMember(teamId, userId) {
        return !!db.query<{ x: number }, [number, number]>(
          "SELECT 1 AS x FROM team_members WHERE team_id = ? AND user_id = ?",
        ).get(teamId, userId);
      },
      setPolicy(tx, teamId, policy) {
        const db = sqliteOf(tx);
        return db.transaction(() => {
          const row = db.query<{ policy: string }, [number]>("SELECT policy FROM teams WHERE id = ?").get(teamId);
          if (!row) return null;
          db.run("UPDATE teams SET policy = ? WHERE id = ?", [policy, teamId]);
          return (TEAM_POLICIES as readonly string[]).includes(row.policy) ? row.policy as TeamPolicy : "open";
        })();
      },
      shareCollaborative(userA, userB) {
        return sharePolicy(userA, userB, ["collaborative", "delegating"]);
      },
      shareDelegating(userA, userB) {
        return sharePolicy(userA, userB, ["delegating"]);
      },
    },

    messages: {
      insert(tx, sender, recipientType, recipient, body, parentId, pending = false, files, senderId = null, via = null, senderUser = null) {
        const db = sqliteOf(tx);
        return db.transaction(() => {
          const row = db.query<MessageRow, [string, string | null, string, string, string, number | null, number, number, string | null, string | null]>(
            `INSERT INTO messages (sender, sender_id, recipient_type, recipient, body, parent_id, created_at, pending, via, sender_user)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${MSG_COLS}`,
          ).get(sender, senderId, recipientType, recipient, body, parentId, clock(), pending ? 1 : 0, via, senderUser)!;
          const attachments = files ? bindAttachments(db, files.ids, files.uploader, { message_id: row.id }, attachmentLimits) : [];
          return attachments.length ? { ...row, attachments } : row;
        })();
      },
      getById(r, id) {
        const c = sqliteOf(r);
        return c.query<MessageRow, [number]>(`SELECT ${MSG_COLS} FROM messages WHERE id = ?`).get(id) ?? undefined;
      },
      writerUsers(r, messageIds, postIds) {
        const c = sqliteOf(r);
        const pairs = (table: "messages" | "posts", column: "sender_user" | "author_user", ids: number[]) => new Map(ids.length === 0 ? [] :
          c.query<{ id: number; user: string }, [string]>(`SELECT id, ${column} AS user FROM ${table} WHERE id IN (SELECT value FROM json_each(?)) AND ${column} IS NOT NULL`)
            .all(JSON.stringify(ids)).map((r) => [r.id, r.user] as const));
        return { messages: pairs("messages", "sender_user", messageIds), posts: pairs("posts", "author_user", postIds) };
      },
      // The delegation.requested row is written in the message's own
      // transaction on the same clock, so a window around created_at bounds
      // the (action, target, at) index scan: access_log isn't pruned, and an
      // unbounded join would read every request a launcher ever got per
      // message (principle 11, #878 audit). The window's width only absorbs
      // a slow transaction or a clock step. CROSS JOIN fixes the order
      // (messages first), so the planner can't drive from access_log by
      // action alone.
      delegationIds(r, messageIds) {
        const c = sqliteOf(r);
        return new Set(c.query<{ id: number }, [string]>(
          `SELECT m.id FROM messages m
           CROSS JOIN access_log a ON a.action = 'delegation.requested' AND a.target = m.recipient
             AND a.at BETWEEN m.created_at - 60000 AND m.created_at + 60000
             AND json_extract(a.detail, '$.message_id') = m.id
           WHERE m.id IN (SELECT value FROM json_each(?))`,
        ).all(JSON.stringify(messageIds)).map((r) => r.id));
      },
      bouncesFrom(r, id, since = 0) {
        const c = sqliteOf(r);
        return c.query<MessageRow, [string, number]>(`SELECT ${MSG_COLS} FROM messages WHERE sender = ? AND kind = 'bounce' AND created_at >= ? ORDER BY id`).all(id, since);
      },
      history(r, addresses, peer, limit = 20, beforeId) {
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
      thread(r, id) {
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
      unreadSince(r, streams) {
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
      queuedTo(r, recipients) {
        const c = sqliteOf(r);
        const rows = c.query<{ recipient: string; n: number }, [string]>(
          QUEUED_TO_SQL,
        ).all(JSON.stringify(recipients));
        return new Map(rows.map((r) => [r.recipient, r.n]));
      },
      undeliveredFrom(r, senders, olderThan = Number.MAX_SAFE_INTEGER) {
        const c = sqliteOf(r);
        return c.query<{ recipient: string; n: number; oldest_id: number }, [string, number]>(
          UNDELIVERED_FROM_SQL,
        ).all(JSON.stringify(senders), olderThan);
      },
      receivedUnacked(r, readers, since) {
        const c = sqliteOf(r);
        return att(c, c.query<MessageRow, [string, number]>(
          `SELECT ${M_MSG_COLS} FROM messages m
            WHERE m.recipient_type = 'user' AND m.recipient IN (SELECT value FROM json_each(?)) AND m.sender != m.recipient AND m.created_at >= ?
              AND NOT EXISTS (SELECT 1 FROM dm_acks a WHERE a.reader = m.recipient AND a.message_id = m.id)
            ORDER BY m.id ASC`,
        ).all(JSON.stringify(readers), since));
      },
      sentPending(r, senders, since) {
        const c = sqliteOf(r);
        return att(c, c.query<MessageRow, [string, number]>(
          SENT_PENDING_SQL,
        ).all(JSON.stringify(senders), since));
      },
      openDelegations(r, launcher, since) {
        const c = sqliteOf(r);
        return countOpenDelegations(c, "access_log", launcher, since);
      },
      ack(tx, reader, id) {
        sqliteOf(tx).run("INSERT OR IGNORE INTO dm_acks (reader, message_id, acked_at) VALUES (?, ?, ?)", [reader, id, clock()]);
      },
      markDelivered(tx, id, at) {
        sqliteOf(tx).run("UPDATE messages SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL", [at, id]);
      },
      retract(tx, sender, id, by) {
        const db = sqliteOf(tx);
        return db.transaction(() => {
          const retractable = db.query<{ recipient: string }, [number, string]>(
            RETRACTABLE_SQL,
          ).get(id, sender);
          if (!retractable) return false;
          dropAttachments(db, "message", "?", id);
          db.run("DELETE FROM messages WHERE id = ?", [id]);
          db.run("DELETE FROM dm_acks WHERE message_id = ?", [id]);
          insertAudit(db, clock(), by.actor, "message.retracted", `message:${id}`, JSON.stringify({ message_id: id, sender, recipient: retractable.recipient, session: by.session }));
          return true;
        })();
      },
      prune(tx, olderThanMs) {
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
    },

    coreOn: (h) => sqliteOf(h),
    close: () => { db.close(); },

    // Each method resolves the handle when called, so a port kept past its body is refused, as a kept Tx is.
    mailOn: (tx) => {
      sqliteOf(tx);
      return {
        unread: (id) => mailPort(sqliteOf(tx)).unread(id),
        bounce: (from, to, parentId, body, now) => mailPort(sqliteOf(tx)).bounce(from, to, parentId, body, now),
        dropReader: (id) => mailPort(sqliteOf(tx)).dropReader(id),
      };
    },

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
        insertAudit(sqliteOf(tx), row.at, row.actor, row.action, row.target, row.detail);
      },
      last(r, action, target) {
        return sqliteOf(r).query<AccessLogRow, [string, string]>(ACCESS_LOG_LAST_SQL).get(action, target) ?? undefined;
      },
      prune(tx, olderThanMs) {
        sqliteOf(tx).run("DELETE FROM access_log WHERE at < ?", [olderThanMs]);
      },
    },

    slack: {
      async links(r) {
        const db = sqliteOf(r);
        return db.query<SlackLink, []>(
          "SELECT l.*, u.email FROM slack_links l JOIN users u ON u.id = l.user_id ORDER BY l.user_id",
        ).all();
      },
      linkFor(r, userId) {
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
        return row ? JSON.parse(row.progress) : undefined;
      },
      async setProgress(tx, userId, ref, progress) {
        const db = sqliteOf(tx);
        db.run(
          `INSERT INTO slack_progress (user_id, ref, progress) VALUES (?, ?, ?)
           ON CONFLICT(user_id, ref) DO UPDATE SET progress = excluded.progress`,
          [userId, ref, JSON.stringify(progress)],
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
      reclaimFreePages(maxPages) {
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
    redeemCode: async (tx, ...a) => on(tx).redeemCode(...a),
    redeemLoginCode: async (tx, ...a) => on(tx).redeemLoginCode(...a),
    findRefreshGrant: async (r, ...a) => on(r).findRefreshGrant(...a),
    rotateRefresh: async (tx, ...a) => on(tx).rotateRefresh(...a),
    revokeToken: async (tx, ...a) => on(tx).revokeToken(...a),
    findActiveAccess: (r, ...a) => on(r).findActiveAccess(...a),
    isGrantActive: (r, ...a) => on(r).isGrantActive(...a),
    revokePreBuiltinGrants: async (tx, ...a) => on(tx).revokePreBuiltinGrants(...a),
    cleanup: async (tx, ...a) => on(tx).cleanup(...a),
  };
}

// The store's methods without their handle, bound to one connection.
// Synchronous: the store wraps each async method's result in a promise.
type OAuthOps = { [K in keyof OAuthStore]: OAuthStore[K] extends (h: never, ...a: infer A) => infer R ? (...a: A) => Awaited<R> : never };
function oauthOps(db: Database, hosted: HostedStoreOf): OAuthOps {
  const createSession = (userId: number, tokenHash: string, label: string | null, now: number) => insertSession(db, userId, tokenHash, label, now);
  const audit = (action: AuditAction, g: OAuthGrant, now: number, detail: Record<string, unknown> = {}) => {
    const user = db.query<{ email: string }, [number]>("SELECT email FROM users WHERE id = ?").get(g.userId);
    insertAudit(db, now, user?.email ?? null, action, g.id, JSON.stringify({ client_id: g.clientId, ...detail }));
  };
  const invalid = { status: "invalid" } as const;
  const missing = { status: "not_found" } as const;
  const ok = <T>(value: T) => ({ status: "ok" as const, value });
  const hash = (s: string) => /^[a-f0-9]{64}$/.test(s);
  const time = (n: number) => Number.isSafeInteger(n) && n >= 0;
  const deadline = (created: number, expiry: number, now: number, ttl: number) =>
    time(now) && created === now && time(expiry) && expiry > now && expiry <= now + ttl;
  const scopes = (s: string[]) => Array.isArray(s) && s.length > 0 && s.length <= 16 &&
    s.every(v => typeof v === "string" && /^[a-zA-Z0-9:_-]{1,100}$/.test(v)) &&
    JSON.stringify(s) === JSON.stringify([...new Set(s)].sort());
  const binding = (b: OAuthBinding) => typeof b.clientId === "string" && b.clientId.length > 0 && b.clientId.length <= 512 &&
    typeof b.resource === "string" && b.resource.length > 0 && b.resource.length <= 2048 && scopes(b.scopes);
  const same = (a: OAuthBinding, b: OAuthBinding) => binding(b) && a.clientId === b.clientId && a.resource === b.resource &&
    JSON.stringify(a.scopes) === JSON.stringify(b.scopes);
  const authorization = (b: OAuthAuthorization) => binding(b) && typeof b.redirectUri === "string" &&
    b.redirectUri.length > 0 && b.redirectUri.length <= 2048 && /^[A-Za-z0-9_-]{43}$/.test(b.codeChallenge);
  const sameAuthorization = (a: OAuthAuthorization, b: OAuthAuthorization) => same(a, b) &&
    a.redirectUri === b.redirectUri && a.codeChallenge === b.codeChallenge;
  const authorizationData = (a: OAuthAuthorization): OAuthAuthorization => ({ clientId: a.clientId,
    resource: a.resource, scopes: a.scopes, redirectUri: a.redirectUri, codeChallenge: a.codeChallenge });
  const activeUser = (id: number) => !!db.query("SELECT 1 FROM users WHERE id = ? AND disabled_at IS NULL").get(id);
  const read = <T>(table: "oauth_requests" | "oauth_browsers" | "oauth_codes", h: string, now: number): T | undefined => {
    if (!time(now) || !hash(h)) return undefined;
    const row = db.query<{ data: string }, [string, number]>(`SELECT data FROM ${table} WHERE hash = ? AND expires_at > ?`).get(h, now);
    return row ? JSON.parse(row.data) as T : undefined;
  };
  const grant = (id: string): OAuthGrant | undefined => {
    const row = db.query<{ data: string; revoked_at: number | null }, [string]>("SELECT data, revoked_at FROM oauth_grants WHERE id = ?").get(id);
    return row ? { ...JSON.parse(row.data), revokedAt: row.revoked_at } : undefined;
  };
  const live = (g: OAuthGrant | undefined, now: number): g is OAuthGrant =>
    !!g && time(now) && g.revokedAt === null && g.expiresAt > now && activeUser(g.userId);
  const validPair = (p: OAuthTokenPair, b: OAuthBinding, now: number, cap: number) =>
    same(b, p) && hash(p.accessHash) && hash(p.refreshHash) && p.accessHash !== p.refreshHash &&
    deadline(now, p.accessExpiresAt, now, OAUTH_TTL.access) && p.accessExpiresAt <= cap &&
    deadline(now, p.refreshExpiresAt, now, OAUTH_TTL.refresh) && p.refreshExpiresAt <= cap;
  const insertPair = (p: OAuthTokenPair, id: string, now: number) => {
    for (const [h, kind, expiry] of [[p.accessHash, "access", p.accessExpiresAt], [p.refreshHash, "refresh", p.refreshExpiresAt]] as const) {
      db.run("INSERT INTO oauth_tokens(hash, grant_id, kind, expires_at, created_at, access_scopes) VALUES (?, ?, ?, ?, ?, ?)",
        [h, id, kind, expiry, now, kind === "access" ? JSON.stringify(p.scopes) : null]);
    }
  };
  const revokeGrant = (id: string, now: number) => {
    testPause("hosted:revoke:in-txn");
    db.run("UPDATE oauth_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [now, id]);
    endHostedWhere(hosted, db, "revoked", now, row => row.grant_id === id);
  };
  type Token = { hash: string; grant_id: string; kind: string; expires_at: number; spent_at: number | null; revoked_at: number | null; created_at: number };
  const token = (h: string) => db.query<Token, [string]>("SELECT * FROM oauth_tokens WHERE hash = ?").get(h);
  const browser = (h: string, now: number) => {
    const b = read<OAuthBrowserSession>("oauth_browsers", h, now);
    return b && activeUser(b.userId) ? b : undefined;
  };
  // A code row and the checks both redeemers share (#928 D8): the code exists and its binding (client, resource,
  // scopes, redirect, fresh S256 challenge) is the presented one. A spent row (grant_id or session_id set) is the
  // caller's replay; `usable` then checks expiry and the user.
  type CodeRow = { data: string; expires_at: number; grant_id: string | null; session_id: number | null };
  const codeRow = (h: string) => db.query<CodeRow, [string]>("SELECT data, expires_at, grant_id, session_id FROM oauth_codes WHERE hash = ?").get(h);
  const presented = (input: OAuthAuthorization & { codeHash: string }, now: number): { c: OAuthCode; row: CodeRow } | OAuthFailure => {
    if (!time(now) || !hash(input.codeHash)) return invalid;
    const row = codeRow(input.codeHash);
    if (!row) return missing;
    const c: OAuthCode = JSON.parse(row.data);
    return sameAuthorization(c, input) ? { c, row } : invalid;
  };
  const usable = (c: OAuthCode, row: CodeRow, now: number): OAuthFailure | undefined =>
    row.expires_at <= now ? missing : activeUser(c.userId) ? undefined : invalid;
  const isLogin = (c: OAuthBinding) => c.scopes.length === 1 && c.scopes[0] === LOGIN_SCOPE;
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
  const grantCodeReplay = (id: string, now: number) => {
    const g = grant(id);
    if (!g || g.expiresAt <= now) return missing;
    revokeGrant(g.id, now);
    audit("oauth.code_replay_revoked", g, now, { level: "warning" });
    return { status: "replay" } as const;
  };
  const loginCodeReplay = (c: OAuthCode, sessionId: number, now: number) => {
    db.run("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [now, sessionId]);
    sessionAudit("oauth.code_replay_revoked", c, sessionId, now, { level: "warning" });
    return { status: "replay" } as const;
  };
  const refreshReplay = (g: OAuthGrant, now: number) => {
    revokeGrant(g.id, now);
    audit("oauth.refresh_replay_revoked", g, now, { level: "warning" });
    return { status: "replay" } as const;
  };
  return {
    createRequest(input, now) {
      if (!authorization(input) || input.consentSessionHash !== null || ![input.requestHash, input.browserHash, input.csrfHash, input.stateHash].every(hash) ||
          !deadline(input.createdAt, input.expiresAt, now, OAUTH_TTL.request)) return invalid;
      return db.transaction(() => {
        db.run("DELETE FROM oauth_requests WHERE expires_at <= ?", [now]);
        const count = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM oauth_requests WHERE browser_hash = ?").get(input.browserHash)!.n;
        const total = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM oauth_requests").get()!.n;
        if (count >= 10 || total >= 1000) return { status: "capacity" } as const;
        db.run("INSERT INTO oauth_requests(hash, browser_hash, expires_at, data) VALUES (?, ?, ?, ?)", [input.requestHash, input.browserHash, input.expiresAt, JSON.stringify({ ...authorizationData(input),
          requestHash: input.requestHash, browserHash: input.browserHash, csrfHash: input.csrfHash, stateHash: input.stateHash,
          consentSessionHash: null, createdAt: input.createdAt, expiresAt: input.expiresAt })]);
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
        const b = browser(sessionHash, now);
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
      if (!hash(input.sessionHash) || !deadline(input.createdAt, input.expiresAt, now, OAUTH_TTL.browser)) return invalid;
      return db.transaction(() => {
        if (!activeUser(input.userId)) return invalid;
        db.run("DELETE FROM oauth_browsers WHERE expires_at <= ?", [now]);
        const count = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM oauth_browsers").get()!.n;
        if (count >= 10000) return { status: "capacity" } as const;
        if (replaceHash) db.run("DELETE FROM oauth_browsers WHERE hash = ?", [replaceHash]);
        db.run("INSERT INTO oauth_browsers(hash, user_id, expires_at, data) VALUES (?, ?, ?, ?)", [input.sessionHash, input.userId, input.expiresAt, JSON.stringify({ sessionHash: input.sessionHash,
          userId: input.userId, createdAt: input.createdAt, expiresAt: input.expiresAt })]);
        return ok(input);
      }).immediate();
    },
    findBrowserSession: browser,
    revokeBrowserSession(h) { db.run("DELETE FROM oauth_browsers WHERE hash = ?", [h]); },
    decideRequest(input, now) {
      return db.transaction(() => {
        const r = read<OAuthRequest>("oauth_requests", input.requestHash, now);
        const b = browser(input.sessionHash, now);
        if (!r || !b) return missing;
        if (r.browserHash !== input.browserHash || r.csrfHash !== input.csrfHash || r.consentSessionHash !== input.sessionHash) return invalid;
        const c = input.code;
        if (input.approve && (!sameAuthorization(r, c) || c.userId !== b.userId || !hash(c.codeHash) ||
            !deadline(c.createdAt, c.expiresAt, now, OAUTH_TTL.code))) return invalid;
        // The delete consumes the request (D3): of two concurrent decisions only one deletes a row.
        if (!db.query<{ hash: string }, [string]>("DELETE FROM oauth_requests WHERE hash = ? RETURNING hash").get(input.requestHash)) return missing;
        if (!input.approve) return ok(null);
        db.run("INSERT INTO oauth_codes(hash, user_id, expires_at, data) VALUES (?, ?, ?, ?)", [c.codeHash, c.userId, c.expiresAt, JSON.stringify({ ...authorizationData(c),
          codeHash: c.codeHash, userId: c.userId, createdAt: c.createdAt, expiresAt: c.expiresAt })]);
        return ok(c);
      }).immediate();
    },
    findCodeScopes(h, clientId, resource, redirectUri, now) {
      if (!time(now) || !hash(h)) return undefined;
      const row = codeRow(h);
      if (!row) return undefined;
      const c: OAuthCode = JSON.parse(row.data);
      if (c.clientId !== clientId || c.resource !== resource || c.redirectUri !== redirectUri || !activeUser(c.userId)) return undefined;
      // A spent code stays findable while what it minted lives, so a replay reaches its redeemer and revokes it.
      if (row.grant_id !== null ? !live(grant(row.grant_id), now) : row.session_id !== null ? !liveSession(row.session_id) : row.expires_at <= now) return undefined;
      return [...c.scopes];
    },
    redeemCode(input, now) {
      return db.transaction(() => {
        const p = presented(input, now);
        if ("status" in p) return p;
        const { c, row } = p;
        // A login code, spent or not, never becomes a grant (#928 D8).
        if (row.session_id !== null || c.scopes.includes(LOGIN_SCOPE)) return invalid;
        if (row.grant_id !== null) return grantCodeReplay(row.grant_id, now);
        const unusable = usable(c, row, now);
        if (unusable) return unusable;
        if (!/^[A-Za-z0-9_-]{16,128}$/.test(input.grantId) ||
            !deadline(now, input.grantExpiresAt, now, OAUTH_TTL.grant) ||
            !validPair(input.tokens, c, now, input.grantExpiresAt)) return invalid;
        const g: OAuthGrant = { id: input.grantId, userId: c.userId, clientId: c.clientId, resource: c.resource,
          scopes: c.scopes, createdAt: now, expiresAt: input.grantExpiresAt, revokedAt: null };
        db.run("INSERT INTO oauth_grants(id, user_id, expires_at, data) VALUES (?, ?, ?, ?)", [g.id, g.userId, g.expiresAt, JSON.stringify(g)]);
        // The statement that sets grant_id spends the code (D3), so of two concurrent redeemers one wins at any isolation
        // level. The grant goes in first because grant_id references it; a loser withdraws it and answers as a replay, or
        // not_found when the code or the winner's grant is gone.
        if (!spendCode("grant_id", g.id, input.codeHash)) {
          db.run("DELETE FROM oauth_grants WHERE id = ?", [g.id]);
          const winner = codeRow(input.codeHash)?.grant_id;
          return winner ? grantCodeReplay(winner, now) : missing;
        }
        insertPair(input.tokens, g.id, now);
        audit("oauth.grant_issued", g, now);
        return ok({ grant: g, tokens: input.tokens });
      }).immediate();
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
        if (!hash(input.tokenHash) || (input.label !== null && typeof input.label !== "string")) return invalid;
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
      if (!time(now) || !hash(h)) return undefined;
      const row = db.query<{ data: string }, [string, number]>(`
        SELECT g.data FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id JOIN users u ON u.id = g.user_id
        WHERE t.hash = ? AND t.kind = 'refresh' AND g.revoked_at IS NULL AND g.expires_at > ? AND u.disabled_at IS NULL`).get(h, now);
      if (!row) return undefined;
      const g: OAuthGrant = JSON.parse(row.data);
      return g.clientId === clientId && g.resource === resource ? g : undefined;
    },
    rotateRefresh(input, now) {
      if (!time(now) || !hash(input.refreshHash)) return invalid;
      return db.transaction(() => {
        testPause("oauth:refresh:in-txn");
        const t = token(input.refreshHash);
        if (!t || t.kind !== "refresh") return missing;
        const g = grant(t.grant_id);
        if (!g || !binding(input) || g.clientId !== input.clientId || g.resource !== input.resource ||
            !input.scopes.every(s => g.scopes.includes(s))) return invalid;
        if (!live(g, now)) return invalid;
        // A recognized ancestor revokes even after its sliding expiry; tombstones outlive it.
        if (t.spent_at !== null) return refreshReplay(g, now);
        if (t.revoked_at !== null || t.expires_at <= now || !validPair(input.tokens, input, now, Number.MAX_SAFE_INTEGER) ||
            input.tokens.accessHash === input.refreshHash || input.tokens.refreshHash === input.refreshHash) return invalid;
        const tokens = { ...input.tokens, accessExpiresAt: Math.min(input.tokens.accessExpiresAt, g.expiresAt),
          refreshExpiresAt: Math.min(input.tokens.refreshExpiresAt, g.expiresAt) };
        insertPair(tokens, g.id, now);
        // The statement that sets spent_at spends the token (D3): of two concurrent rotations one wins at any isolation
        // level. The new pair goes in first, as a redeemed code's grant does; a loser withdraws it and re-reads the token.
        const spent = db.query<{ hash: string }, [number, string, number]>(`UPDATE oauth_tokens SET spent_at = ?
          WHERE hash = ? AND kind = 'refresh' AND spent_at IS NULL AND revoked_at IS NULL AND expires_at > ? RETURNING hash`).get(now, input.refreshHash, now);
        if (!spent) {
          db.run("DELETE FROM oauth_tokens WHERE hash IN (?, ?)", [tokens.accessHash, tokens.refreshHash]);
          return token(input.refreshHash)?.spent_at != null ? refreshReplay(g, now) : invalid;
        }
        audit("oauth.refreshed", g, now);
        return ok({ grant: g, tokens });
      }).immediate();
    },
    revokeToken(h, clientId, now) {
      if (!time(now) || !hash(h)) return;
      db.transaction(() => {
        const t = token(h);
        if (!t) return;
        const g = grant(t.grant_id);
        if (!g || g.clientId !== clientId) return;
        if (t.kind === "refresh") revokeGrant(g.id, now);
        else db.run("UPDATE oauth_tokens SET revoked_at = ? WHERE hash = ? AND revoked_at IS NULL", [now, h]);
        audit("oauth.revoked", g, now, { kind: t.kind });
      }).immediate();
    },
    findActiveAccess(h, resource, requiredScopes, now) {
      if (!time(now) || !hash(h) || !Array.isArray(requiredScopes)) return undefined;
      // One read snapshot binds token, grant and user liveness.
      const row = db.query<{ data: string; created_at: number; token_expiry: number; access_scopes: string | null; grant_expiry: number }, [string, number, number]>(`
        SELECT g.data, t.created_at, t.expires_at AS token_expiry, t.access_scopes, g.expires_at AS grant_expiry FROM oauth_tokens t
        JOIN oauth_grants g ON g.id = t.grant_id JOIN users u ON u.id = g.user_id
        WHERE t.hash = ? AND t.kind = 'access' AND t.revoked_at IS NULL AND t.expires_at > ?
          AND g.revoked_at IS NULL AND g.expires_at > ? AND u.disabled_at IS NULL`).get(h, now, now);
      if (!row) return undefined;
      const g: OAuthGrant = JSON.parse(row.data);
      // Pre-downscope rows were issued with exactly the full grant scope.
      const accessScopes: string[] = row.access_scopes === null ? g.scopes : JSON.parse(row.access_scopes);
      if (!scopes(accessScopes) || !accessScopes.every(s => g.scopes.includes(s)) ||
          g.resource !== resource || !requiredScopes.every(s => accessScopes.includes(s))) return undefined;
      const a: OAuthAccess = { tokenHash: h, grantId: g.id, userId: g.userId, clientId: g.clientId,
        resource: g.resource, scopes: accessScopes, createdAt: row.created_at, expiresAt: row.token_expiry, grantExpiresAt: row.grant_expiry };
      return a;
    },
    isGrantActive(id, now) {
      if (!time(now)) return false;
      return !!db.query(`SELECT 1 FROM oauth_grants g JOIN users u ON u.id = g.user_id
        WHERE g.id = ? AND g.revoked_at IS NULL AND g.expires_at > ? AND u.disabled_at IS NULL`).get(id, now);
    },
    revokePreBuiltinGrants(clientIds, now, key = "builtin_clients") {
      if (!time(now)) throw new RangeError("invalid OAuth cutover time");
      return db.transaction(() => {
        if (db.query("SELECT 1 FROM server_state WHERE key = ?").get(key)) return 0;
        const ids = JSON.stringify(clientIds);
        // An operator client could use these IDs before #429; its grants and codes must not
        // become a built-in's (write-capable, refreshed with no secret).
        const grants = db.query<{ id: string }, [string]>(
          "SELECT id FROM oauth_grants WHERE revoked_at IS NULL AND json_extract(data, '$.clientId') IN (SELECT value FROM json_each(?))").all(ids);
        for (const { id } of grants) {
          revokeGrant(id, now);
          audit("oauth.builtin_client_grant_revoked", grant(id)!, now);
        }
        db.run("DELETE FROM oauth_codes WHERE grant_id IS NULL AND json_extract(data, '$.clientId') IN (SELECT value FROM json_each(?))", [ids]);
        db.run("INSERT INTO server_state(key, value) VALUES (?, ?)", [key, now]);
        return grants.length;
      }).immediate();
    },
    cleanup(now) {
      if (!time(now)) throw new RangeError("invalid OAuth cleanup time");
      db.transaction(() => {
        for (const table of ["oauth_requests", "oauth_browsers"]) db.run(`DELETE FROM ${table} WHERE expires_at <= ?`, [now]);
        // A spent login code is kept while its session lives, as a grant code is while its grant does (replay).
        db.run(`DELETE FROM oauth_codes WHERE grant_id IS NULL AND expires_at <= ?
          AND (session_id IS NULL OR session_id NOT IN (SELECT id FROM sessions WHERE revoked_at IS NULL))`, [now]);
        db.run("DELETE FROM oauth_tokens WHERE kind = 'access' AND expires_at <= ?", [now]);
        // Keep refresh tombstones until the absolute family deadline, including revoked families.
        db.run("DELETE FROM oauth_grants WHERE expires_at <= ?", [now]);
      }).immediate();
    },
  };
}

// The server's mail as core's session end reads it (a MailPort): the repo's, and the hosted store's child ends (#475).
function mailPort(db: Database): MailPort {
  return {
    unread(id) {
      return db.query<{ id: number; sender: string }, [string]>(
        `SELECT m.id, m.sender FROM messages m
          WHERE m.recipient_type = 'user' AND m.recipient = ?1 AND m.sender <> ?1
            AND m.id > COALESCE((SELECT last_seen_id FROM mailbox_cursors
                                  WHERE address = ?1 AND stream_type = 'direct' AND stream_ref = ?1), 0)
          ORDER BY m.id`,
      ).all(id);
    },
    bounce(from, to, parentId, body, now) {
      db.query(
        `INSERT INTO messages (sender, sender_id, recipient_type, recipient, body, parent_id, created_at, pending, kind)
         VALUES (?1, ?1, 'user', ?2, ?3, ?4, ?5, 0, 'bounce')`,
      ).run(from, to, body, parentId, now);
    },
    dropReader(id) {
      db.query(`DELETE FROM mailbox_cursors WHERE address = ?`).run(id);
      db.query(`DELETE FROM dm_acks WHERE reader = ?`).run(id);
    },
  };
}

// The writes take the body's `Tx` (#807 P1c-11), resolved to its connection before any argument is read, so a
// kept `Tx` is refused whatever the call; the reads take a `Read` the same way (P1c-12).
// `writesOn`: the writes bound to a connection a store already resolved from its caller's handle (the users, sessions and OAuth stores).
type HostedStoreOf = HostedStore & { writesOn(c: Database): HostedWrites };
function makeHostedStore(db: Database): HostedStoreOf {
  // The child IDs ended since the last take, queued at commit by whichever connection ended them (#475 item 1).
  const ended: { list: EndedChild[] } = { list: [] };
  const ops = new WeakMap<Database, HostedWrites>();
  const writesOn = (c: Database): HostedWrites => {
    let o = ops.get(c);
    if (!o) ops.set(c, o = hostedWrites(c, ended));
    return o;
  };
  const on = (tx: Tx): HostedWrites => writesOn(sqliteOf(tx));
  const store: HostedStoreOf = {
    writesOn,
    write: (fn, committed) => queued(db, fn, committed),
    subscribe: () => () => {},
    get: (r, id) => hostedRow(sqliteOf(r), id),
    owned: (r, id) => sqliteOf(r).query<{ n: number }, [string, string]>(
      "SELECT 1 AS n WHERE EXISTS (SELECT 1 FROM hosted_ownerships WHERE session_id = ?1) OR EXISTS (SELECT 1 FROM hosted_sessions WHERE session_id = ?2)",
    ).get(id, id) !== null,
    all: (r) => sqliteOf(r).query<HostedSession, []>("SELECT * FROM hosted_sessions WHERE parked_at IS NULL").all(),
    counts: (r, user) => sqliteOf(r).query<{ total: number; user: number }, [number]>(
      "SELECT (SELECT count(*) FROM hosted_sessions WHERE parked_at IS NULL) AS total, (SELECT count(*) FROM hosted_sessions WHERE user_id = ?1 AND parked_at IS NULL) AS user").get(user)!,
    ofOwnership: (r, ownership) => sqliteOf(r).query<HostedSession, [number]>("SELECT * FROM hosted_sessions WHERE ownership_id = ? AND parked_at IS NULL").all(ownership),
    children: (r, root) => sqliteOf(r).query<HostedSession, [string]>("SELECT * FROM hosted_sessions WHERE root_session_id = ?").all(root),
    roots: (r, user) => sqliteOf(r).query<HostedSession, [number]>(
      "SELECT * FROM hosted_sessions WHERE user_id = ? AND +root_session_id IS NULL ORDER BY created_at, session_id").all(user),
    park: (tx, ...a) => on(tx).park(...a),
    unpark: (tx, ...a) => on(tx).unpark(...a),
    start: (tx, ...a) => on(tx).start(...a),
    insert: (tx, ...a) => on(tx).insert(...a),
    update: (tx, ...a) => on(tx).update(...a),
    touch: (tx, ...a) => on(tx).touch(...a),
    // The unary `+` keeps the planner off idx_hosted_root, which every root matches, so these two read
    // idx_hosted_deadline and idx_hosted_user (#399).
    expired: (r, now) => sqliteOf(r).query<HostedSession, [number]>(
      "SELECT * FROM hosted_sessions WHERE lease_deadline <= ? AND +root_session_id IS NULL").all(now),
    idle: (r, cutoff) => sqliteOf(r).query<HostedSession, [number]>(`SELECT * FROM hosted_sessions h WHERE h.parked_at IS NULL AND h.last_seen_at < ?
      AND (h.root_session_id IS NOT NULL OR (h.lease_deadline IS NULL AND NOT EXISTS (SELECT 1 FROM alias_holds a WHERE a.id = h.session_id)))`).all(cutoff),
    disabled: (r) => sqliteOf(r).query<HostedSession, []>(
      "SELECT * FROM hosted_sessions WHERE user_id IN (SELECT id FROM users WHERE disabled_at IS NOT NULL) AND +root_session_id IS NULL").all(),
    childEnd: (tx, ...a) => on(tx).childEnd(...a),
    takeEnded() {
      const taken = ended.list;
      ended.list = [];
      return taken;
    },
    end: (tx, ...a) => on(tx).end(...a),
    lose: (tx, ...a) => on(tx).lose(...a),
    lost: (r, session, reader) => hostedLostOf(sqliteOf(r))(session, `${LOST_READ[reader]} IS NULL`),
    tellLost: (tx, ...a) => on(tx).tellLost(...a),
    reportLost: (tx, ...a) => on(tx).reportLost(...a),
    seeLost: (tx, ...a) => on(tx).seeLost(...a),
    forgetLost: (tx, ...a) => on(tx).forgetLost(...a),
    aliveAt: (r) => sqliteOf(r).query<{ value: number }, []>("SELECT value FROM server_state WHERE key = 'alive_at'").get()?.value,
    heartbeat: (tx, ...a) => on(tx).heartbeat(...a),
    setRoot: (tx, id, root) => { sqliteOf(tx).query("UPDATE ids SET root_id = ? WHERE id = ? AND root_id IS NOT ?").run(root, id, root); },
    reopenId: (tx, id) => { sqliteOf(tx).query("UPDATE ids SET ended_at = NULL, held_aliases_json = NULL WHERE id = ?").run(id); },
    restateWritesAs: (tx, id, writesAs) => { sqliteOf(tx).query("UPDATE ids SET writes_as = ? WHERE id = ? AND writes_as IS NULL").run(writesAs, id); },
    declareLauncher: (tx, id) => sqliteOf(tx).query("UPDATE ids SET launcher = 1 WHERE id = ? AND launcher IS NOT 1").run(id).changes > 0,
    launcher: (r, id) => sqliteOf(r).query<{ launcher: number | null }, [string]>("SELECT launcher FROM ids WHERE id = ?").get(id)?.launcher === 1,
    holds: (r) => sqliteOf(r).query<{ id: string; address: string }, []>(`SELECT id, address FROM alias_holds ${HOLD_ORDER}`).all(),
  };
  return store;
}

const hostedRow = (db: Database, id: string) => db.query<HostedSession, [string]>("SELECT * FROM hosted_sessions WHERE session_id = ?").get(id) ?? undefined;
// The hosted_alias_lost column each reader's take marks (#453).
const LOST_READ: Record<LostReader, string> = { agent: "told_at", controller: "seen_at" };
const hostedLostOf = (db: Database) => (session: string, where: string): HostedLost[] => db.query<{ alias: string; reason: string; was_primary: number }, [string]>(
  `SELECT alias, reason, was_primary FROM hosted_alias_lost WHERE session_id = ? AND ${where} ORDER BY at, rowid`,
).all(session).map(r => ({ alias: r.alias, reason: r.reason, primary: r.was_primary === 1 }));

type HostedWriteName = "park" | "unpark" | "start" | "insert" | "update" | "touch" | "childEnd" | "end" | "lose" | "tellLost" | "reportLost" | "seeLost" | "forgetLost" | "heartbeat";
// The hosted store's writes without their handle, bound to one connection.
type HostedWrites = { [K in HostedWriteName]: HostedStore[K] extends (tx: Tx, ...a: infer A) => infer R ? (...a: A) => R : never };
function hostedWrites(db: Database, ended: { list: EndedChild[] }): HostedWrites {
  const get = (id: string) => hostedRow(db, id);
  const audit = (session: string, action: AuditAction, detail: Record<string, unknown>, now: number) => {
    const owner = db.query<{ email: string; client_id: string }, [string]>(`SELECT u.email, o.client_id FROM hosted_ownerships o JOIN users u ON u.id = o.user_id
      WHERE o.session_id = ? ORDER BY o.id DESC LIMIT 1`).get(session);
    insertAudit(db, now, owner?.email ?? null, action, session, JSON.stringify({ ...detail, client_id: owner?.client_id ?? null }));
  };
  // A released child's ID ends in the release's transaction, with its reason (#475 item 1): left unended,
  // nothing owns it, and the next start would end it as a WSS leftover. The ends' wakes wait in `ended`,
  // queued at commit, for the application to run (`takeEnded`).
  const mail = mailPort(db);
  const coreAudit = (now: number): AuditSink => (action, actor, target, detail) =>
    insertAudit(db, now, actor, action, target, detail ? JSON.stringify(detail) : null);
  const endChild = (child: string, why: string, now: number) => {
    const end = endSession(db, mail, child, { why, now, audit: coreAudit(now) });
    // Queued at commit, so a rolled-back release wakes nobody and bounces nothing.
    if (end.ended) afterCommit(db, () => { ended.list.push({ id: child, at: now, wake: end.wake }); });
  };
  const lostOf = hostedLostOf(db);
  // Marks `where`'s rows' `column` and deletes the rows both readers took.
  const takeLost = (session: string, where: string, column: string, now: number) => {
    const lost = lostOf(session, where);
    if (!lost.length) return lost;
    db.run(`UPDATE hosted_alias_lost SET ${column} = ? WHERE session_id = ? AND ${where}`, [now, session]);
    db.run("DELETE FROM hosted_alias_lost WHERE session_id = ? AND told_at IS NOT NULL AND seen_at IS NOT NULL", [session]);
    return lost;
  };
  return {
    park(session, now) {
      db.run("UPDATE hosted_sessions SET parked_at = ? WHERE session_id = ? AND root_session_id IS NOT NULL AND parked_at IS NULL", [now, session]);
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
    update(row) {
      db.run("UPDATE hosted_sessions SET grant_id = ?, bind_gen = ?, root_session_id = ?, ownership_id = ?, place = ?, lease_deadline = ?, last_seen_at = ? WHERE session_id = ?",
        [row.grant_id, row.bind_gen, row.root_session_id, row.ownership_id, row.place, row.lease_deadline, row.last_seen_at, row.session_id]);
    },
    touch(session, now) {
      db.run("UPDATE hosted_sessions SET last_seen_at = ? WHERE session_id = ?", [now, session]);
    },
    childEnd(session, now, reason) {
      const row = get(session);
      if (!row?.root_session_id) return;
      db.run("DELETE FROM hosted_sessions WHERE session_id = ?", [session]);
      audit(row.root_session_id, "hosted.child_released", { child: session, reason }, now);
      endChild(session, reason, now);
    },
    end(session, reason, now, deadline) {
      const row = get(session);
      if (!row || row.root_session_id || (deadline !== undefined && row.lease_deadline !== deadline)) return false;
      testPause(reason === "expired" ? "hosted:lease-expire:in-txn" : "hosted:release:in-txn");
      const children = db.query<HostedSession, [number]>("DELETE FROM hosted_sessions WHERE ownership_id = ? RETURNING *").all(row.ownership_id);
      db.run("UPDATE hosted_ownerships SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL", [now, reason, row.ownership_id]);
      // A hosted root's ID row is never ended (the ID is the store's), so a tools-only root's writes_as would keep the
      // alias in use (aliasUser, aliasUses) after its ownership ends; the next ownership restates it. The
      // launcher flag (#473) is the ownership's too: a resumed session that no longer declares one isn't one. Clearing
      // it is audited as its setting is (#532), so the trail shows when a hosted launcher stopped being one.
      const launcher = db.query<{ launcher: number | null }, [string]>("SELECT launcher FROM ids WHERE id = ?").get(session)?.launcher === 1;
      db.run("UPDATE ids SET writes_as = NULL, launcher = 0 WHERE id = ?", [session]);
      if (launcher) audit(session, "handle.launcher_set", { on: false, ownership: row.ownership_id, reason }, now);
      // Every hold the ownership has, not one name's (#451): ending it releases them all.
      for (const { address } of db.query<{ address: string }, [string]>("SELECT address FROM alias_holds WHERE id = ?").all(session)) {
        dropHold(db, address, session);
        logBinding(db, session, address, "released", reason, now);
      }
      for (const child of children) if (child.root_session_id) {
        audit(session, "hosted.child_released", { child: child.session_id, reason }, now);
        endChild(child.session_id, reason, now);
      }
      if (row.lease_deadline !== null) audit(session, "hosted.lease_closed", { reason, ownership: row.ownership_id }, now);
      return true;
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
function endHostedWhere(hosted: HostedStoreOf, db: Database, reason: HostedEnd, now: number, predicate: (row: HostedSession) => boolean) {
  const w = hosted.writesOn(db);
  for (const row of db.query<HostedSession, []>("SELECT * FROM hosted_sessions WHERE parked_at IS NULL").all()) if (!row.root_session_id && predicate(row)) w.end(row.session_id, reason, now);
}
