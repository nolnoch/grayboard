// Routing between one human's grayboard handle and one private Slack channel.
//
// Grayboard → Slack: each channel notification the bridge's `grayboard mcp`
// child pushes goes into the outbox, then out to Slack in order. A grayboard
// thread (DM or board) maps to one Slack thread, keyed on the grayboard root.
//
// Slack → grayboard: the owner's replies in a mapped thread become threaded
// replies (dm_send / board_post with parent_id), so only that conversation's
// agents wake. A top-level "@handle …" or "#board …" starts a new one.
//
// Attachments go both ways: an item's files follow its text into the Slack
// thread, and files the owner shares in Slack ride on the dm_send/board_post.
import {
  DEFAULT_ATTACHMENT_LIMITS, MAX_ATTACHMENTS, formatSize, parseAttachmentsMeta, sanitizeFilename, sniffType,
  type AttachmentFile, type AttachmentInfo, type AttachmentLimits,
} from "../shared/attachments.ts";
import type { Store, ThreadRow } from "./store.ts";
import { SlackError, SlackUnavailable, type SlackWeb } from "./web.ts";

/** The thread map and outbox: store.ts locally, the server's tables and acks in server mode. */
export type RelayStore = Pick<Store, "thread" | "byTs" | "addThread" | "advance" | "enqueue" | "pending" | "done">;

export type ChannelParams = { content: string; meta: Record<string, string> };

export type ToolResult = { ok: true; value: any } | { ok: false; error: string };

/** A file the owner shared in Slack, checked and downloaded. */
export type SlackFile = AttachmentFile & { slack_file: string };

/** The bridge's grayboard session, acting as the owner's human handle. */
export type Bus = {
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  /** An attachment the human can read, with its bytes; throws why not. */
  attachment(id: number): Promise<AttachmentInfo & { data: Uint8Array }>;
  /** Runs `send` with the dm_send/board_post arguments that carry `files`. */
  withFiles<T>(files: SlackFile[], send: (extra: Record<string, unknown>) => Promise<T>): Promise<T>;
};

export type RelayOptions = {
  channel: string;
  owner: string;
  log?: (msg: string) => void;
  /** Detail for checking Slack's behavior live (GRAYBOARD_SLACK_DEBUG). */
  debug?: (msg: string) => void;
  /** A failure retrying can't fix (bad token, bot not in the channel). */
  onFatal: (reason: string) => void;
  /** Backoff between retries of a post Slack couldn't take. */
  retryMs?: number;
  /** How a handle reads in Slack; on a server, your own agents go by bare name. */
  label?: (handle: string) => string;
  /** The bus's size caps, checked on Slack's sizes before downloading. */
  attachmentLimits?: AttachmentLimits;
  /** Each grayboard attachment Slack took, for a server's audit log. */
  onFileSent?: (f: { attachment: number; slack_file: string; thread_ts: string }) => void;
};

// How far one outbox item got, so a retry after Slack was unavailable
// doesn't post its text twice.
type Progress = { threadTs?: string; filesDone?: boolean };

// Slack's markdown_text limit is 12,000 chars; leave room for the header.
const MAX_BODY = 11_500;
const CHECK = "white_check_mark";

const HINT =
  'To start a conversation, begin a message with "@handle" (a direct message to that agent) or "#board" (a post on that board). To answer an agent, reply in its thread. To make a board: "new #board what it\'s for".';

export class Relay {
  private draining = false;
  private again = false;
  private stopped = false;
  private readonly log: (msg: string) => void;
  private readonly debug: (msg: string) => void;
  private readonly retryMs: number;
  private readonly limits: AttachmentLimits;

  constructor(
    private readonly store: RelayStore,
    private readonly bus: Bus,
    private readonly slack: SlackWeb,
    private readonly o: RelayOptions,
  ) {
    this.log = o.log ?? (() => {});
    this.debug = o.debug ?? (() => {});
    this.retryMs = o.retryMs ?? 5000;
    this.limits = o.attachmentLimits ?? DEFAULT_ATTACHMENT_LIMITS;
  }

  stop(): void {
    this.stopped = true;
  }

  // ── grayboard → Slack ──────────────────────────────────────────────────────

  /** A channel notification from the child. Stored before anything else can fail. */
  notify(params: ChannelParams): void {
    // A digest only says a board has unread posts; on a phone that's noise.
    if (this.stopped || params.meta?.kind === "digest") return;
    this.store.enqueue(params);
    void this.drain();
  }

