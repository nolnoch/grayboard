// The run loop (docs/factory.md §4–§7), harness-neutral: take a
// delegation that passes the authority check, or a task posted on a fleet's
// queue board, record it before anything else, answer in its thread at
// once, run it on a free slot, and reply with the outcome. Every reply goes
// where the request came from, in its thread.
import type { Delivery, FactoryBus } from "./bus.ts";
import { oneLine, requestOf, type Request } from "./delegate.ts";
import { parsePlan, synthesisPrompt, triageInstruction, type Plan } from "./fanout.ts";
import { resolvePersona, type Agent, type Outcome, type Runner } from "./runner.ts";
import type { Admit, Row, Store } from "./store.ts";

// A fleet (docs/factory.md §7): a queue board `<name>-tasks` the factory is
// a lane on, and the agent it runs each task with. The agent is the
// operator's choice, never the post's. `fanout` (default on) lets a task's
// run return a plan of subtasks instead of doing it (§7).
export type Fleet = { name: string; agent: string; fanout?: boolean };
export const fleetBoard = (f: Fleet) => `${f.name}-tasks`;

export type FactoryOptions = {
  fleets?: Fleet[];
  maxConcurrent: number;
  maxSubtasks?: number; // a fan-out plan's cap (default 5)
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
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly joined = new Map<string, Fleet>(); // board → fleet, as the last sync left it
  private readonly queues = new Set<string>(); // every queue board, as the last sync saw them

  constructor(private readonly bus: FactoryBus, private readonly store: Store, private readonly runner: Runner, private readonly o: FactoryOptions) {}

  // Runs until the bus closes; resolves with why.
  async run(): Promise<string> {
    const again = (r: Row) => (r.parent !== null ? "Its task's combined result won't come." : r.source === "dm" ? "Re-delegate it if it's still wanted." : "Post it again if it's still wanted.");
    for (const r of this.store.interrupted((r) => `[factory] interrupted: the factory stopped before this finished; nothing is running for it now. ${again(r)}`)) {
      this.o.log(`request ${r.id} was ${r.state} when the factory last stopped; reporting it interrupted`);
    }
    await this.syncFleets();
    await this.housekeeping();
    this.timer = setInterval(() => void this.housekeeping(), this.o.housekeepingMs ?? 3_600_000);
    this.pump();
    const consume = (async () => { for await (const d of this.bus.deliveries()) await this.take(d); })();
    const why = await this.bus.closed;
    this.stop();
    await consume.catch(() => {});
    return why;
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
      // (A broadcast board's posts arrive with the same reason and hold no claim.)
      if (d.reason === "subscription" && this.queues.has(d.board)) await this.release(key, "not a factory fleet board");
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
    await this.admit(r, agent, `fleet "${fleet.name}"`, { fanout: fleet.fanout !== false });
  }

  private async admit(r: Request, agent: Agent, label: string, o: Admit = {}): Promise<void> {
    if (!this.store.admit(r, agent.name, o)) { this.o.log(`${r.source} ${r.id} already taken; redelivery ignored`); return; }
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
    this.queues.clear();
    for (const b of boards.values()) if (b.kind === "queue") this.queues.add(b.name);
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
      void this.exec(row).finally(() => { this.running--; this.pump(); });
    }
  }

  // One slot's work: a request's run, a subtask's run, or a fanned-out
  // request's synthesis. A run that returns a plan fans out instead of
  // finishing; a subtask's end may queue its parent's synthesis.
  private async exec(row: Row): Promise<void> {
    const synth = row.phase === "synthesize";
    const max = this.o.maxSubtasks ?? 5;
    const input: Request = synth
      ? { ...row, task: synthesisPrompt(row.task, this.store.subtasks(row.seq).map((s) => ({ title: s.title ?? "", reply: s.reply }))), context: undefined }
      : row.fanout ? { ...row, task: `${row.task}\n\n${triageInstruction(max)}` } : row;
    const out = await this.runAgent(row, input);
    let body: string;
    if (typeof out === "string") body = out;
    else if (!out.ok) body = `[factory] failed: ${this.runner.harness} agent \`${row.agent}\`: ${this.stopping ? "the factory stopped while this ran" : out.error}`;
    else {
      const plan = row.fanout && !synth ? parsePlan(out.text, max) : null;
      if (plan && typeof plan !== "string") {
        const why = await this.fanOut(row, plan);
        if (!why) return;
        body = `[factory] failed: ${why}`;
      } else if (typeof plan === "string") {
        body = `[factory] failed: ${this.runner.harness} agent \`${row.agent}\` returned a plan the factory can't use: ${plan}. Nothing was fanned out.`;
      } else {
        body = synth
          ? `[factory] done: ${this.runner.harness} agent \`${row.agent}\`, combining ${this.store.subtasks(row.seq).length} subtasks on #${row.fanoutBoard}\n\n${out.text}`
          : `[factory] done: ${this.runner.harness} agent \`${row.agent}\`\n\n${out.text}`;
      }
    }
    this.store.finish(row, clip(body));
    // Before the send's await: a crash during it must not strand a parent
    // whose subtasks all finished.
    if (row.parent !== null && this.store.synthesizeWhenDone(row.parent)) this.o.log(`request ${row.parent}: every subtask finished; synthesizing`);
    await this.send(this.store.get(row)!);
  }

  // Runs the row's agent on `input`; a string is a failure reply that needed no run.
  private async runAgent(row: Row, input: Request): Promise<Outcome | string> {
    const agent = this.runner.roster().find((a) => a.name === row.agent);
    if (!agent) return `[factory] failed: agent \`${row.agent}\` left the ${this.runner.harness} roster before this ran; nothing was spawned.`;
    const ac = new AbortController();
    this.children.add(ac);
    const t = setTimeout(() => ac.abort(), this.o.timeoutMs);
    this.o.log(`request ${row.id}: running ${this.runner.harness} agent ${agent.name}${row.phase === "synthesize" ? " (synthesis)" : row.parent !== null ? " (subtask)" : ""} for ${row.requester}`);
    try {
      return await this.runner.run(agent, input, ac.signal);
    } catch (e) {
      return `[factory] failed: ${this.runner.harness} agent \`${agent.name}\` couldn't start: ${msg(e)}`;
    } finally {
      clearTimeout(t);
      this.children.delete(ac);
    }
  }

  // A plan's fan-out: a broadcast board `task-<post id>` as the durable,
  // visible record (anyone may read, subscribe or comment), one post per
  // subtask, each run here on the worker pool with its outcome in its
  // thread. The factory can't be a lane for posts it wrote (the core never
  // hands a poster its own post), so the board is a record, not a queue.
  // Returns why it couldn't, or null.
  private async fanOut(row: Row, plan: Plan): Promise<string | null> {
    if (row.source !== "board") return "only a fleet task fans out";
    const purpose = `Subtasks of ${oneLine(row.requester)}'s post ${row.id} on #${row.board}, fanned out by ${this.bus.handle}: one top-level post per subtask, its outcome in its thread.`;
    // A board of that name someone else made: the next suffix.
    let board = "";
    for (let k = 1; !board; k++) {
      const name = k === 1 ? `task-${row.id}` : `task-${row.id}-${k}`;
      try {
        await this.bus.call("board_create", { name, purpose });
        board = name;
      } catch (e) {
        if (k < 3 && /already exists/.test(msg(e))) continue;
        return `couldn't open #${name} for the fan-out: ${msg(e)}`;
      }
    }
    try {
      await this.bus.call("board_subscribe", { board, mode: "off" }); // its own posts and their threads are the factory's to write, not to take
    } catch (e) {
      this.o.log(`couldn't mute #${board}: ${msg(e)}`);
    }
    const n = plan.subtasks.length, subtasks: { r: Request; title: string }[] = [];
    for (const [i, s] of plan.subtasks.entries()) {
      try {
        const res = (await this.bus.call("board_post", { board, body: `[factory] subtask ${i + 1}/${n}: ${s.title}\n\n${s.task}` })) as { post_id?: unknown };
        if (typeof res?.post_id !== "number") throw new Error("board_post returned no post_id");
        subtasks.push({ r: { source: "board", board, id: res.post_id, requester: row.requester, persona: row.persona, task: s.task }, title: s.title });
      } catch (e) {
        return `couldn't post subtask ${i + 1} of ${n} on #${board} (${subtasks.length} posted, none run): ${msg(e)}`;
      }
    }
    this.store.fanOut(row, board, subtasks);
    this.o.log(`request ${row.id}: fanned out ${n} subtasks on #${board}`);
    await this.reply(row, `[factory] fanned out: ${n} subtasks on #${board}, each run as \`${row.agent}\` with its outcome in its thread. The combined result follows in this thread.`).catch((e) => this.o.log(`couldn't announce the fan-out of ${row.source} ${row.id}: ${msg(e)}`));
    return null;
  }

  private declineBody(r: Request): string {
    const names = this.runner.roster().map((a) => a.name).slice(0, 20);
    return `[factory] declined: no ${this.runner.harness} agent matches persona "${oneLine(r.persona)}" (roster: ${names.length ? names.join(", ") : "empty"}; read from ${this.runner.rosterSource}). Nothing was spawned. Re-delegate to another launcher or handle it yourself.`;
  }

  // A finished outcome's reply; it stays unsent (retried by housekeeping) if the send fails.
  private async send(row: Row): Promise<void> {
    if (row.replied || row.reply === null) return;
    try {
      await this.reply(row, row.reply);
      this.store.markReplied(row);
    } catch (e) {
      this.o.log(`couldn't send the outcome of request ${row.id}; will retry: ${msg(e)}`);
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
