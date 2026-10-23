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
// Attachments go both ways: an item's files and text go to Slack as one
// message, and files the owner shares in Slack ride on the dm_send/board_post.
// A file Slack won't take goes back to its sender as a reply.
import {
  DEFAULT_ATTACHMENT_LIMITS, SizeTally, checkFile, parseAttachmentsMeta, sanitizeFilename, sha256Hex,
  type AttachmentFile, type AttachmentInfo, type AttachmentLimits,
} from "../shared/attachments.ts";
import type { Store, ThreadRow } from "./store.ts";
import { SlackError, SlackUnavailable, type SlackWeb } from "./web.ts";

/** The thread map and outbox: store.ts locally, the server's tables and acks in server mode. */
export type RelayStore = Pick<Store, "thread" | "byTs" | "addThread" | "advance" | "enqueue" | "pending" | "progress" | "setProgress" | "done">;

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
  /** Each grayboard attachment Slack took, for a server's audit log; thread_ts null when Slack didn't say where. */
  onFileSent?: (f: { attachment: number; sha256: string; slack_file: string; thread_ts: string | null }) => void;
  /** Each grayboard attachment that didn't reach Slack, once, when its sender is told. */
  onFileRefused?: (f: Refused) => void;
  /** How long to look in files.info for the message a file share made, which can lag the share. */
  shareWaitMs?: number;
};

type Item = { kind: "dm" | "board"; board: string | null; root: number; id: number; from: string; body: string; attachments: number[] };

type UploadedFile = { id: string; title: string; attachment: number; sha256: string };

/** A file that won't reach Slack; attachment null when the relay couldn't tell which. */
export type Refused = { attachment: number | null; name: string; why: string; sha256?: string };

// How far one outbox item got, kept in the store so neither a retry nor a
// restart posts it twice or shares its files twice.
type Progress = {
  /** Uploaded to Slack, waiting to be shared with the text. */
  files?: UploadedFile[];
  /** Files that won't reach Slack. */
  refused?: Refused[];
  /** files.completeUploadExternal went out; a retry asks Slack whether it landed before resending. */
  completing?: boolean;
  /** The item's message is in Slack and the thread map knows it. */
  posted?: boolean;
  /** Why the item counts as given up on, if it does (the outbox row's error). */
  error?: string | null;
  /** The sender heard which files didn't reach Slack. */
  told?: boolean;
};

