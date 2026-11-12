// The run loop (docs/factory.md §4–§7), harness-neutral: take a
// delegation that passes the authority check, or a task posted on a fleet's
// queue board, record it before anything else, answer in its thread at
// once, run it on a free slot, and reply with the outcome. Every reply goes
// where the request came from, in its thread.
import type { Delivery, FactoryBus } from "./bus.ts";
import { oneLine, requestOf, type Request } from "./delegate.ts";
import { resolvePersona, type Agent, type Runner } from "./runner.ts";
import type { Row, Store } from "./store.ts";

// A fleet (docs/factory.md §7): a queue board `<name>-tasks` the factory is
// a lane on, and the agent it runs each task with. The agent is the
// operator's choice, never the post's.
export type Fleet = { name: string; agent: string };
export const fleetBoard = (f: Fleet) => `${f.name}-tasks`;

export type FactoryOptions = {
  fleets?: Fleet[];
  maxConcurrent: number;
  timeoutMs: number;
  retentionMs: number;
  housekeepingMs?: number; // how often unsent replies are retried and the store pruned
  log(message: string): void;
};

// A DM body's cap is 64 KiB (src/core/boards.ts MAX_BODY_BYTES); leave room for the frame.
const MAX_REPLY_BYTES = 60 * 1024;

export class Factory {
  private running = 0;
  private stopping = false;
  private readonly children = new Set<AbortController>();
  private readonly inflight = new Set<Promise<void>>(); // running execs, awaited at shutdown
  private readonly sending = new Set<string>(); // keys whose outcome is being sent, so housekeeping can't send one twice
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly joined = new Map<string, Fleet>(); // board → fleet, as the last sync left it

  constructor(private readonly bus: FactoryBus, private readonly store: Store, private readonly runner: Runner, private readonly o: FactoryOptions) {}

  // Runs until the bus closes; resolves with why.
  async run(): Promise<string> {
    for (const r of this.store.interrupted(() => `[factory] interrupted: the factory stopped while this ran; nothing is running for it now. Re-delegate it if it's still wanted.`)) {
      this.o.log(`request ${r.id} was running when the factory last stopped; reporting it interrupted`);
    }
    await this.syncFleets();
    await this.housekeeping();
    this.timer = setInterval(() => void this.housekeeping().catch((e) => this.o.log(`housekeeping: ${msg(e)}`)), this.o.housekeepingMs ?? 3_600_000);
    this.pump();
    // One bad delivery must not end the loop: log it and take the next.
    const consume = (async () => {
      for await (const d of this.bus.deliveries()) await this.take(d).catch((e) => this.o.log(`couldn't take a delivery: ${msg(e)}`));
    })();
    const why = await this.bus.closed;
    this.stop();
    await consume.catch(() => {});
    await this.settle();
    return why;
  }

  // Waits for running execs to record their outcome (stop() aborted their
  // children, whose groups get SIGKILL after a grace), so the caller can
  // close the store. A row still running past the deadline is reported
  // interrupted at the next start.
  private async settle(deadlineMs = 15_000): Promise<void> {
    if (!this.inflight.size) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<void>((ok) => (t = setTimeout(() => { this.o.log(`${this.inflight.size} run(s) didn't finish within ${deadlineMs} ms of stopping`); ok(); }, deadlineMs)));
    await Promise.race([Promise.allSettled([...this.inflight]), late]);
    clearTimeout(t);
  }

  stop(): void {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    for (const c of this.children) c.abort();
  }

  async take(d: Delivery): Promise<void> {
    if (d.kind === "board") return this.takePost(d);
    const v = requestOf(d);
    if (!v) return;
    if ("ignored" in v) { this.o.log(`ignored: ${v.ignored}`); return; }
    const r = v.request;
    const agent = resolvePersona(r.persona, this.runner.roster());
    if (!agent) {
      if (this.store.admitFinished(r, this.declineBody(r))) await this.send(this.store.get(r)!);
      return;
    }
    await this.admit(r, agent, `persona "${oneLine(r.persona)}"`);
  }