  /** Post everything in the outbox, oldest first. Safe to call any time. */
  async drain(): Promise<void> {
    if (this.draining) {
      this.again = true;
      return;
    }
    this.draining = true;
    try {
      do {
        this.again = false;
        for (const row of this.store.pending()) {
          if (this.stopped) return;
          await this.deliver(row.id, JSON.parse(row.params) as ChannelParams);
        }
      } while (this.again && !this.stopped);
    } catch (e) {
      // The row stays in the outbox for the next drain or the next run.
      if (!this.stopped) this.log(`outbox: ${(e as Error).message}`);
    } finally {
      this.draining = false;
    }
  }

  // Retries until Slack takes it, except for errors a retry can't fix.
  private async deliver(id: number, p: ChannelParams): Promise<void> {
    const progress: Progress = {};
    for (;;) {
      try {
        await this.forward(p, progress);
        this.store.done(id);
        return;
      } catch (e) {
        if (e instanceof SlackError) {
          if (e.fatal) {
            this.stop();
            this.o.onFatal(e.message);
            return;
          }
          // E.g. msg_too_long: this one message can't be posted; keep going.
          this.log(`slack: gave up on outbox ${id}: ${e.message}`);
          this.store.done(id, e.code);
          return;
        }
        if (!(e instanceof SlackUnavailable)) throw e;
        this.log(`${e.message}; retrying in ${Math.round(this.retryMs / 1000)}s`);
        await Bun.sleep(this.retryMs);
        if (this.stopped) return;
      }
    }
  }

  private async forward(p: ChannelParams, progress: Progress): Promise<void> {
    const m = p.meta ?? {};
    const attachments = parseAttachmentsMeta(m.attachments);
    if (m.board && m.post_id) {
      const id = Number(m.post_id);
      const root = m.parent_id ? await this.boardRoot(m.board, id) : id;
      await this.postInThread({ kind: "board", board: m.board, root, id, from: m.from ?? "?", body: p.content, attachments }, progress);
    } else if (m.message_id) {
      const id = Number(m.message_id);
      const root = m.parent_id ? await this.dmRoot(id) : id;
      await this.postInThread({ kind: "dm", board: null, root, id, from: m.from ?? "?", body: p.content, attachments }, progress);
    }
  }

  // The text as its own message, so it keeps markdown_text rendering and its
  // ts maps the thread; then the files, as one reply in that thread.
  private async postInThread(
    x: { kind: "dm" | "board"; board: string | null; root: number; id: number; from: string; body: string; attachments: number[] },
    progress: Progress,
  ): Promise<void> {
    const name = this.o.label?.(x.from) ?? x.from;
    if (progress.threadTs === undefined) {
      const row = this.store.thread(x.kind, x.board, x.root);
      const text = format(name, row ? null : x.board, x.body, x.id);
      const r = await this.slack.call<{ ts: string; message?: Record<string, any> }>("chat.postMessage", {
        channel: this.o.channel,
        markdown_text: text,
        username: name,
        ...(row ? { thread_ts: row.thread_ts } : {}),
      });
      this.debug(`posted ${r.ts} as username=${JSON.stringify(r.message?.username)} (asked ${JSON.stringify(x.from)})`);
      if (row) this.store.advance(row.thread_ts, x.id);
      else this.store.addThread({ thread_ts: r.ts, kind: x.kind, board: x.board, root_id: x.root, peer: x.kind === "dm" ? x.from : null, last_id: x.id });
      progress.threadTs = row?.thread_ts ?? r.ts;
    }
    if (x.attachments.length && !progress.filesDone) {
      await this.postFiles(x.attachments, progress.threadTs!, name);
      progress.filesDone = true;
    }
  }

