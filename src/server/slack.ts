// The org Slack bridge: one Slack app for the whole server, enabled by
// SLACK_APP_TOKEN + SLACK_BOT_TOKEN. Each linked user talks to the app in
// their own DM with it, as their human identity "<email>/human". That identity
// is an in-process connection in the hub, speaking the same frames a client
// does, so delivery, cursors, canSend and board access are the paths agents'
// sessions take. See docs/slack-bridge.md.
//
// Linking proves both sides: `grayboard slack link` (a signed-in grayboard
// user) gets a one-time code, and only the Slack account that sends it to the
// app gets linked.
import { randomInt } from "node:crypto";

import { forgetHandle, markHuman, refOf, type CoreDb } from "../core/boards.ts";
import { boardNotification, dmNotification } from "../core/tools.ts";
import { HUMAN_NAME } from "../shared/addressing.ts";
import { PROTO, type BoardPush, type CallOk, type ClientMessage, type HelloOk, type PushMessage, type SendOk, type ServerMessage, type ThreadOk } from "../shared/protocol.ts";
import { Relay, fromSlack, type Bus, type ChannelParams, type RelayStore } from "../bridge/relay.ts";
import { SocketMode } from "../bridge/socket.ts";
import { SlackWeb } from "../bridge/web.ts";
import { readableAttachment, releaseStored, storeUpload } from "./attachments.ts";
import { writeAudit } from "./audit.ts";
import type { AuthedUser } from "./auth.ts";
import type { Repo, SlackLink } from "./db.ts";
import { onAliasCreated } from "./teams.ts";
import type { Conn, WsData } from "./ws.ts";

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

type Handlers = {
  message(ws: Conn, raw: string): void;
  close(ws: Conn): void;
};

export type SlackBridgeOptions = {
  repo: Repo;
  db: CoreDb;
  handlers: Handlers;
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
  unlink(userId: number): boolean;
  // A user was disabled or enabled: take their human offline, or back.
  userChanged(userId: number): Promise<void>;
};

/**
 * A human identity's connection: frames the hub sends arrive in send(), and
 * request() sends one the way a client would and resolves with its answer.
 */
class HumanConn implements Conn {
  readyState = 1;
  data: WsData;
  private n = 0;
  private readonly waiting = new Map<string, { resolve: (m: ServerMessage) => void; reject: (e: Error) => void }>();

  constructor(
    private readonly hub: Handlers,
    authed: AuthedUser,
    private readonly onItem: (m: PushMessage | BoardPush) => void,
  ) {
    this.data = { authed, primary: "", addresses: [], holds: [], ready: false, human: true };
  }

  send(raw: string): void {
    const m = JSON.parse(raw) as ServerMessage;
    const req = "req_id" in m && m.req_id ? this.waiting.get(m.req_id) : undefined;
    if (req) {
      this.waiting.delete((m as { req_id: string }).req_id);
      if (m.type === "error") req.reject(new Error(m.message));
      else req.resolve(m);
      return;
    }
    if (m.type === "push" || m.type === "board_push") this.onItem(m);
    // Pings and unsolicited errors need nothing from a connection that can't drop.
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.hub.close(this);
    for (const r of this.waiting.values()) r.reject(new Error("the Slack link was closed"));
    this.waiting.clear();
  }

  request<T extends ServerMessage>(frame: Record<string, unknown> & { type: ClientMessage["type"] }): Promise<T> {
    if (this.readyState !== 1) return Promise.reject(new Error("the Slack link was closed"));
    const req_id = `slack-${++this.n}`;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(req_id, { resolve: resolve as (m: ServerMessage) => void, reject });
      this.hub.message(this, JSON.stringify({ ...frame, req_id }));
    });
  }
}

