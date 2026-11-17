// The org Slack bridge: one Slack app for the whole server, enabled by
// SLACK_APP_TOKEN + SLACK_BOT_TOKEN. Each linked user talks to the app in
// their own DM with it, as their human identity "<email>/human". That identity
// uses the hosted application directly, sharing delivery, cursors, policy.ts authorize()
// and board access with agents. See docs/slack-org-bridge.md.
//
// Linking proves both sides: `grayboard slack link` (a signed-in grayboard
// user) gets a one-time code, and only the Slack account that sends it to the
// app gets linked.
import { randomInt } from "node:crypto";

import { forgetHandle, markHuman, refOf } from "../core/boards.ts";
import { boardNotification, dmNotification } from "../shared/notifications.ts";
import { HUMAN_NAME } from "../shared/addressing.ts";
import { Relay, fromSlack, type Bus, type ChannelParams, type RelayStore } from "../bridge/relay.ts";
import { SocketMode } from "../bridge/socket.ts";
import { SlackError, SlackWeb } from "../bridge/web.ts";
import { releaseStored, requestAttachment, storeUpload } from "./attachments.ts";
import { writeAudit } from "./audit.ts";
import type { AuthedUser } from "./auth.ts";
import type { Repo, SlackLink, SlackThread } from "./db.ts";
import { onAliasCreated } from "./teams.ts";
import { ApplicationError, type Application, type ApplicationSession, type DeliverySink, type RefusalRow } from "./application.ts";
import { CoreError } from "../core/errors.ts";
import { failureDiagnostic } from "./diagnostics.ts";
import { detached } from "./request_context.ts";
import type { Tx } from "./store/tx.ts";

/** users.info errors that mean Slack won't give this account's email, as opposed to Slack being unreachable. */
const NO_EMAIL = new Set(["missing_scope", "user_not_found", "user_not_visible"]);

const CODE_TTL_MS = 10 * 60_000;
// Wrong codes a Slack account may send per CODE_TTL_MS; 8 chars from 31 make
// guessing hopeless well before this.
const MAX_TRIES = 5;
const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
// A second notice for the same user inside this window is suppressed (the
// death still records): one flapping bridge must not spam its owner per
// retry. Counted against notices delivered, not deaths recorded, so an
// armed-but-undelivered notice survives a restart.
const BRIDGE_NOTIFY_DEDUP_MS = 60 * 60_000;

const NOT_LINKED =
  "This Slack account isn't linked to grayboard. In a terminal signed in to grayboard, run `grayboard slack link` and send me the code it prints.";

export type SlackBridgeOptions = {
  repo: Repo;
  application: Application;
  appToken: string;
  botToken: string;
  apiUrl?: string;
  log?: (msg: string) => void;
  /** Detail for checking Slack's behavior live (GRAYBOARD_SLACK_DEBUG). */
  debug?: (msg: string) => void;
  retryMs?: number;
};

/** What the HTTP routes need. */
export type SlackLinker = {
  // False once the bridge has stopped (failed to start, or Slack ended it).
  readonly running: boolean;
  newCode(authed: AuthedUser): { code: string; expires_in_s: number; linked: boolean };
  unlink(userId: number): Promise<boolean>;
  // A user was disabled or enabled: take their human offline, or back.
  userChanged(userId: number): Promise<void>;
};

type Linked = { link: SlackLink; session: ApplicationSession; relay: Relay };

export class SlackBridge implements SlackLinker {
  private readonly web: SlackWeb;
  private readonly app: SlackWeb;
  private socket: SocketMode | null = null;
  private readonly linked = new Map<number, Linked>();
  private readonly codes = new Map<string, { userId: number; expires: number }>();
  private readonly tries = new Map<string, { n: number; until: number }>();
  private readonly log: (msg: string) => void;
  private stopped = false;

  constructor(private readonly o: SlackBridgeOptions) {
    this.web = new SlackWeb(o.botToken, o.apiUrl);
    this.app = new SlackWeb(o.appToken, o.apiUrl);
    this.log = o.log ?? ((msg) => console.error(`[grayboard slack] ${msg}`));
  }