  // Uploads what it can and says in the thread which files didn't make it
  // (Slack refused the type or size, the workspace blocks uploads, the app
  // lacks files:write). Only Slack being unavailable, or a fatal error,
  // throws.
  private async postFiles(ids: number[], threadTs: string, name: string): Promise<void> {
    const sent: { id: string; title: string; attachment: number }[] = [];
    const failed: string[] = [];
    const refused = (what: string, e: unknown) => {
      if (!(e instanceof SlackError) || (e.fatal && e.code !== "missing_scope")) throw e;
      failed.push(`${what}: ${e.code === "missing_scope" ? "the Slack app lacks files:write (reinstall it from the current manifest)" : e.code}`);
    };
    for (const id of ids) {
      let a: AttachmentInfo & { data: Uint8Array };
      try {
        a = await this.bus.attachment(id);
      } catch (e) {
        failed.push(`attachment ${id}: ${(e as Error).message}`);
        continue;
      }
      try {
        const u = await this.slack.call<{ upload_url: string; file_id: string }>(
          "files.getUploadURLExternal",
          { filename: a.filename, length: a.data.length },
          { form: true },
        );
        await this.slack.upload(u.upload_url, a.data);
        sent.push({ id: u.file_id, title: a.filename, attachment: id });
      } catch (e) {
        refused(a.filename, e);
      }
    }
    if (sent.length) {
      try {
        await this.slack.call(
          "files.completeUploadExternal",
          { files: sent.map(({ id, title }) => ({ id, title })), channel_id: this.o.channel, thread_ts: threadTs, username: name },
          { form: true },
        );
        for (const f of sent) this.o.onFileSent?.({ attachment: f.attachment, slack_file: f.id, thread_ts: threadTs });
      } catch (e) {
        refused(sent.map((f) => f.title).join(", "), e);
      }
    }
    if (failed.length) {
      this.log(`slack: files not delivered: ${failed.join("; ")}`);
      await this.say(threadTs, `⚠️ not delivered to Slack: ${failed.join("; ")}`);
    }
  }

  // Notifications carry parent_id, not the root; key the map on the root so a
  // reply deep in a thread lands in the same Slack thread. If the lookup fails,
  // the item starts its own Slack thread.
  private async dmRoot(id: number): Promise<number> {
    const r = await this.bus.call("dm_thread", { thread: id });
    return r.ok && Array.isArray(r.value) && r.value[0]?.id ? Number(r.value[0].id) : id;
  }

  private async boardRoot(board: string, id: number): Promise<number> {
    const r = await this.bus.call("board_read", { board, thread: id });
    return r.ok && r.value?.posts?.[0]?.id ? Number(r.value.posts[0].id) : id;
  }

  // ── Slack → grayboard ──────────────────────────────────────────────────────

  /** An events_api payload from Socket Mode. */
  async onEvent(payload: Record<string, any>): Promise<void> {
    if (payload.type !== "event_callback") return;
    const e = payload.event as Record<string, any> | undefined;
    if (!e || e.type !== "message") return;
    // Only the owner, only this channel, only new messages, with or without
    // files (no edits, deletes, joins, or bot posts, including our own).
    if (e.channel !== this.o.channel || e.user !== this.o.owner || (e.subtype && e.subtype !== "file_share") || e.bot_id) {
      if (e.channel === this.o.channel) this.debug(`ignored message ${e.ts}: subtype=${e.subtype ?? "-"} bot_id=${e.bot_id ?? "-"} user=${e.user ?? "-"}`);
      return;
    }
    const text = fromSlack(String(e.text ?? "")).trim();
    const files: Record<string, any>[] = Array.isArray(e.files) ? e.files : [];
    if (!text && !files.length) return;
    const ts = String(e.ts);
    const threadTs = e.thread_ts && e.thread_ts !== e.ts ? String(e.thread_ts) : null;
    try {
      if (threadTs) await this.reply(threadTs, ts, text, files);
      else await this.start(ts, text, files);
    } catch (err) {
      if (err instanceof SlackError && err.fatal) {
        this.stop();
        this.o.onFatal(err.message);
        return;
      }
      await this.say(threadTs ?? ts, `⚠️ not sent: ${(err as Error).message}`);
    }
  }

  private async reply(threadTs: string, ts: string, text: string, files: Record<string, any>[]): Promise<void> {
    const row = this.store.byTs(threadTs);
    if (!row) {
      await this.say(threadTs, `This thread isn't connected to a grayboard conversation. ${HINT}`);
      return;
    }
    if (row.kind === "dm") await this.sendDm(row.peer!, text, files, row.last_id, ts, row);
    else await this.sendPost(row.board!, text, files, row.last_id, ts, row);
  }

