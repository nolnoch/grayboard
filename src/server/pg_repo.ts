// The Postgres Repo (#807 P3 C11a, docs/future/postgres-server.md D8 P3): every Postgres store group composed over one
// transaction store, one clock and one auth generation, as db.ts makeRepo composes the SQLite ones. It lives here, at
// the server layer beside db.ts, not under store/pg/: the hosted store's session-end port closes over
// session_end.ts sessionEndPort, which reaches the SQLite modules through access.ts, and pg/isolation.test.ts keeps
// store/pg/ off every path to them. It imports no bun:sqlite itself.
//
// Open, in order (c11-scope §1.1): migrate on a connection of its own, under migrate's advisory lock, and close it;
// then the auth generation's LISTEN (gen.start). The Repo comes back only after both, so nothing reads the pool
// before the schema is there. Close: the generation (its heartbeat, retry and LISTEN connection), then the pool.
import type { Repo, RepoHosted } from "./db.ts";
import { blobStore } from "./blobs.ts";
import type { BlobStore } from "../core/attachments.ts";
import type { HumanReach } from "./policy.ts";
import { sessionEndPort } from "./session_end.ts";
import { makeNotices } from "./store/notices.ts";
import type { SessionEndPort } from "./store/session_end.ts";
import { makePgAliases } from "./store/pg/aliases.ts";
import { makePgAttachments } from "./store/pg/attachments.ts";
import { makePgAudit } from "./store/pg/audit.ts";
import { makePgAuthCache, makePgAuthGeneration, openPgListener, type PgAuthGeneration } from "./store/pg/auth_generation.ts";
import { makePgBindings } from "./store/pg/bindings.ts";
import { makePgBoards } from "./store/pg/boards.ts";
import { makePgClaims } from "./store/pg/claims.ts";
import { makePgCursors } from "./store/pg/cursors.ts";
import { makePgDelegation } from "./store/pg/delegation.ts";
import { makePgHosted } from "./store/pg/hosted.ts";
import { deferredSessionEnd, makePgHostedEnds } from "./store/pg/hosted_port.ts";
import { makePgIdentity } from "./store/pg/identity.ts";
import { makePgMessages } from "./store/pg/messages.ts";
import { migrate } from "./store/pg/migrate.ts";
import { makePgOAuth } from "./store/pg/oauth.ts";
import { makePgSessionEnd } from "./store/pg/session_end.ts";
import { makePgSlack } from "./store/pg/slack.ts";
import { openPg } from "./store/pg/sql.ts";
import { makePgTransactions, refuseKeyedNotice } from "./store/pg/tx.ts";
import type { Tx } from "./store/tx.ts";
import type { WriteQueue } from "./store/queue.ts";
import { makePgWriteReceipts } from "./store/pg/write_receipts.ts";
import { DEFAULT_ATTACHMENT_LIMITS, DEFAULT_ATTACHMENT_USER_QUOTA, type AttachmentLimits } from "../shared/attachments.ts";

export type PgRepoOptions = {
  // Where attachment bytes live (no database directory to derive it from): `blobs` when given (an S3 store, #1509),
  // else a directory store at `blobDir`.
  blobDir?: string;
  blobs?: BlobStore;
  attachmentLimits?: AttachmentLimits;
  attachmentUserQuota?: number;
  // The hub's clock (db.ts OpenOptions): every group's rows read it.
  now?: () => number;
  // The board access a released hosted child's ID end judges posts by (session_end.ts sessionEndPort).
  humanReach?: HumanReach;
  // Labels the pool's connections in pg_stat_activity; the LISTEN's is `<applicationName>-listen`, the migration's
  // `<applicationName>-migrate`.
  applicationName?: string;
  // Read pool size (Bun's default is 10).
  max?: number;
  // Write pool size and the write scheduler's cap (store/pg/tx.ts makePgTransactions; default DEFAULT_DATABASE_WRITERS).
  writers?: number;
};

// `writeQueue`: the store's write scheduler, for a test's queue-state signals (store/queue.ts waitingAt); the server
// reaches it only through the Repo's writes.
export type PgRepo = Repo & { readonly writeQueue: WriteQueue };

// The change notices a keyed body may queue (Repo.writeKeyedEffects, D4): renew's lease update. A caller can't widen
// the set; refuseKeyedNotice further limits it to a row of the body's own root key.
const KEYED_NOTICE_OPS: ReadonlySet<string> = new Set(["hosted.update"]);