  // A fleet task: a top-level post on a fleet's board, delivered by the queue
  // rotation (reason "subscription", this lane holds its claim) or by an
  // @mention (no claim). Replies in a task's thread are its conversation,
  // not tasks. The poster is the requester: on a local bus every handle is
  // the same OS user, as with a delegation.
  private async takePost(d: Extract<Delivery, { kind: "board" }>): Promise<void> {
    if (d.parentId !== undefined || d.postId === undefined || !d.from) return;
    const key = `queue:${d.board}:${d.postId}`;
    const fleet = this.joined.get(d.board);
    if (!fleet) {
      // Not ours (a subscription the sync hasn't dropped yet): pass any claim on.
      if (d.reason === "subscription") await this.release(key, "not a factory fleet board");
      return;
    }
    const r: Request = { source: "board", board: d.board, id: d.postId, requester: d.from, persona: fleet.name, task: d.body };
    const agent = this.runner.roster().find((a) => a.name === fleet.agent);
    if (!agent) {
      const why = `fleet "${fleet.name}"'s agent \`${fleet.agent}\` isn't in the ${this.runner.harness} roster (${this.runner.rosterSource})`;
      // A claim passes to the next lane, which may run it; a mention has no
      // claim, so its poster hears why.
      if (d.reason === "subscription") { this.o.log(`post ${d.postId}: ${why}; passing it on`); await this.release(key, `factory: ${why}`); return; }
      if (this.store.admitFinished(r, `[factory] declined: ${why}. Nothing was spawned.`)) await this.send(this.store.get(r)!);
      return;
    }
    await this.admit(r, agent, `fleet "${fleet.name}"`);
  }

  private async admit(r: Request, agent: Agent, label: string): Promise<void> {
    if (!this.store.admit(r, agent.name)) { this.o.log(`${r.source} ${r.id} already taken; redelivery ignored`); return; }
    const where = this.running < this.o.maxConcurrent ? "starting now" : `queued, ${this.store.queuedAhead(r)} ahead`;
    // §13's launcher contract: say it was taken before the work starts. On a
    // queue board this reply also acks the claim, so the rotation never
    // redelivers a task that's running. Not stored: a lost acknowledgement
    // costs nothing the outcome won't say.
    await this.reply(r, `[factory] taken: ${label} runs as ${this.runner.harness} agent \`${agent.name}\`, ${where}. The outcome follows in this thread.`).catch((e) => this.o.log(`couldn't acknowledge ${r.source} ${r.id}: ${msg(e)}`));
    this.pump();
  }

  private async release(key: string, note: string): Promise<void> {
    await this.bus.call("claim_release", { key, note }).catch((e) => this.o.log(`couldn't release ${key}: ${msg(e)}`));
  }

  private fleets(): Fleet[] {
    return this.o.fleets ?? [];
  }

  // Makes the factory a lane on exactly its fleets' boards: creates a
  // missing board as a queue, subscribes to an existing one, and refuses a
  // fleet whose board exists as a broadcast board (every post there would
  // read as a task). Any other queue board it's a lane on is dropped: a lane
  // that ignores its deliveries holds each claim for the full TTL.
  async syncFleets(): Promise<void> {
    const listed = await this.bus.call("board_list");
    const boards = new Map((Array.isArray(listed) ? listed : []).map((b: { name: string; kind?: string; mode?: string | null }) => [b.name, b]));
    this.joined.clear();
    for (const f of this.fleets()) {
      const name = fleetBoard(f), b = boards.get(name);
      try {
        if (!b) await this.bus.call("board_create", { name, purpose: `Tasks for the ${f.name} fleet: each top-level post is one task, run by one lane; replies come in its thread.`, kind: "queue" });
        else if ((b.kind ?? "broadcast") !== "queue") { this.o.log(`fleet ${f.name}: #${name} exists as a ${b.kind ?? "broadcast"} board, not a queue; skipping it`); continue; }
        else if (b.mode !== "push") await this.bus.call("board_subscribe", { board: name, mode: "push" });
        this.joined.set(name, f);
      } catch (e) {
        this.o.log(`fleet ${f.name}: couldn't join #${name}: ${msg(e)}`);
      }
    }
    for (const b of boards.values()) {
      if (b.kind === "queue" && b.mode === "push" && !this.joined.has(b.name)) {
        await this.bus.call("board_subscribe", { board: b.name, mode: "off" }).catch((e) => this.o.log(`couldn't leave #${b.name}: ${msg(e)}`));
        this.o.log(`left #${b.name}: no fleet in the config uses it`);
      }
    }
  }