type Linked = { link: SlackLink; conn: HumanConn; relay: Relay };

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
    for (const link of this.o.repo.slack.links()) await this.attach(link);
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
   * agent-session hello (src/server/ws.ts), deduped to one delivered notice
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
    for (const link of this.o.repo.slack.links()) {
      const user = this.o.repo.users.findById(link.user_id);
      if (!user || user.disabled_at !== null) continue;
      const target = `${link.email}/${HUMAN_NAME}`;
      // Dedup against the last DELIVERED notice, not the last death: the
      // unsuppressed row itself is what's owed, so a notice armed but not
      // yet delivered survives a restart. `last()` before the insert and
      // the clamp ride out clock skew in both directions.
      const last = this.o.repo.audit.last("bridge.notified", target);
      const prior = last && at - last.at >= 0 && at - last.at < BRIDGE_NOTIFY_DEDUP_MS;
      writeAudit(this.o.repo, "bridge.stopped", null, target, {
        reason: reason.detail,
        at: new Date(at).toISOString(),
        ...(prior ? { suppressed: true } : {}),
      });
    }
  }

  // ── linking ────────────────────────────────────────────────────────────────

  newCode(authed: AuthedUser): { code: string; expires_in_s: number; linked: boolean } {
    const now = Date.now();
    for (const [c, v] of this.codes) if (v.userId === authed.user_id || v.expires <= now) this.codes.delete(c);
    let code = "";
    for (let i = 0; i < 8; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    this.codes.set(code, { userId: authed.user_id, expires: now + CODE_TTL_MS });
    return { code, expires_in_s: CODE_TTL_MS / 1000, linked: !!this.o.repo.slack.linkFor(authed.user_id) };
  }

  /** Remove a user's link and their human identity. False if they had none. */
  unlink(userId: number): boolean {
    const { repo, db } = this.o;
    const link = repo.slack.linkFor(userId);
    if (!link) return false;
    this.detach(userId);
    repo.slack.unlink(userId);
    // Unread DMs to an identity nobody reads would only pile up; a later link
    // starts from the newest message (see linkUser).
    const handle = `${link.email}/${HUMAN_NAME}`;
    repo.aliases.remove(handle);
    forgetHandle(db, handle);
    writeAudit(repo, "slack.unlinked", link.email, link.slack_user);
    return true;
  }

  async userChanged(userId: number): Promise<void> {
    this.detach(userId);
    const link = this.o.repo.slack.linkFor(userId);
    if (link) await this.attach(link);
  }

  private async linkUser(slackUser: string, channel: string, ts: string, code: string): Promise<void> {
    const { repo, db } = this.o;
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
    const other = repo.slack.linkBySlackUser(slackUser);
    if (other && other.user_id !== user.id) {
      return this.say(channel, ts, `This Slack account is linked to \`${other.email}\`. Send \`unlink\` first.`);
    }

    this.detach(user.id);
    repo.slack.link(user.id, slackUser, channel);
    const handle = `${user.email}/${HUMAN_NAME}`;
    if (!repo.aliases.find(handle)) {
      // Start from now: drop what queued for an earlier link's alias.
      forgetHandle(db, handle);
      repo.aliases.create({ scope_kind: "person", scope_ref: user.email, name: HUMAN_NAME }, user.email);
      writeAudit(repo, "alias.created", user.email, handle, { slack: true });
      onAliasCreated(db, repo, user.id, handle);
      const newest = repo.messages.history([handle], undefined, 1)[0];
      if (newest) repo.cursors.advance(handle, "direct", handle, newest.id);
    }
    markHuman(db, handle, true);
    writeAudit(repo, "slack.linked", user.email, slackUser);
    await this.attach(repo.slack.linkFor(user.id)!);
    await this.say(
      channel,
      ts,
      `Linked to \`${user.email}\`. Your agents reach you here as "${HUMAN_NAME}"; each conversation gets its own thread, and your reply in it goes back to that conversation. To start one, begin a message with "@agent" or "#board". \`unlink\` stops it.`,
    );
  }

  // ── a linked user's human ──────────────────────────────────────────────────

  private async attach(link: SlackLink): Promise<void> {
    const { repo, db } = this.o;
    const user = repo.users.findById(link.user_id);
    if (!user || user.disabled_at !== null || this.stopped) return;
    const prefix = `${link.email}/`;
    const handle = `${prefix}${HUMAN_NAME}`;
    const authed: AuthedUser = { user_id: link.user_id, user_email: link.email, session_id: 0 };

    let relay!: Relay;
    const conn = new HumanConn(this.o.handlers, authed, (m) => {
      if (m.type === "push") {
        relay.notify(dmNotification(m.message));
      } else if (m.item.kind === "digest") {
        // Only says a board has unread posts; on a phone that's noise.
        void conn.request({ type: "board_ack", refs: [refOf(m.item)] }).catch(() => {});
      } else {
        relay.notify(boardNotification(m.item));
      }
    });

    // The outbox is memory: an item is acked to the hub only once Slack has
    // it, so one that never made it is resent at the next start. How far it
    // got is in the database, keyed by the item, so that resend resumes.
    const outbox = new Map<number, ChannelParams>();
    let next = 0;
    const ref = (id: number) => {
      const m = outbox.get(id)?.meta ?? {};
      return m.board && m.post_id ? `post:${m.post_id}` : `dm:${m.message_id}`;
    };
    const store: RelayStore = {
      thread: (kind, board, root) => repo.slack.thread(link.user_id, kind, board, root),
      byTs: (ts) => repo.slack.threadByTs(link.user_id, ts),
      addThread: (row) => repo.slack.addThread(link.user_id, row),
      advance: (ts, id) => repo.slack.advanceThread(link.user_id, ts, id),
      enqueue: (params) => {
        outbox.set(++next, params as ChannelParams);
        return next;
      },
      pending: () => [...outbox].map(([id, p]) => ({ id, params: JSON.stringify(p) })),
      progress: (id) => repo.slack.progress(link.user_id, ref(id)),
      setProgress: (id, progress) => repo.slack.setProgress(link.user_id, ref(id), progress),
      done: (id) => {
        repo.slack.clearProgress(link.user_id, ref(id));
        const p = outbox.get(id);
        outbox.delete(id);
        const m = p?.meta ?? {};
        const ack: Record<string, unknown> & { type: ClientMessage["type"] } | null =
          m.board && m.post_id ? { type: "board_ack", refs: [{ kind: "push", post_id: Number(m.post_id) }] }
          : m.message_id ? { type: "ack", message_ids: [Number(m.message_id)] }
          : null;
        if (ack) void conn.request(ack).catch(() => {});
      },
    };

    const bus: Bus = {
      async call(name, args) {
        try {
          if (name === "dm_send") {
            const { type: _t, req_id: _r, ...v } = await conn.request<SendOk>({
              type: "send", recipient: args.to, body: args.body,
              ...(args.parent_id !== undefined ? { parent_id: args.parent_id } : {}),
              ...(args.attachment_ids !== undefined ? { attachment_ids: args.attachment_ids } : {}),
            });
            return { ok: true, value: v };
          }
          if (name === "dm_thread") {
            return { ok: true, value: (await conn.request<ThreadOk>({ type: "thread", message_id: args.thread })).messages };
          }
          return { ok: true, value: (await conn.request<CallOk>({ type: "call", tool: name, args })).result };
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
      },
      // In process: the read check the download route makes, and the store an
      // upload makes, audited the same way.
      async attachment(id) {
        const row = readableAttachment(repo, db, handle, id, null, link.email);
        if (!row) {
          writeAudit(repo, "attachment.download_refused", link.email, `attachment:${id}`, { identity: handle, via: "slack" });
          throw new Error(`no attachment ${id} on a message or post you can read`);
        }
        return { id: row.id, filename: row.filename, type: row.type, size: row.size, sha256: row.sha256, data: await repo.blobs.get(row.sha256) };
      },
      // Files the relay checked (checkFile), stored as the HTTP upload route
      // stores them; released again if the send doesn't carry them.
      async withFiles(files, send) {
        const ids: number[] = [];
        let sent = false;
        try {
          for (const f of files) ids.push((await storeUpload(repo, db, link.email, handle, f, { slack_file: f.slack_file })).id);
          const r = await send({ attachment_ids: ids });
          sent = (r as { ok?: boolean }).ok !== false;
          return r;
        } finally {
          if (!sent) for (const id of ids) await releaseStored(repo, db, link.email, handle, id, { via: "slack" });
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
      onFileSent: (f) =>
        writeAudit(repo, "attachment.sent_to_slack", link.email, `attachment:${f.attachment}`, {
          identity: handle, channel: link.dm_channel, thread_ts: f.thread_ts, slack_file: f.slack_file, sha256: f.sha256,
        }),
      onFileRefused: (f) =>
        writeAudit(repo, "attachment.slack_refused", link.email, f.attachment === null ? null : `attachment:${f.attachment}`, {
          identity: handle, channel: link.dm_channel, filename: f.name, reason: f.why, ...(f.sha256 ? { sha256: f.sha256 } : {}),
        }),
    });
    this.linked.set(link.user_id, { link, conn, relay });
    try {
      await conn.request<HelloOk>({ type: "hello", proto: PROTO });
    } catch (e) {
      this.log(`${link.email}: couldn't bring the human online: ${(e as Error).message}`);
      this.detach(link.user_id);
    }
  }

  private detach(userId: number): void {
    const l = this.linked.get(userId);
    if (!l) return;
    this.linked.delete(userId);
    l.relay.stop();
    l.conn.close();
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
        const link = this.o.repo.slack.linkBySlackUser(user);
        if (link) this.unlink(link.user_id);
        return this.say(channel, ts, link ? `Unlinked from \`${link.email}\`. Agents' messages to "${HUMAN_NAME}" won't reach you here.` : NOT_LINKED);
      }
    }
    const link = this.o.repo.slack.linkBySlackUser(user);
    const l = link && this.linked.get(link.user_id);
    if (!l) return this.say(channel, threaded ? String(e.thread_ts) : ts, link ? "Your link is offline; the server log says why." : NOT_LINKED);
    await l.relay.onEvent(payload);
  }

  private async say(channel: string, threadTs: string, text: string): Promise<void> {
    try {
      await this.web.call("chat.postMessage", { channel, thread_ts: threadTs, markdown_text: text });
    } catch (e) {
      this.log(`couldn't reply in ${channel}: ${(e as Error).message}`);
    }
  }
}