  // With files attached, "@handle" or "#board" alone is a whole message.
  private async start(ts: string, text: string, files: Record<string, any>[]): Promise<void> {
    // A bare handle, or on a server user@org/name for someone else's agent.
    const dm = /^@((?:[a-z0-9._%+-]+@[a-z0-9.-]+\/)?[a-z0-9_-]{1,32})(?:[\s:,]+(\S[\s\S]*))?$/i.exec(text);
    if (dm && (dm[2] || files.length)) return this.sendDm(dm[1]!.toLowerCase(), dm[2] ?? "", files, undefined, ts, null);
    const nb = /^new\s+#([a-z0-9_-]{1,32})(?:[\s:,]+(\S[\s\S]*))?$/i.exec(text);
    if (nb && files.length) return this.say(ts, `⚠️ not created: files don't come along when making a board; make #${nb[1]!.toLowerCase()} first, then post them with "#${nb[1]!.toLowerCase()} …"`);
    if (nb) return this.createBoard(nb[1]!.toLowerCase(), nb[2], ts);
    const bp = /^#([a-z0-9_-]{1,32})(?:\s+(\S[\s\S]*))?$/i.exec(text);
    if (bp && (bp[2] || files.length)) return this.sendPost(bp[1]!.toLowerCase(), bp[2] ?? "", files, undefined, ts, null);
    await this.say(ts, HINT);
  }

  // The owner's Slack files, downloaded and checked, carried on the bus call
  // `send` makes. A file that can't come along refuses the whole message, so
  // nothing arrives without what the owner meant to send.
  private async sendWithFiles(
    files: Record<string, any>[],
    body: string,
    send: (body: string, extra: Record<string, unknown>) => Promise<ToolResult>,
  ): Promise<ToolResult> {
    if (!files.length) return send(body, {});
    const got = await this.fetchFiles(files);
    // A bus message needs a body; a files-only one names its files.
    return this.bus.withFiles(got, (extra) => send(body || got.map((f) => f.filename).join(", "), extra));
  }

  private async fetchFiles(list: Record<string, any>[]): Promise<SlackFile[]> {
    const { file: max, total: maxTotal } = this.limits;
    if (list.length > MAX_ATTACHMENTS) throw new Error(`at most ${MAX_ATTACHMENTS} files per message`);
    const out: SlackFile[] = [];
    let total = 0;
    for (let f of list) {
      // Some events carry only the file's id; files.info has the rest.
      if (!f.url_private_download && f.id) f = (await this.fileInfo(String(f.id))) ?? f;
      const name = sanitizeFilename(String(f.name ?? f.title ?? "file"));
      const size = Number(f.size);
      if (!f.url_private_download || !Number.isInteger(size)) throw new Error(`file ${name}: Slack gives the app no download for it`);
      if (size > max) throw new Error(`file ${name}: ${formatSize(size)} exceeds the ${formatSize(max)} limit`);
      total += size;
      if (total > maxTotal) throw new Error(`files exceed ${formatSize(maxTotal)} in all`);
      let data: Uint8Array;
      try {
        data = await this.slack.download(String(f.url_private_download), size);
      } catch (e) {
        if (e instanceof SlackError && e.code === "size_mismatch") throw new Error(`file ${name}: Slack didn't serve it (does the app have files:read? reinstall it from the current manifest)`);
        throw e;
      }
      const type = sniffType(data, name);
      if (!type) throw new Error(`file ${name}: not an image (PNG, JPEG, GIF, WebP), a PDF, or UTF-8 text`);
      out.push({ filename: name, type, data, slack_file: String(f.id) });
    }
    return out;
  }

  // Here a missing scope means a reinstall, not a dead token.
  private async fileInfo(id: string): Promise<Record<string, any> | undefined> {
    try {
      return (await this.slack.call<{ file?: Record<string, any> }>("files.info", { file: id }, { form: true })).file;
    } catch (e) {
      if (e instanceof SlackError && e.code === "missing_scope") throw new Error(`the Slack app lacks files:read (reinstall it from the current manifest)`);
      throw e;
    }
  }

  // row: the mapped thread being replied in, or null to map a new one rooted
  // at the Slack message `ts`.
  private async sendDm(to: string, text: string, files: Record<string, any>[], parent: number | undefined, ts: string, row: ThreadRow | null): Promise<void> {
    const r = await this.sendWithFiles(files, text, (body, extra) =>
      this.bus.call("dm_send", { to, body, ...(parent !== undefined ? { parent_id: parent } : {}), ...extra }),
    );
    const where = row?.thread_ts ?? ts;
    if (!r.ok) return this.say(where, `⚠️ not sent: ${r.error}`);
    const v = r.value as { message_id: number; delivered_now: boolean; recipient_last_seen?: string };
    if (row) this.store.advance(row.thread_ts, v.message_id);
    else this.store.addThread({ thread_ts: ts, kind: "dm", board: null, root_id: v.message_id, peer: to, last_id: v.message_id });
    if (v.delivered_now) await this.react(ts);
    else {
      const seen = v.recipient_last_seen ? ` (last seen ${v.recipient_last_seen})` : "";
      await this.say(where, `queued: ${to} is offline${seen}; it gets this when its next session starts.`);
    }
  }

