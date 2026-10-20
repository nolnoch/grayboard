// Routing between one human's grayboard handle and one private Slack channel.
//
// Grayboard → Slack: each channel notification the bridge's `grayboard mcp`
// child pushes goes into the outbox, then out to Slack in order. A grayboard
// thread (DM or board) maps to one Slack thread, keyed on the grayboard root.
//
// Slack → grayboard: the owner's replies in a mapped thread become threaded
// replies (dm_send / board_post with parent_id), so only that conversation's
// agents wake. A top-level "@handle …" or "#board …" starts a new one.
import type { Store, ThreadRow } from "./store.ts";

/** The thread map and outbox: store.ts locally, the server's tables and acks in server mode. */
export type RelayStore = Pick<Store, "thread" | "byTs" | "addThread" | "advance" | "enqueue" | "pending" | "done">;
import { SlackError, SlackUnavailable, type SlackWeb } from "./web.ts";

export type ChannelParams = { content: string; meta: Record<string, string> };

export type ToolResult = { ok: true; value: any } | { ok: false; error: string };

/** The bridge's grayboard session: tool calls on its child. */
export type Bus = { call(name: string, args: Record<string, unknown>): Promise<ToolResult> };

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
};

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

  constructor(
    private readonly store: RelayStore,
    private readonly bus: Bus,
    private readonly slack: SlackWeb,
    private readonly o: RelayOptions,
  ) {
    this.log = o.log ?? (() => {});
    this.debug = o.debug ?? (() => {});
    this.retryMs = o.retryMs ?? 5000;
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
    for (;;) {
      try {
        await this.forward(p);
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

  private async forward(p: ChannelParams): Promise<void> {
    const m = p.meta ?? {};
    if (m.board && m.post_id) {
      const id = Number(m.post_id);
      const root = m.parent_id ? await this.boardRoot(m.board, id) : id;
      await this.postInThread({ kind: "board", board: m.board, root, id, from: m.from ?? "?", body: p.content });
    } else if (m.message_id) {
      const id = Number(m.message_id);
      const root = m.parent_id ? await this.dmRoot(id) : id;
      await this.postInThread({ kind: "dm", board: null, root, id, from: m.from ?? "?", body: p.content });
    }
  }

  private async postInThread(x: {
    kind: "dm" | "board";
    board: string | null;
    root: number;
    id: number;
    from: string;
    body: string;
  }): Promise<void> {
    const row = this.store.thread(x.kind, x.board, x.root);
    const name = this.o.label?.(x.from) ?? x.from;
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
    // Only the owner, only this channel, only new messages (no edits, deletes,
    // joins, or bot posts, including our own).
    if (e.channel !== this.o.channel || e.user !== this.o.owner || e.subtype || e.bot_id) {
      if (e.channel === this.o.channel) this.debug(`ignored message ${e.ts}: subtype=${e.subtype ?? "-"} bot_id=${e.bot_id ?? "-"} user=${e.user ?? "-"}`);
      return;
    }
    const text = fromSlack(String(e.text ?? "")).trim();
    if (!text) return;
    const ts = String(e.ts);
    const threadTs = e.thread_ts && e.thread_ts !== e.ts ? String(e.thread_ts) : null;
    try {
      if (threadTs) await this.reply(threadTs, ts, text);
      else await this.start(ts, text);
    } catch (err) {
      if (err instanceof SlackError && err.fatal) {
        this.stop();
        this.o.onFatal(err.message);
        return;
      }
      await this.say(threadTs ?? ts, `⚠️ not sent: ${(err as Error).message}`);
    }
  }

  private async reply(threadTs: string, ts: string, text: string): Promise<void> {
    const row = this.store.byTs(threadTs);
    if (!row) {
      await this.say(threadTs, `This thread isn't connected to a grayboard conversation. ${HINT}`);
      return;
    }
    if (row.kind === "dm") await this.sendDm(row.peer!, text, row.last_id, ts, row);
    else await this.sendPost(row.board!, text, row.last_id, ts, row);
  }

  private async start(ts: string, text: string): Promise<void> {
    // A bare handle, or on a server user@org/name for someone else's agent.
    const dm = /^@((?:[a-z0-9._%+-]+@[a-z0-9.-]+\/)?[a-z0-9_-]{1,32})[\s:,]+(\S[\s\S]*)$/i.exec(text);
    if (dm) return this.sendDm(dm[1]!.toLowerCase(), dm[2]!, undefined, ts, null);
    const nb = /^new\s+#([a-z0-9_-]{1,32})(?:[\s:,]+(\S[\s\S]*))?$/i.exec(text);
    if (nb) return this.createBoard(nb[1]!.toLowerCase(), nb[2], ts);
    const bp = /^#([a-z0-9_-]{1,32})\s+(\S[\s\S]*)$/i.exec(text);
    if (bp) return this.sendPost(bp[1]!.toLowerCase(), bp[2]!, undefined, ts, null);
    await this.say(ts, HINT);
  }

  // row: the mapped thread being replied in, or null to map a new one rooted
  // at the Slack message `ts`.
  private async sendDm(to: string, body: string, parent: number | undefined, ts: string, row: ThreadRow | null): Promise<void> {
    const r = await this.bus.call("dm_send", { to, body, ...(parent !== undefined ? { parent_id: parent } : {}) });
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

  private async sendPost(board: string, body: string, parent: number | undefined, ts: string, row: ThreadRow | null): Promise<void> {
    const r = await this.bus.call("board_post", { board, body, ...(parent !== undefined ? { parent_id: parent } : {}) });
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