  /** Connect to Slack and bring every linked user's human online. */
  async start(): Promise<void> {
    const me = await this.web.call<{ user_id: string; team?: string }>("auth.test");
    for (const link of this.o.repo.slack.links(this.o.repo.read)) await this.attach(link);
    this.socket = new SocketMode({
      open: async () => (await this.app.call<{ url: string }>("apps.connections.open")).url,
      onEvent: (payload) => this.onEvent(payload),
      onFatal: (reason) => {
        this.log(`stopping: ${reason}`);
        this.stop({ fatal: true, detail: reason });
      },
      log: this.log,
      debug: this.o.debug,
    });
    await this.socket.start();
    this.log(`Slack bridge up as bot ${me.user_id}${me.team ? ` (${me.team})` : ""}; ${this.linked.size} linked`);
  }

  get running(): boolean {
    return !this.stopped;
  }

  /**
   * Deliberate teardown (app shutdown) passes no reason: the bridge goes down
   * silently, because the operator knows. The fatal shape — Slack ended the
   * connection, or startup failed — records one `bridge.stopped` audit row per
   * linked user; that row is the pending notice, drained by the user's next
   * agent-session selection (src/server/application.ts), deduped to one delivered notice
   * per user per BRIDGE_NOTIFY_DEDUP_MS so a flapping bridge can't spam its
   * owner.
   */
  stop(reason?: { fatal: true; detail: string }): void {
    this.stopped = true;
    this.socket?.stop();
    for (const userId of [...this.linked.keys()]) this.detach(userId);
    if (!reason?.fatal) return;
    const at = Date.now();
    // Durable links, not the in-memory map: a boot-time failure (revoked
    // token, Slack outage) throws before any link is attached, and that is
    // exactly the death the owner must hear about (app.ts's catch). A
    // disabled user's human is offline by admin action, not the bridge's
    // death, so their row is skipped.
    // One posted write (#807 D4): stop() is sync, called from startup's catch and Slack's close; the dedup read
    // and the insert share its transaction.
    const { repo } = this.o;
    repo.post(tx => {
      for (const link of repo.slack.links(tx)) {
        const user = repo.users.findById(link.user_id);
        if (!user || user.disabled_at !== null) continue;
        const target = `${link.email}/${HUMAN_NAME}`;
        // Dedup against the last DELIVERED notice, not the last death: the
        // unsuppressed row itself is what's owed, so a notice armed but not
        // yet delivered survives a restart. `last()` before the insert and
        // the clamp ride out clock skew in both directions.
        const last = repo.audit.last(tx, "bridge.notified", target);
        const prior = last && at - last.at >= 0 && at - last.at < BRIDGE_NOTIFY_DEDUP_MS;
        writeAudit(repo, tx, "bridge.stopped", null, target, {
          reason: reason.detail,
          at: new Date(at).toISOString(),
          ...(prior ? { suppressed: true } : {}),
        });
      }
    }, undefined, "bridge.stopped audit");
  }

  // ── linking ────────────────────────────────────────────────────────────────