  private pump(): void {
    while (!this.stopping && this.running < this.o.maxConcurrent) {
      const row = this.store.next();
      if (!row) return;
      this.running++;
      const p: Promise<void> = this.exec(row)
        .catch((e) => this.o.log(`request ${row.id}: ${msg(e)}`))
        .finally(() => { this.running--; this.inflight.delete(p); this.pump(); });
      this.inflight.add(p);
    }
  }

  // Never throws past recording an outcome: anything unexpected finishes the row failed.
  private async exec(row: Row): Promise<void> {
    let body: string;
    try {
      body = await this.outcome(row);
    } catch (e) {
      body = `[factory] failed: the factory couldn't run this: ${msg(e)}`;
    }
    this.store.finish(row, clip(body));
    await this.send(this.store.get(row)!);
  }

  private async outcome(row: Row): Promise<string> {
    const agent = this.runner.roster().find((a) => a.name === row.agent);
    let body: string;
    if (!agent) {
      body = `[factory] failed: agent \`${row.agent}\` left the ${this.runner.harness} roster before this ran; nothing was spawned.`;
    } else {
      const ac = new AbortController();
      this.children.add(ac);
      const t = setTimeout(() => ac.abort(), this.o.timeoutMs);
      this.o.log(`request ${row.id}: running ${this.runner.harness} agent ${agent.name} for ${row.requester}`);
      try {
        const out = await this.runner.run(agent, row, ac.signal);
        body = out.ok
          ? `[factory] done: ${this.runner.harness} agent \`${agent.name}\`\n\n${out.text}`
          : `[factory] failed: ${this.runner.harness} agent \`${agent.name}\`: ${this.stopping ? "the factory stopped while this ran" : out.error}`;
      } catch (e) {
        body = `[factory] failed: ${this.runner.harness} agent \`${agent.name}\` couldn't start: ${msg(e)}`;
      } finally {
        clearTimeout(t);
        this.children.delete(ac);
      }
    }
    return body;
  }

  private declineBody(r: Request): string {
    const names = this.runner.roster().map((a) => a.name).slice(0, 20);
    return `[factory] declined: no ${this.runner.harness} agent matches persona "${oneLine(r.persona)}" (roster: ${names.length ? names.join(", ") : "empty"}; read from ${this.runner.rosterSource}). Nothing was spawned. Re-delegate to another launcher or handle it yourself.`;
  }

  // A finished outcome's reply; it stays unsent (retried by housekeeping) if the send fails.
  private async send(k: Row): Promise<void> {
    const key = `${k.source}:${k.id}`;
    if (this.sending.has(key)) return;
    const row = this.store.get(k); // fresh: a caller's copy may predate another send
    if (!row || row.replied || row.reply === null) return;
    this.sending.add(key);
    try {
      await this.reply(row, row.reply);
      this.store.markReplied(row);
    } catch (e) {
      this.o.log(`couldn't send the outcome of request ${row.id}; will retry: ${msg(e)}`);
    } finally {
      this.sending.delete(key);
    }
  }

  // Every reply goes where the request came from, in its thread.
  private reply(r: Request, body: string): Promise<unknown> {
    if (r.source === "board") return this.bus.call("board_post", { board: r.board, body, parent_id: r.id });
    return this.bus.call("dm_send", { to: r.requester, body, parent_id: r.id });
  }

  private async housekeeping(): Promise<void> {
    for (const row of this.store.unsent()) {
      if (this.stopping) return;
      await this.send(row);
    }
    const n = this.store.prune(this.o.retentionMs);
    if (n) this.o.log(`pruned ${n} finished request${n === 1 ? "" : "s"}`);
  }
}

function clip(body: string): string {
  const bytes = new TextEncoder().encode(body);
  if (bytes.length <= MAX_REPLY_BYTES) return body;
  const cut = new TextDecoder().decode(bytes.slice(0, MAX_REPLY_BYTES)).replace(/�$/, "");
  return `${cut}\n\n[factory] output truncated at ${MAX_REPLY_BYTES} bytes.`;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