  private async sendPost(board: string, text: string, files: Record<string, any>[], parent: number | undefined, ts: string, row: ThreadRow | null): Promise<void> {
    const r = await this.sendWithFiles(files, text, (body, extra) =>
      this.bus.call("board_post", { board, body, ...(parent !== undefined ? { parent_id: parent } : {}), ...extra }),
    );
    const where = row?.thread_ts ?? ts;
    if (!r.ok) return this.say(where, `⚠️ not posted: ${/no such board/.test(r.error) ? await this.noBoard(board) : r.error}`);
    const v = r.value as { post_id: number; board: string; unresolved?: string[] };
    if (row) this.store.advance(row.thread_ts, v.post_id);
    else this.store.addThread({ thread_ts: ts, kind: "board", board: v.board, root_id: v.post_id, peer: null, last_id: v.post_id });
    await this.react(ts);
    if (v.unresolved?.length) await this.say(where, `posted, but no handle matches ${v.unresolved.map((h) => `@${h}`).join(", ")}`);
  }

  // The owner's board starts quiet: replies to their posts and @mentions
  // still reach them in every mode, but not every post on the board.
  private async createBoard(board: string, purpose: string | undefined, ts: string): Promise<void> {
    if (!purpose) return this.say(ts, `⚠️ not created: say what #${board} is for, e.g. "new #${board} release timing questions"`);
    const r = await this.bus.call("board_create", { name: board, purpose });
    if (!r.ok) return this.say(ts, `⚠️ not created: ${r.error}`);
    await this.bus.call("board_subscribe", { board, mode: "quiet" });
    await this.react(ts);
    await this.say(ts, `created #${board}. Post with "#${board} …"; @mention the agents you want to hear from, since no one else is subscribed yet.`);
  }

  // The bus's "no such board" points agents at board_list; the owner gets the
  // boards that exist and how to make this one.
  private async noBoard(board: string): Promise<string> {
    const r = await this.bus.call("board_list", {});
    const names = r.ok && Array.isArray(r.value) ? r.value.map((b: { name: string }) => `#${b.name}`).join(", ") : "";
    return `no board #${board}${names ? ` (boards: ${names})` : ""}. To make it: "new #${board} what it's for"`;
  }

  // Bridge status lines, as the bot itself. Failing to post one isn't worth
  // more than a log line.
  private async say(threadTs: string, text: string): Promise<void> {
    try {
      await this.slack.call("chat.postMessage", { channel: this.o.channel, thread_ts: threadTs, markdown_text: text });
    } catch (e) {
      this.log(`slack: couldn't post a status reply: ${(e as Error).message}`);
    }
  }

  private async react(ts: string): Promise<void> {
    try {
      await this.slack.call("reactions.add", { channel: this.o.channel, timestamp: ts, name: CHECK });
    } catch (e) {
      this.log(`slack: couldn't add a reaction: ${(e as Error).message}`);
    }
  }
}

/**
 * A grayboard item as Slack Markdown. The sender's handle leads in bold, so
 * attribution survives even if Slack ignores the username override. A new
 * thread from a board names the board. A handle with an email in it goes in a
 * code span, or Slack auto-links the address and shows it as "mailto:…".
 */
export function format(from: string, board: string | null, body: string, id: number): string {
  const name = from.includes("@") ? `\`${from}\`` : `**${from}**`;
  const head = board ? `${name} · #${board} ·` : name;
  const cut = body.length > MAX_BODY;
  const text = cut ? `${body.slice(0, MAX_BODY)}\n\n… (truncated; the full text is grayboard ${board ? "post" : "message"} ${id})` : body;
  return `${head}${text.includes("\n") ? "\n" : " "}${text}`;
}

/** Slack message text as plain text: links unwrapped, entities unescaped. */
export function fromSlack(s: string): string {
  return s
    .replace(/<([^<>|]+)\|([^<>]*)>/g, (_, target: string, label: string) => {
      if (target.startsWith("#C") || target.startsWith("#G")) return `#${label}`;
      if (target.startsWith("@") || target.startsWith("!")) return `@${label}`;
      if (target.startsWith("mailto:")) return label || target.slice(7);
      return !label || label === target ? target : `${label} (${target})`;
    })
    .replace(/<([^<>]+)>/g, (_, t: string) => (t.startsWith("mailto:") ? t.slice(7) : t.startsWith("!") ? `@${t.slice(1)}` : t))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