export async function makePgRepo(url: string, opts: PgRepoOptions): Promise<PgRepo> {
  const clock = opts.now ?? Date.now;
  const app = opts.applicationName ?? "grayboard";
  const attachmentLimits = opts.attachmentLimits ?? DEFAULT_ATTACHMENT_LIMITS;
  // The write path bumps the generation (ownAuthCommit), which reads the store's queue: each needs the other, so the
  // generation binds late.
  let gen!: PgAuthGeneration;
  const t = makePgTransactions(url, { max: opts.max, writers: opts.writers, applicationName: app, ownAuthCommit: () => gen.ownCommit() });
  gen = makePgAuthGeneration({ url, transactions: t, openListener: openPgListener(url, `${app}-listen`) });
  const close = async () => { await gen.close(); await t.close(); };
  try {
    const m = openPg(url, { max: 1, applicationName: `${app}-migrate` });
    try { await migrate(m, undefined, { now: clock }); } finally { await m.close(); }
    await gen.start();
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }

  // Each notice waits on the Tx it's given (store/notices.ts).
  // A keyed body queues none (refuseKeyed, D4), but those its caller opted in to by op (refuseKeyedNotice: renew's).
  const notices = makeNotices((tx, effect) => tx.afterCommit(effect), (tx, op, label, id) => refuseKeyedNotice(tx, op, label, id));
  const { change, marks } = notices;
  // The Repo's keyed write takes no options: `{ effects: true }` lives only on PgTransactions (D4, audit L7), and on
  // writeKeyedEffects, the named opt-in for the reviewed callers D4 lists (delivery's renew and receipt).
  const writeKeyed = ((keys: readonly string[], fn: (tx: Tx) => Promise<unknown>, committed?: (value: unknown) => unknown) => t.writeKeyed(keys, fn, committed)) as Repo["writeKeyed"];
  // The notices a keyed body may opt in to are fixed here, not by the caller (#1510 chunk 4 audit L1): renew's lease
  // columns' `hosted.update`, and refuseKeyedNotice allows it only for a row of the body's own root key.
  const writeKeyedEffects = ((keys: readonly string[], notices: readonly string[], fn: (tx: Tx) => Promise<unknown>, committed?: (value: unknown) => unknown) => {
    const other = notices.find(n => !KEYED_NOTICE_OPS.has(n));
    if (other !== undefined) return Promise.reject(new Error(`writeKeyedEffects: a keyed body may not queue ${other}'s notices; only ${[...KEYED_NOTICE_OPS].join(", ")} (docs/future/postgres-server.md D4)`));
    return t.writeKeyed(keys, fn, committed, { effects: true, notices });
  }) as NonNullable<Repo["writeKeyedEffects"]>;
  // The end a released hosted child's ID ends through, made from the finished Repo on first use, as db.ts openDatabase does.
  let port: SessionEndPort | undefined;
  const hosted = makePgHosted({ sessionEnd: deferredSessionEnd(() => port ??= sessionEndPort(opts.humanReach ?? "team")(repo)) });
  // The raw hosted store's ends, as SQLite's revokes call endHostedWhere: the revoke's own `change` notice covers them.
  const ends = makePgHostedEnds(hosted);
  const oauth = makePgOAuth({ hosted: ends });
  const identity = makePgIdentity({ now: clock, hosted: ends });
  const auth = makePgAuthCache(gen, oauth, identity.users);
  const aliases = makePgAliases({ clock });

  const repoHosted: RepoHosted = {
    ...hosted,
    insert: marks(hosted.insert, (_tx, row) => row.session_id, "hosted.insert"), update: marks(hosted.update, (_tx, id) => id, "hosted.update"),
    end: marks(hosted.end, (_tx, session) => session, "hosted.end"), childEnd: marks(hosted.childEnd, (_tx, session) => session, "hosted.childEnd"),
    park: marks(hosted.park, (_tx, session) => session, "hosted.park"), unpark: marks(hosted.unpark, (_tx, session) => session, "hosted.unpark"),
    write: t.write,
    writeKeyed,
    subscribe: notices.subscribe,
  };

  const repo: PgRepo = {
    now: clock,
    write: t.write,
    writeKeyed,
    post: t.post,
    postKeyed: t.postKeyed,
    readsOnly: t.readsOnly,
    writeKeyedEffects,
    writeQueue: t.queue,
    read: t.read,
    authRead: auth.authRead,
    authPeek: auth.authPeek,
    authGeneration: auth.authGeneration,
    commitGeneration: auth.commitGeneration,
    // The revokes notify, as on SQLite (db.ts makeRepo): a credential's add, rotate and mint only add authority.
    oauth: { ...oauth, findActiveAccess: auth.findActiveAccess, redeemCode: change(oauth.redeemCode, "oauth.redeemCode"), rotateRefresh: change(oauth.rotateRefresh, "oauth.rotateRefresh"),
      revokeToken: change(oauth.revokeToken, "oauth.revokeToken"), revokeServiceCredential: change(oauth.revokeServiceCredential, "oauth.revokeServiceCredential"),
      revokeServiceSecret: change(oauth.revokeServiceSecret, "oauth.revokeServiceSecret"), revokeUserGrant: change(oauth.revokeUserGrant, "oauth.revokeUserGrant") },
    hosted: repoHosted,
    users: { ...identity.users, isDisabled: auth.isDisabled, active: auth.active, setDisabled: change(identity.users.setDisabled, "users.setDisabled") },
    sessions: { ...identity.sessions, revokeAllForUser: change(identity.sessions.revokeAllForUser, "sessions.revokeAllForUser") },
    principals: identity.principals,
    teams: identity.teams,
    roles: identity.roles,
    services: identity.services,
    aliases,
    // The aliases instance itself: bindings takes its `lock`.
    bindings: makePgBindings({ clock, aliases }),
    attachments: makePgAttachments(),
    claims: makePgClaims({ clock }),
    boards: makePgBoards({ clock }),
    sessionEnd: makePgSessionEnd(),
    delegation: makePgDelegation(),
    messages: makePgMessages({ clock, attachmentLimits }),
    // No server path calls a core helper on a Postgres handle: core's statements are SQLite's.
    coreOn() { throw new Error("coreOn on a Postgres Repo: core's helpers run SQLite statements"); },
    close,
    cursors: makePgCursors(),
    audit: makePgAudit(),
    slack: makePgSlack({ clock }),
    writeReceipts: makePgWriteReceipts(),
    // Autovacuum returns Postgres's free space; logReclaimed stays silent on nothing reclaimed.
    storage: { async reclaimFreePages() { return { reclaimed: 0, remaining: 0, incremental: true }; } },
    blobs: blobStore(opts),
    attachmentLimits,
    attachmentUserQuota: opts.attachmentUserQuota ?? DEFAULT_ATTACHMENT_USER_QUOTA,
  };
  return repo;
}
