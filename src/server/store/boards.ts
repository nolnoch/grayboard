// The boards store's group interface (#807 P3 C10e-a, docs/future/postgres-server.md D2): boards, posts, their
// subscriptions, outbox pushes, thread mutes and a queue post's claim, which Repo (db.ts) composes and the Postgres
// store (pg/, C10e1 and C10e2) implements. Type-only imports, so a module under pg/ may import it (pg/isolation.test.ts).
// The SQLite store delegates to core (core/boards.ts, core/attachments.ts); boards.contract.ts pins each method's
// serial answer on both stores.
//
// Visibility is the caller's (BoardAccess, src/server/access.ts): nothing here filters by it, and no method judges a
// lane (core orderLanes' isViewer, sees and mayLane are the server's, over laneRows' rows). Every read returns a
// promise on the caller's handle and every write runs on the caller's Tx; a settled Tx is refused. A Read sees
// committed state; a body's Tx sees its own writes. Each write is atomic with its body: a body that throws leaves
// none of it. Name order is byte order (SQLite BINARY, Postgres COLLATE "C"). The wall clock a method stamps
// (ensure's created_at, read's and acknowledge's delivered_at) is the store's.
import type {
  Board, BoardSnapshot, BoardSummary, BoardView, DigestRow, NewPost, PendingRef, PostTarget, PushRow, ReadResult,
  RedeliveryFacts, SnapshotOptions, SubMode, ThreadFacts, WhoRow,
} from "../../core/boards.ts";
import type { Uploader } from "../../core/attachments.ts";
import type { Post } from "../../shared/notifications.ts";
import type { AttachmentInfo, AttachmentLimits } from "../../shared/attachments.ts";
import type { Read, Tx } from "./tx_base.ts";

export type {
  Board, BoardSnapshot, BoardSummary, BoardView, DigestRow, NewPost, PendingRef, PostTarget, PushRow, ReadResult,
  RedeliveryFacts, SnapshotOptions, SubMode, ThreadFacts, WhoRow,
};

export interface BoardsStore {
  // ── reads of boards and posts ──
  // The board, or undefined. An open board carries no archived_at/archived_by keys; an archived one carries both.
  get(r: Read, name: string): Promise<Board | undefined>;
  // The post (its reader columns: via only when a child wrote it), or undefined.
  post(r: Read, id: number): Promise<Post | undefined>;
  // Up to CATALOG_PAGE (100) boards named after `cursor` ("" for the first), in name order, archived ones included
  // (core catalogPage).
  catalogPage(r: Read, cursor: string): Promise<Board[]>;
  // A page of a board already judged visible (core snapshotPage): its options checked first (a CoreError: "snapshot
  // limit must be an integer from 1 to 100", "snapshot before_id must be a positive safe integer"), then up to `limit`
  // (default 20) posts before `before_id` (or the newest), oldest first, with their attachments; next_before_id is the
  // page's oldest id when older posts remain, else null.
  snapshotPage(r: Read, board: string, opts: SnapshotOptions): Promise<Omit<BoardSnapshot, "board">>;
  // The handle's undelivered pushes by post id, oldest first, with attachments; wake a boolean (core pendingPushes).
  pendingPushes(r: Read, handle: string): Promise<PushRow[]>;
  // The handle's due digests (core pendingDigests, DIGEST_SQL): one per digest subscription (queue boards excluded)
  // with nothing sent since its last catch-up (notified_id <= cursor) and posts after its cursor that are neither its
  // own nor pushed to it; unread counts them and latest is the newest. Any board order.
  pendingDigests(r: Read, handle: string): Promise<DigestRow[]>;
  // Marks a pending item delivered to `handle` (core acknowledge). A push: its outbox row stamped delivered, and for
  // a subscription push a push-mode subscription's cursor and notified_id moved up to the post (never back); an
  // outbox row that isn't there is a no-op. A digest: the subscription's notified_id moved up to latest_id.
  acknowledge(tx: Tx, handle: string, ref: PendingRef): Promise<void>;