// Slack's markdown_text and markdown block limit is 12,000 chars; leave room
// for the header. The body and a note of files that didn't make it share this.
const MAX_BODY = 11_500;
const MAX_NOTE = 3_000;
const SHARE_POLLS = 10;
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
  private readonly shareWaitMs: number;

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
    this.shareWaitMs = o.shareWaitMs ?? 10_000;
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
    const progress = (this.store.progress(id) ?? {}) as Progress;
    const save = () => this.store.setProgress(id, progress);
    for (;;) {
      try {
        await this.forward(p, progress, save);
        this.store.done(id, progress.error ?? null);
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

  private async forward(p: ChannelParams, progress: Progress, save: () => void): Promise<void> {
    const m = p.meta ?? {};
    let attachments: number[] = [];
    try {
      attachments = parseAttachmentsMeta(m.attachments);
    } catch (e) {
      // The meta format changed under the relay: say so rather than drop the files.
      progress.refused ??= [{ attachment: null, name: "its files", why: (e as Error).message }];
    }
    const base = { from: m.from ?? "?", body: p.content, attachments };
    if (m.board && m.post_id) {
      const id = Number(m.post_id);
      const root = m.parent_id ? await this.boardRoot(m.board, id) : id;
      await this.postItem({ kind: "board", board: m.board, root, id, ...base }, progress, save);
    } else if (m.message_id) {
      const id = Number(m.message_id);
      const root = m.parent_id ? await this.dmRoot(id) : id;
      await this.postItem({ kind: "dm", board: null, root, id, ...base }, progress, save);
    }
  }

  // The text and files as one Slack message: files.completeUploadExternal
  // with the text as a markdown block, or chat.postMessage when no file made
  // it. Each step is saved in `progress` before the next, so a retry or a
  // restart resumes where this one stopped.
  private async postItem(x: Item, progress: Progress, save: () => void): Promise<void> {
    const name = this.o.label?.(x.from) ?? x.from;
    if (!progress.posted) {
      if (x.attachments.length && !progress.files) {
        await this.upload(x.attachments, progress);
        save();
      }
      const row = this.store.thread(x.kind, x.board, x.root);
      const text = () => format(name, row ? null : x.board, x.body, x.id, warning(progress.refused));
      // The item's message ts; null when Slack took it but never said where.
      let ts: string | null | undefined;
      if (progress.files?.length) ts = await this.share(progress, save, text(), name, row?.thread_ts);
      if (ts === undefined) ts = await this.postText(text(), name, row?.thread_ts);
      if (row) this.store.advance(row.thread_ts, x.id);
      else if (ts) this.store.addThread({ thread_ts: ts, kind: x.kind, board: x.board, root_id: x.root, peer: x.kind === "dm" ? x.from : null, last_id: x.id });
      const errors = [progress.refused?.length ? "files_refused" : null, !row && !ts ? "ts_unknown" : null].filter(Boolean);
      progress.error = errors.length ? errors.join(",") : null;
      progress.posted = true;
      save();
      if (!row && !ts) {
        this.log(`slack: no ts for grayboard ${x.kind} ${x.id}; its Slack thread isn't mapped`);
        await this.say(null, `⚠️ Slack didn't say where it put ${x.kind === "dm" ? "message" : "post"} ${x.id} from ${name}, so replies in that thread won't reach grayboard. Answer in the next message of that conversation instead.`);
      }
    }
    if (progress.refused?.length && !progress.told) {
      this.log(`slack: files on ${x.kind} ${x.id} not delivered: ${listRefused(progress.refused)}`);
      for (const r of progress.refused) this.o.onFileRefused?.(r);
      await this.tell(x, progress.refused);
      progress.told = true;
      save();
    }
  }

  // Uploads each file. Keeps the ones Slack takes and says why for the rest
  // (Slack refused the type or size, the workspace blocks uploads, the app
  // lacks files:write, the bus wouldn't give the file). Only Slack being
  // unavailable, or a fatal error, throws.
  private async upload(ids: number[], progress: Progress): Promise<void> {
    const files: UploadedFile[] = [];
    const refused = [...(progress.refused ?? [])];
    for (const id of ids) {
      let a: AttachmentInfo & { data: Uint8Array };
      try {
        a = await this.bus.attachment(id);
      } catch (e) {
        refused.push({ attachment: id, name: `attachment ${id}`, why: (e as Error).message });
        continue;
      }
      // What goes to Slack must be what the bus stored; the audit row names this hash.
      const sha256 = sha256Hex(a.data);
      if (sha256 !== a.sha256) {
        refused.push({ attachment: id, name: a.filename, why: "its bytes don't match the stored sha256", sha256 });
        continue;
      }
      try {
        const u = await this.slack.call<{ upload_url: string; file_id: string }>(
          "files.getUploadURLExternal",
          { filename: a.filename, length: a.data.length },
          { form: true },
        );
        await this.slack.upload(u.upload_url, a.data);
        files.push({ id: u.file_id, title: a.filename, attachment: id, sha256 });
      } catch (e) {
        refused.push({ attachment: id, name: a.filename, why: refusal(e), sha256 });
      }
    }
    progress.files = files;
    progress.refused = refused;
  }

  // Shares the uploaded files with the text as one message. Returns its ts
  // (the thread's, for a reply), null if Slack took it but files.info never
  // showed where, or undefined if Slack refused it, with the files moved to
  // `refused` for a text-only post.
  private async share(progress: Progress, save: () => void, text: string, name: string, threadTs: string | undefined): Promise<string | null | undefined> {
    const files = progress.files!;
    // The last attempt may have landed with its answer lost; resending would share the files twice.
    let ts = progress.completing ? await this.sharedTs(files[0]!.id) : null;
    if (!ts) {
      progress.completing = true;
      save();
      try {
        await this.slack.call(
          "files.completeUploadExternal",
          {
            files: files.map(({ id, title }) => ({ id, title })),
            channel_id: this.o.channel,
            ...(threadTs ? { thread_ts: threadTs } : {}),
            blocks: [{ type: "markdown", text }],
            username: name,
          },
          { form: true },
        );
      } catch (e) {
        const why = refusal(e);
        progress.refused = [...(progress.refused ?? []), ...files.map((f) => ({ attachment: f.attachment, name: f.title, why, sha256: f.sha256 }))];
        progress.files = [];
        progress.completing = false;
        save();
        return undefined;
      }
      // Slack's answer names the files, not the message; a reply already knows its thread.
      ts = threadTs ?? (await this.sharedTs(files[0]!.id));
    }
    const thread = threadTs ?? ts;
    for (const f of files) this.o.onFileSent?.({ attachment: f.attachment, sha256: f.sha256, slack_file: f.id, thread_ts: thread });
    return thread;
  }

  // The ts of the message that shared `file` in this channel, from files.info.
  // Polled, since a file's shares can lag its share. Null if it never shows,
  // or the app can't read files (no files:read).
  private async sharedTs(file: string): Promise<string | null> {
    for (let i = 0; i < SHARE_POLLS; i++) {
      if (i) await Bun.sleep(this.shareWaitMs / SHARE_POLLS);
      let f: Record<string, any> | undefined;
      try {
        f = (await this.slack.call<{ file?: Record<string, any> }>("files.info", { file }, { form: true })).file;
      } catch (e) {
        if (!(e instanceof SlackError) || (e.fatal && e.code !== "missing_scope")) throw e;
        this.log(`slack: files.info ${file}: ${e.code}`);
        return null;
      }
      const shares = f?.shares ?? {};
      const ts = (shares.private?.[this.o.channel] ?? shares.public?.[this.o.channel])?.[0]?.ts;
      this.debug(`files.info ${file} try ${i + 1}: shares in channel ${ts ? `ts=${ts}` : "none yet"}`);
      if (ts) return String(ts);
    }
    return null;
  }

  private async postText(text: string, name: string, threadTs: string | undefined): Promise<string> {
    const r = await this.slack.call<{ ts: string; message?: Record<string, any> }>("chat.postMessage", {
      channel: this.o.channel,
      markdown_text: text,
      username: name,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
    this.debug(`posted ${r.ts} as username=${JSON.stringify(r.message?.username)} (asked ${JSON.stringify(name)})`);
    return r.ts;
  }

  // Files that didn't reach Slack go back to their sender, so it knows the
  // human never saw them. Sent as the human's handle, so the body says it's
  // the bridge speaking. A DM's notice replies to it; a post's is a new DM.
  private async tell(x: Item, refused: Refused[]): Promise<void> {
    const what = x.kind === "dm" ? `your message ${x.id}` : `your post ${x.id} on #${x.board}`;
    const body = `[Slack bridge] Files on ${what} didn't reach Slack, so the human hasn't seen them: ${listRefused(refused)}. The text did reach them.`;
    const r = await this.bus.call("dm_send", { to: x.from, body, ...(x.kind === "dm" ? { parent_id: x.id } : {}) });
    if (!r.ok) this.log(`slack: couldn't tell ${x.from} its files didn't reach Slack: ${r.error}`);
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

  // The same name, type, content and size checks as an agent's files
  // (checkFile, SizeTally), so a Slack share can't carry what a path can't.
  private async fetchFiles(list: Record<string, any>[]): Promise<SlackFile[]> {
    const tally = new SizeTally(this.limits, list.length);
    const out: SlackFile[] = [];
    for (let f of list) {
      // Some events carry only the file's id; files.info has the rest.
      if (!f.url_private_download && f.id) f = (await this.fileInfo(String(f.id))) ?? f;
      const raw = String(f.name ?? f.title ?? "file");
      const label = `file ${sanitizeFilename(raw)}`;
      const size = Number(f.size);
      if (!f.url_private_download || !Number.isInteger(size)) throw new Error(`${label}: Slack gives the app no download for it`);
      tally.add(label, size);
      let data: Uint8Array;
      try {
        data = await this.slack.download(String(f.url_private_download), size);
      } catch (e) {
        if (e instanceof SlackError && e.code === "size_mismatch") throw new Error(`${label}: Slack didn't serve it (does the app have files:read? reinstall it from the current manifest)`);
        if (e instanceof SlackError && e.code === "untrusted_host") throw new Error(`${label}: its download isn't on Slack's own host`);
        throw e;
      }
      out.push({ ...checkFile(label, raw, data), slack_file: String(f.id) });
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

  // Bridge status lines, as the bot itself, in a thread or (null) top level.
  // Failing to post one isn't worth more than a log line.
  private async say(threadTs: string | null, text: string): Promise<void> {
    try {
      await this.slack.call("chat.postMessage", { channel: this.o.channel, ...(threadTs ? { thread_ts: threadTs } : {}), markdown_text: text });
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

// Why Slack refused a file. Rethrows what a retry might fix (Slack
// unavailable) or nothing here can (a dead token); a missing files:write is a
// refusal, fixed by a reinstall.
function refusal(e: unknown): string {
  if (!(e instanceof SlackError) || (e.fatal && e.code !== "missing_scope")) throw e;
  return e.code === "missing_scope" ? "the Slack app lacks files:write (reinstall it from the current manifest)" : e.code;
}

const listRefused = (refused: Refused[]) => refused.map((r) => `${r.name}: ${r.why}`).join("; ");

function warning(refused: Refused[] | undefined): string | undefined {
  return refused?.length ? `⚠️ not delivered to Slack: ${listRefused(refused)}` : undefined;
}

/**
 * A grayboard item as Slack Markdown. The sender's handle leads in bold, so
 * attribution survives even if Slack ignores the username override. A new
 * thread from a board names the board. A handle with an email in it goes in a
 * code span, or Slack auto-links the address and shows it as "mailto:…".
 * A note (files that didn't make it) ends it, and the body is cut to fit.
 */
export function format(from: string, board: string | null, body: string, id: number, note?: string): string {
  const name = from.includes("@") ? `\`${from}\`` : `**${from}**`;
  const head = board ? `${name} · #${board} ·` : name;
  const tail = note ? `\n\n${note.length > MAX_NOTE ? `${note.slice(0, MAX_NOTE)}…` : note}` : "";
  const max = MAX_BODY - tail.length;
  const cut = body.length > max;
  const text = cut ? `${body.slice(0, max)}\n\n… (truncated; the full text is grayboard ${board ? "post" : "message"} ${id})` : body;
  return `${head}${text.includes("\n") ? "\n" : " "}${text}${tail}`;
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