  newCode(authed: AuthedUser): { code: string; expires_in_s: number; linked: boolean } {
    const now = Date.now();
    for (const [c, v] of this.codes) if (v.userId === authed.user_id || v.expires <= now) this.codes.delete(c);
    let code = "";
    for (let i = 0; i < 8; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    this.codes.set(code, { userId: authed.user_id, expires: now + CODE_TTL_MS });
    return { code, expires_in_s: CODE_TTL_MS / 1000, linked: !!this.o.repo.slack.linkFor(this.o.repo.read, authed.user_id) };
  }

  /** Remove a user's link and their human identity. False if they had none. */
  // One transaction through the write queue (#807 D4); the human goes offline after it commits, so a rolled-back
  // unlink leaves it linked and attached.
  // `slackUser`: only that Slack account's link (the Slack `unlink` command), re-checked inside the write, since a
  // relink to another account may have committed while it waited.
  unlink(userId: number, slackUser?: string): Promise<boolean> {
    const { repo } = this.o;
    return repo.write((tx: Tx): boolean => {
      const link = repo.slack.linkFor(tx, userId);
      if (!link || (slackUser !== undefined && link.slack_user !== slackUser)) return false;
      repo.slack.unlink(tx, userId);
      // Unread DMs to an identity nobody reads would only pile up; a later link
      // starts from the newest message (see linkUser).
      const handle = `${link.email}/${HUMAN_NAME}`;
      repo.aliases.remove(tx, handle);
      forgetHandle(repo.coreOn(tx), handle);
      writeAudit(repo, tx, "slack.unlinked", link.email, link.slack_user);
      return true;
    }, unlinked => { if (unlinked) this.detach(userId); return unlinked; });
  }

  async userChanged(userId: number): Promise<void> {
    this.detach(userId);
    const link = this.o.repo.slack.linkFor(this.o.repo.read, userId);
    if (link) await this.attach(link);
  }

  private async linkUser(slackUser: string, channel: string, ts: string, code: string): Promise<void> {
    const { repo } = this.o;
    const now = Date.now();
    const t = this.tries.get(slackUser);
    if (t && t.until > now && t.n >= MAX_TRIES) {
      return this.say(channel, ts, "Too many wrong codes; try again in a few minutes.");
    }
    const entry = this.codes.get(code.toLowerCase());
    if (!entry || entry.expires <= now) {
      this.tries.set(slackUser, t && t.until > now ? { n: t.n + 1, until: t.until } : { n: 1, until: now + CODE_TTL_MS });
      return this.say(channel, ts, "That code isn't valid or has expired. Run `grayboard slack link` for a new one.");
    }
    this.codes.delete(code.toLowerCase());
    this.tries.delete(slackUser);
    const user = repo.users.findById(entry.userId);
    if (!user) return;
    const other = repo.slack.linkBySlackUser(repo.read, slackUser);
    if (other && other.user_id !== user.id) {
      return this.say(channel, ts, `This Slack account is linked to \`${other.email}\`. Send \`unlink\` first.`);
    }
    // A code proves the CLI's token, not who sends it: only the Slack account
    // with the user's own email may redeem it (#805 F-05).
    const email = await this.slackEmail(slackUser);
    if (email === "unavailable") {
      await repo.write(tx => writeAudit(repo, tx, "slack.link_refused", user.email, slackUser, { reason: "slack_unavailable" }));
      return this.say(channel, ts, "grayboard couldn't reach Slack to check this account's email, and the code is used up. Run `grayboard slack link` for a new one and try again.");
    }
    if (email === null) {
      await repo.write(tx => writeAudit(repo, tx, "slack.link_refused", user.email, slackUser, { reason: "no_email" }));
      return this.say(channel, ts, "grayboard can't read your Slack account's email, so it can't check this link. Ask the server's admin to add the users:read and users:read.email scopes to the Slack app and reinstall it.");
    }
    if (email !== user.email) {
      await repo.write(tx => writeAudit(repo, tx, "slack.link_refused", user.email, slackUser, { reason: "email_mismatch" }));
      return this.say(channel, ts, `This Slack account's email isn't \`${user.email}\`; link from that account. The code is used up.`);
    }

    // The link and its human identity commit in one transaction through the write queue (#807 D4). The Slack
    // account is checked again inside it: the email check above awaited Slack. The old human goes offline and the
    // new one attaches after the commit, with no await between them, so a concurrent unlink can't leave attach()
    // without its link.
    type Linked = { taken: SlackLink } | { moved: SlackLink | undefined; link: SlackLink };
    const done = await repo.write(async (tx: Tx): Promise<Linked> => {
      const taken = repo.slack.linkBySlackUser(tx, slackUser);
      if (taken && taken.user_id !== user.id) return { taken };
      const previous = repo.slack.linkFor(tx, user.id);
      repo.slack.link(tx, user.id, slackUser, channel);
      const moved = previous && previous.slack_user !== slackUser ? previous : undefined;
      if (moved) writeAudit(repo, tx, "slack.relinked", user.email, slackUser, { from: moved.slack_user });
      const handle = `${user.email}/${HUMAN_NAME}`;
      if (!repo.aliases.find(tx, handle)) {
        // Start from now: drop what queued for an earlier link's alias.
        forgetHandle(repo.coreOn(tx), handle);
        repo.aliases.create(tx, { scope_kind: "person", scope_ref: user.email, name: HUMAN_NAME }, user.email);
        writeAudit(repo, tx, "alias.created", user.email, handle, { slack: true });
        onAliasCreated(repo, tx, user.id, handle);
        const newest = repo.messages.history(tx, [handle], undefined, 1)[0];
        if (newest) await repo.cursors.advance(tx, handle, "direct", handle, newest.id);
      }
      markHuman(repo.coreOn(tx), handle, true);
      writeAudit(repo, tx, "slack.linked", user.email, slackUser);
      return { moved, link: repo.slack.linkFor(tx, user.id)! };
    }, (r): Linked & { attached?: Promise<void> } => {
      if ("taken" in r) return r;
      this.detach(user.id);
      return { ...r, attached: this.attach(r.link) };
    });
    if ("taken" in done) {
      return this.say(channel, ts, `This Slack account is linked to \`${done.taken.email}\`. Send \`unlink\` first.`);
    }
    await done.attached;
    const { moved } = done;
    if (moved) {
      // Moving a link is never silent: the account it leaves hears so.
      await this.say(moved.dm_channel, undefined, `\`${user.email}\` is now linked to another Slack account; this one no longer gets its agents' messages.`);
    }
    await this.say(
      channel,
      ts,
      `Linked to \`${user.email}\`. Your agents reach you here as "${HUMAN_NAME}"; each conversation gets its own thread, and your reply in it goes back to that conversation. To start one, begin a message with "@agent" or "#board". \`unlink\` stops it.`,
    );
  }

  /**
   * The Slack account's email, lowercased; null if Slack won't say (missing
   * scope, unknown user, no email); "unavailable" if Slack couldn't be asked.
   */
  private async slackEmail(slackUser: string): Promise<string | null | "unavailable"> {
    try {
      const r = await this.web.call<{ user?: { profile?: { email?: string } } }>("users.info", { user: slackUser }, { form: true });
      const email = r.user?.profile?.email?.trim().toLowerCase();
      return email ? email : null;
    } catch (e) {
      this.log(`users.info for ${slackUser} failed: ${e instanceof Error ? e.message : String(e)}`);
      if (e instanceof SlackError && NO_EMAIL.has(e.code)) return null;
      return "unavailable";
    }
  }

  // ── a linked user's human ──────────────────────────────────────────────────

  private async attach(link: SlackLink): Promise<void> {
    const { repo } = this.o;
    const user = repo.users.findById(link.user_id);
    if (!user || user.disabled_at !== null || this.stopped) return;
    const prefix = `${link.email}/`;
    const handle = `${prefix}${HUMAN_NAME}`;
    const authed: AuthedUser = { user_id: link.user_id, user_email: link.email, session_id: 0 };

    let relay!: Relay;
    const application = this.o.application;
    let session!: ApplicationSession;
    const sink: DeliverySink = {
      closed: () => this.detach(link.user_id),
      deliver(m) {
        // The relay's one drain loop carries every queued item, whoever's
        // request started it: detached, so its rows carry no request's
        // address (security audit F-19).
        if (m.kind === "direct") detached(() => relay.notify(dmNotification(m.message)));
        else if (m.item.kind === "digest") {
          try { repo.post(tx => application.receiptBoards(tx, session, [refOf(m.item)]), undefined, "Slack digest receipt"); } catch {}
        }
        else detached(() => relay.notify(boardNotification(m.item)));
      },
    };

    // The outbox is memory: an item is acked to the hub only once Slack has
    // it, so one that never made it is resent at the next start. How far it
    // got is in the database, keyed by the item, so that resend resumes.
    const outbox = new Map<number, ChannelParams>();
    let next = 0;
    const ref = (id: number) => {
      const m = outbox.get(id)?.meta ?? {};
      return m.board && m.post_id ? `post:${m.post_id}` : `dm:${m.message_id}`;
    };
    // The store's writes are posted (#807 D4), not awaited: the relay awaits each call (#807 P3 A5), but these still
    // answer before their write commits. A post waits behind another body's hold, and its reads go to committed
    // state, so a read could miss the relay's own earlier write (#1016): a second item in a new thread posted
    // unthreaded, a stale peer, a retry's stale progress. Until its last write commits, a row's value as those
    // writes leave it is kept here, and reads take it first. An entry is
    // dropped by the commit of the write that last set it. One whose write failed stays, best effort, until a later
    // write on that row commits: the relay did what it records.
    let seq = 0;
    const pendingThreads = new Map<string, { row: SlackThread; seq: number }>();
    const pendingProgress = new Map<string, { value: unknown; seq: number }>();
    const threadByTs = (ts: string) => pendingThreads.get(ts)?.row ?? repo.slack.threadByTs(repo.read, link.user_id, ts);
    const postThread = (row: SlackThread, write: (tx: Tx) => void, what: string) => {
      const mine = ++seq;
      pendingThreads.set(row.thread_ts, { row, seq: mine });
      repo.post(write, () => { if (pendingThreads.get(row.thread_ts)?.seq === mine) pendingThreads.delete(row.thread_ts); }, what);
    };
    const store: RelayStore = {
      thread: (kind, board, root) => {
        for (const { row } of pendingThreads.values()) if (row.kind === kind && (row.board ?? null) === (board ?? null) && row.root_id === root) return row;
        return repo.slack.thread(repo.read, link.user_id, kind, board, root);
      },
      byTs: threadByTs,
      // INSERT OR IGNORE: a row already there stays as it is.
      addThread: (row) => {
        if (threadByTs(row.thread_ts)) { repo.post(tx => repo.slack.addThread(tx, link.user_id, row), undefined, "Slack thread row"); return; }
        postThread({ ...row, board: row.board ?? null }, tx => repo.slack.addThread(tx, link.user_id, row), "Slack thread row");
      },
      // As advanceThread's UPDATE: last_id only moves forward, and peer follows only a newer id.
      advance: (ts, id, peer) => {
        const write = (tx: Tx) => repo.slack.advanceThread(tx, link.user_id, ts, id, peer);
        const row = threadByTs(ts);
        if (!row) { repo.post(write, undefined, "Slack thread advance"); return; }
        postThread({ ...row, peer: peer != null && id > row.last_id ? peer : row.peer, last_id: Math.max(row.last_id, id) }, write, "Slack thread advance");
      },
      enqueue: (params) => {
        outbox.set(++next, params as ChannelParams);
        return next;
      },
      pending: () => [...outbox].map(([id, p]) => ({ id, params: JSON.stringify(p) })),
      progress: (id) => {
        const r = ref(id), pending = pendingProgress.get(r);
        return pending ? structuredClone(pending.value) : repo.slack.progress(repo.read, link.user_id, r);
      },
      setProgress: (id, progress) => {
        // A copy: the relay keeps mutating its progress object after saving it, as the stored JSON doesn't see.
        const r = ref(id), mine = ++seq, value = structuredClone(progress);
        pendingProgress.set(r, { value, seq: mine });
        repo.post(tx => repo.slack.setProgress(tx, link.user_id, r, value), () => { if (pendingProgress.get(r)?.seq === mine) pendingProgress.delete(r); }, "Slack progress");
      },
      done: (id) => {
        const p = outbox.get(id);
        const m = p?.meta ?? {};
        if (!session.active) throw new Error("Slack delivery session ended before receipt");
        // The receipt validates the live session; it and the progress clear are one posted write (#807 D4). Its body
        // awaits the cursor write (#807 P3 A6a), so it commits after post returns, even on an idle queue: the item
        // leaves the outbox now so the drain doesn't post it again; a refusal then rolls both back and is logged, and
        // the unacked item is resent at the next start.
        const r = ref(id);
        const now = repo.post(async tx => {
          // A message Slack refused (msg_too_long) is given up, never posted: its cursor moves but it isn't stamped
          // delivered (#470). Read in the body, after the progress writes queued before it.
          const posted = (repo.slack.progress(tx, link.user_id, r) as { posted?: boolean } | undefined)?.posted === true;
          if (m.board && m.post_id) application.receiptBoards(tx, session, [{ kind: "push", post_id: Number(m.post_id) }]);
          else if (m.message_id) await application.receiptDirect(tx, session, [Number(m.message_id)], { handed: posted });
          repo.slack.clearProgress(tx, link.user_id, r);
        }, () => { outbox.delete(id); pendingProgress.delete(r); }, "Slack receipt");
        if (!now) outbox.delete(id);
      },
    };

    // A Slack user's tool call runs in one transaction through the write queue (#807 D4), as a hosted call does
    // (hosted.run): its refusal rows, which the rollback would drop, are written after it in a body of their own.
    // Bodies hold the write queue one at a time, so the shared session's afterRollback is set only inside one, and
    // cleared once fn (an application operation, async since #807 P1c-3) settles.
    const inWrite = async <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => {
      const rows: RefusalRow[] = [];
      try {
        return await repo.write(async tx => {
          rows.length = 0;
          session.afterRollback = write => { rows.push(write); };
          try { return await fn(tx); } finally { session.afterRollback = undefined; }
        }) as T;
      } catch (error) {
        if (rows.length) {
          await repo.write(async tx => {
            for (const write of rows) {
              try { await tx.savepoint(write); } catch (failure) { console.error("[grayboard slack] refusal row failed:", failure); }
            }
          }).catch(failure => console.error("[grayboard slack] refusal rows failed:", failure));
        }
        throw error;
      }
    };
    const bus: Bus = {
      async call(name, args) {
        try {
          if (name === "dm_send") {
            return { ok: true, value: await inWrite(tx => application.send(tx, session, String(args.to), String(args.body), {
              ...(args.parent_id !== undefined ? { parent_id: Number(args.parent_id) } : {}),
              ...(args.attachment_ids !== undefined ? { attachment_ids: args.attachment_ids as number[] } : {}),
            })) };
          }
          if (name === "dm_thread") {
            return { ok: true, value: await inWrite(tx => application.thread(tx, session, Number(args.thread))) };
          }
          return { ok: true, value: await inWrite(tx => application.call(tx, session, name, args)) };
        } catch (e) {
          if (e instanceof ApplicationError && e.code !== "internal" || e instanceof CoreError) return { ok: false, error: e.message, ...(typeof (e as { code?: unknown }).code === "string" ? { code: (e as { code: string }).code } : {}) };
          console.error(`[grayboard slack] bus call failed: ${JSON.stringify({ principal: link.user_id, identity: handle, session: session.sessionId, tool: name, protocol: "slack", ...failureDiagnostic("slack-bus", e) })}`);
          return { ok: false, error: "internal error" };
        }
      },
      // In process: the read check the download route makes, and the store an
      // upload makes, audited the same way.
      async attachment(id) {
        const read = requestAttachment(repo, repo.read, handle, String(id), null, { user: link.email, address: handle }, { via: "slack" });
        if ("refused" in read) throw new Error(read.refused);
        const { row } = read;
        return { id: row.id, filename: row.filename, type: row.type, size: row.size, sha256: row.sha256, data: await repo.blobs.get(row.sha256) };
      },
      // Files the relay checked (checkFile), stored as the HTTP upload route
      // stores them; released again if the send doesn't carry them.
      async withFiles(files, send) {
        const ids: number[] = [];
        let sent = false;
        try {
          for (const f of files) ids.push((await storeUpload(repo, link.email, handle, f, { slack_file: f.slack_file })).id);
          const r = await send({ attachment_ids: ids });
          sent = (r as { ok?: boolean }).ok !== false;
          return r;
        } finally {
          if (!sent) for (const id of ids) await releaseStored(repo, link.email, handle, id, { via: "slack" });
        }
      },
    };

    relay = new Relay(store, bus, this.web, {
      channel: link.dm_channel,
      owner: link.slack_user,
      log: (msg) => this.log(`${link.email}: ${msg}`),
      debug: this.o.debug,
      // E.g. the user left the workspace: take their human offline, so
      // senders see it queue instead of "delivered".
      onFatal: (reason) => {
        this.log(`${link.email}: stopped relaying: ${reason}`);
        this.detach(link.user_id);
      },
      retryMs: this.o.retryMs,
      label: (h) => (h.startsWith(prefix) ? h.slice(prefix.length) : h),
      attachmentLimits: repo.attachmentLimits,
      onFileSent: (f) => void repo.post(tx =>
        writeAudit(repo, tx, "attachment.sent_to_slack", link.email, `attachment:${f.attachment}`, {
          identity: handle, channel: link.dm_channel, thread_ts: f.thread_ts, slack_file: f.slack_file, sha256: f.sha256,
        }), undefined, "Slack file audit"),
      onFileRefused: (f) => void repo.post(tx =>
        writeAudit(repo, tx, "attachment.slack_refused", link.email, f.attachment === null ? null : `attachment:${f.attachment}`, {
          identity: handle, channel: link.dm_channel, filename: f.name, reason: f.why, ...(f.sha256 ? { sha256: f.sha256 } : {}),
        }), undefined, "Slack file audit"),
    });
    try {
      // Checked again inside attachHuman's write: an unlink, relink, disable or stop may have committed while it
      // waited in the queue.
      ({ session } = await application.attachHuman(authed, sink, tx => {
        if (this.stopped) return "the Slack bridge stopped";
        const now = repo.slack.linkFor(tx, link.user_id);
        return now && now.slack_user === link.slack_user && now.dm_channel === link.dm_channel ? null : "the Slack link changed";
      }));
      this.linked.set(link.user_id, { link, session, relay });
      await application.replay(session);
    } catch (e) {
      this.log(`${link.email}: couldn't bring the human online: ${(e as Error).message}`);
      // Undo this attempt only (#385): a replay that threw after the set is
      // this attempt's entry; anything else in `linked` is another live one.
      if (this.linked.get(link.user_id)?.relay === relay) this.detach(link.user_id);
      else relay.stop();
    }
  }

  private detach(userId: number): void {
    const l = this.linked.get(userId);
    if (!l) return;
    this.linked.delete(userId);
    l.relay.stop();
    this.o.application.close(l.session);
  }

  // ── Slack → grayboard ──────────────────────────────────────────────────────

  private async onEvent(payload: Record<string, unknown>): Promise<void> {
    if (payload.type !== "event_callback") return;
    const e = payload.event as Record<string, unknown> | undefined;
    // Only people's new messages in a DM with the app, with or without files:
    // no edits, deletes or bot posts, including our own.
    if (!e || e.type !== "message" || e.channel_type !== "im" || (e.subtype && e.subtype !== "file_share") || e.bot_id || !e.user) return;
    const user = String(e.user);
    const channel = String(e.channel);
    const ts = String(e.ts);
    const threaded = e.thread_ts && e.thread_ts !== e.ts;
    const text = fromSlack(String(e.text ?? "")).trim();
    if (!threaded) {
      const code = /^link\s+([a-z0-9]{4,16})$/i.exec(text);
      if (code) return this.linkUser(user, channel, ts, code[1]!);
      if (/^unlink$/i.test(text)) {
        const link = this.o.repo.slack.linkBySlackUser(this.o.repo.read, user);
        const unlinked = link ? await this.unlink(link.user_id, user) : false;
        return this.say(channel, ts, link && unlinked ? `Unlinked from \`${link.email}\`. Agents' messages to "${HUMAN_NAME}" won't reach you here.` : NOT_LINKED);
      }
    }
    const link = this.o.repo.slack.linkBySlackUser(this.o.repo.read, user);
    const l = link && this.linked.get(link.user_id);
    if (!l) return this.say(channel, threaded ? String(e.thread_ts) : ts, link ? "Your link is offline; the server log says why." : NOT_LINKED);
    await l.relay.onEvent(payload);
  }

  private async say(channel: string, threadTs: string | undefined, text: string): Promise<void> {
    try {
      await this.web.call("chat.postMessage", { channel, thread_ts: threadTs, markdown_text: text });
    } catch (e) {
      this.log(`couldn't reply in ${channel}: ${(e as Error).message}`);
    }
  }
}