  // ── a mode's bookkeeping (#807 P3 B5b1): the board writes outside the tools, unchecked ──
  // Creates the board (its name normalized) unless one has the name: no creator subscription, no kind (broadcast);
  // false, writing nothing, when it existed (core ensureBoard).
  ensure(tx: Tx, name: string, purpose: string, scope: string | null, createdBy: string): Promise<boolean>;
  isSubscribed(r: Read, handle: string, board: string): Promise<boolean>;
  // "off" deletes the subscription (none is a no-op). Another mode is checked (a CoreError "mode must be push,
  // digest, quiet, or off", writing nothing), then a new subscription starts at the board's tip (cursor and
  // notified_id the newest post's id, 0 on an empty board: no backlog); an existing one changes mode only, its cursor
  // kept (core setSubscription).
  setSubscription(tx: Tx, handle: string, board: string, mode: SubMode | "off"): Promise<void>;
  // Deletes the handle's subscriptions to every board of `scope`; others stay (core unsubscribeScope).
  unsubscribeScope(tx: Tx, handle: string, scope: string): Promise<void>;
  // A deleted handle (core forgetHandle): its pushes, subscriptions, thread mutes, claim watches and its alias's hold
  // go; its posts and claims stay (history). Another handle's rows stay.
  forget(tx: Tx, handle: string): Promise<void>;
  // Retention (core prunePosts), atomic with the caller's body: posts created before `olderThan` go with their
  // pushes, mutes of their threads and attachments, a surviving reply to one becoming a root; claim events before it
  // go; binding events last stamped before it go, except each name's latest bound or moved event. Claims are left
  // to the sweep. Returns the boards that lost posts, in name order.
  prunePosts(tx: Tx, olderThan: number): Promise<string[]>;

  // ── the board tools' reads (#807 P3 B5b1b1), unjudged ──
  // Each of `handles`' view of every board (of `board` alone), in `handles`' order, then board name (core
  // boardViewRows): the board, its post count, the handle's subscription mode (null for none) and its unread count
  // (0 unsubscribed; else posts after its cursor neither its own nor pushed to it, a deferred push still waiting
  // counting as unread).
  views(r: Read, handles: string[], board: string | null): Promise<BoardView[]>;
  // Every open (unarchived) board with no mode and nothing unread, its post count, by name (core openSummaryRows).
  openSummaries(r: Read): Promise<BoardSummary[]>;
  // peer_list's roster (core whoRows): with `board` null, every alias ever seen (last_seen set), by address; with a
  // board, its subscribers by handle, a session's ID subscription listed under its primary hold (a name's own row
  // winning), one row per handle. Each with its session's facts; the integer columns (human, queue_off, launcher)
  // read 1/0/null on every store.
  roster(r: Read, board: string | null): Promise<WhoRow[]>;

  // ── the board tools' writes (#807 P3 B5b1b2), arguments and access already checked ──
  // The new board, or null, writing nothing, when the name is taken (core insertBoard); no creator subscription.
  create(tx: Tx, b: { name: string; purpose: string; scope: string | null; kind: string; createdBy: string; now: number }): Promise<Board | null>;
  // Archives the board as `by` at `now`, or with `by` null reopens it: the board after, or null when it was already in
  // that state (or there's no such board), writing nothing, so a second archive never moves the first's archived_at
  // or archived_by (core setArchived). The conditional write is the check: two archives give one board.
  setArchived(tx: Tx, name: string, by: string | null, now: number): Promise<Board | null>;
  // A read of a board already judged visible (core readRows), with attachments. thread: every post of the thread the
  // post is in, on this board, by id. before_id: up to `limit` (1..200, default 20) posts before it, oldest first.
  // Else the handle's unread (as views counts it) oldest first, up to limit, or when there is none the latest limit
  // (10 when limit is absent), oldest first. With a handle, its cursor moves up to the newest post returned (never
  // back) and its undelivered pushes of the returned posts are stamped delivered; unread_remaining is what's still
  // unread. A null handle (a peek) changes nothing and reports 0.
  read(tx: Tx, board: string, handle: string | null, opts: { limit?: number; before_id?: number; thread?: number }): Promise<ReadResult>;
  // The root of the thread postId is in; postId itself when it's a root or missing (core threadRoot).
  threadRoot(r: Read, postId: number): Promise<number>;
  // Mutes the thread at `root` for `handle` (a repeat is a no-op), or unmutes it (core setMute).
  mute(tx: Tx, handle: string, root: number, muted: boolean): Promise<void>;

  // ── board_post's reads and writes (#807 P3 B5b2), its gate passed ──
  // Writes the post's row, its human mark as given (#1355: true reads marked, false unmarked), and returns it as
  // `post` would (core insertPost). A parentId naming no post rejects with MissingPost (store/errors.ts, a CoreError
  // with the gate's text "parent_id N is not a post on #board"), writing nothing and leaving the body usable: a
  // backstop for a parent pruned after the gate read it (#807 P3 C10e2 P1).
  insertPost(tx: Tx, p: NewPost): Promise<Post>;
  // Binds `from`'s unsent uploads `ids` to the post under the size caps, returning them in call order; rejects with
  // CoreError on an id that isn't one or a total over the cap, binding none (core bindAttachments).
  bindAttachments(tx: Tx, ids: number[], from: Uploader, postId: number, limits: AttachmentLimits): Promise<AttachmentInfo[]>;
  // An author's address set (core authorAddresses): itself, its writing session's ID and holds, and for a child its
  // root's ID and holds. A set: each once, in any order.
  authorAddresses(r: Read, author: string, authorId: string | null): Promise<string[]>;
  // A board's subscriptions, by handle (core subscriberRows).
  subscribers(r: Read, board: string): Promise<{ handle: string; mode: SubMode }[]>;
  // What a reply to parentId, a post that exists, reads of its thread (core threadFacts): its root, the thread's
  // authors in order of their first post, the parent's and root's authors, and who muted the root (any order).
  threadFacts(r: Read, parentId: number): Promise<ThreadFacts>;
  // A queue board's lanes before any judgment (core queueLaneRows): each push subscriber as its session's primary
  // hold (or itself), less `poster`'s addresses, kept only when it is an alias not opted out (queue_off) or an unended
  // ID, and not a human; least
  // recently woken first (its latest queue take on the board or push of one of its posts, under any of its session's
  // addresses; never woken first), then by name. The server orders them with core orderLanes and its BoardAccess
  // (isViewer, sees, mayLane: #1260), which this method takes no part in.
  laneRows(r: Read, board: string, poster: string[]): Promise<string[]>;
  // Claims queue post postId for `lane` (core claimQueuePost): key `queue:<board>:<postId>`, holder_user the lane's
  // session's principal, expiring QUEUE_CLAIM_TTL_MS after now, a take event. True when this run took the key. With
  // `push`, the lane's subscription push is written or reset (undelivered, waking) only when the lane holds the key
  // after the claim (#1357): a key another lane holds writes no claim, event or push, and returns false; a key the
  // lane itself holds already returns false with its push reset (a re-offer reaches it, at-least-once), no event.
  claimQueuePost(tx: Tx, board: string, postId: number, lane: string, now: number, o: { note: string; push: boolean }): Promise<boolean>;
  // A post plan's outbox rows (core insertOutbox); a row already there for a handle stays as it is.
  insertOutbox(tx: Tx, postId: number, targets: [string, PostTarget][]): Promise<void>;
  // A queue post's redelivery facts for a claim on `key` that `prevHolder` held (core redeliveryFacts): its board and
  // post id, the post's author addresses and writer, how many sessions took it, and every address that held it with
  // every address of its session now. Null when `key` names no queue post of an existing board.
  redeliveryFacts(r: Read, key: string, prevHolder: string): Promise<RedeliveryFacts | null>;
}
