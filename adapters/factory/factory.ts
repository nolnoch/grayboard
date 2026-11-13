// The run loop (docs/factory.md §4–§7), harness-neutral: take a
// delegation that passes the authority check, or a task posted on a fleet's
// queue board, record it before anything else, answer in its thread at
// once, run it on a free slot, and reply with the outcome. Every reply goes
// where the request came from, in its thread.
import { chmodSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Delivery, FactoryBus } from "./bus.ts";
import { oneLine, requestOf, type Request } from "./delegate.ts";
import { parsePlan, synthesisPrompt, triageInstruction, type Plan } from "./fanout.ts";
import { resolvePersona, type Agent, type Outcome, type Policy, type Runner } from "./runner.ts";
import type { Admit, Row, RunOutcome, Store } from "./store.ts";
import type { Place, Workdir, Workspaces } from "./workdir.ts";

// A fleet (docs/factory.md §7): a queue board `<name>-tasks` the factory is
// a lane on, and the agent it runs each task with. The agent is the
// operator's choice, never the post's. `fanout` (default on) lets a task's
// run return a plan of subtasks instead of doing it (§7). `policy` and
// `workdir` are its profile's (#643, #641); absent, the factory's global ones.
// A project (#645) is a fleet whose `routes` are the profiles its plans may
// name, the lead's first; a fleet with a profile routes to that one alone.
export type Fleet = { name: string; agent: string; fanout?: boolean; profile?: string; policy?: Policy; workdir?: Workdir; routes?: Route[] };
export type Route = { profile: string; agent: string; policy: Policy; workdir: Workdir };
export const fleetBoard = (f: Fleet) => `${f.name}-tasks`;

// What a config reload (#645) replaces; the rest needs a restart.
export type Reconfig = { fleets: Fleet[]; policy: Policy; workdir: Workdir };

export type FactoryOptions = {
  fleets?: Fleet[];
  policy: Policy; // the global tool lists: delegations, and fleets without a profile
  workdir: Workdir; // the global working-directory mode, likewise
  workspaces: Workspaces; // where each run's directory is made, and swept once its tree is pruned
  runs: string; // the transcripts' directory (#649): <run id>.jsonl, 0700, swept once its run's row is pruned
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
  private readonly inflight = new Set<Promise<void>>(); // running execs, awaited at shutdown
  private readonly sending = new Set<string>(); // keys whose outcome is being sent, so housekeeping can't send one twice
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly joined = new Map<string, Fleet>(); // board → fleet, as the last sync left it
  private readonly queues = new Set<string>(); // every queue board, as the last sync saw them

  private cfg: Reconfig;

  constructor(private readonly bus: FactoryBus, private readonly store: Store, private readonly runner: Runner, private readonly o: FactoryOptions) {
    this.cfg = { fleets: o.fleets ?? [], policy: o.policy, workdir: o.workdir };
    // A transcript holds whatever its child read and wrote.
    mkdirSync(o.runs, { recursive: true, mode: 0o700 });
    chmodSync(o.runs, 0o700);
  }

  // A config reload (#645): new runs read the new fleets, projects and
  // global lists; a run already started keeps what it started with. A
  // queued task whose fleet is gone fails when it would run (settingsFor).
  async reconfigure(c: Reconfig): Promise<void> {
    this.cfg = c;
    await this.syncFleets();
    this.pump();
  }

  // Runs until the bus closes; resolves with why.
  async run(): Promise<string> {
    const again = (r: Row) => (r.parent !== null ? "The task's combined result will say this subtask was interrupted." : r.source === "dm" ? "Re-delegate it if it's still wanted." : "Post it again if it's still wanted.");
    for (const r of this.store.interrupted((r) => `[factory] interrupted: the factory stopped before this finished; nothing is running for it now. ${again(r)}`)) {
      this.o.log(`request ${r.id} was ${r.state} when the factory last stopped; reporting it interrupted`);
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
    return this.cfg.fleets;
  }

  // Makes the factory a lane on exactly its fleets' boards: creates a
  // missing board as a queue, subscribes to an existing one, and refuses a
  // fleet whose board exists as a broadcast board (every post there would
  // read as a task). Any other queue board it's a lane on is dropped: a lane
  // that ignores its deliveries holds each claim for the full TTL.
  async syncFleets(): Promise<void> {
    const listed = await this.bus.call("board_list");
    const boards = new Map((Array.isArray(listed) ? listed : []).map((b: { name: string; kind?: string; mode?: string | null }) => [b.name, b]));
    // Built aside and swapped in at the end: a reload (#645) runs this while
    // deliveries arrive, and one seen mid-sync must not find its fleet gone.
    const joined = new Map<string, Fleet>(), queues = new Set<string>();
    for (const b of boards.values()) if (b.kind === "queue") queues.add(b.name);
    for (const f of this.fleets()) {
      const name = fleetBoard(f), b = boards.get(name);
      try {
        if (!b) await this.bus.call("board_create", { name, purpose: `Tasks for the ${f.name} fleet: each top-level post is one task, run by one lane; replies come in its thread.`, kind: "queue" });
        else if ((b.kind ?? "broadcast") !== "queue") { this.o.log(`fleet ${f.name}: #${name} exists as a ${b.kind ?? "broadcast"} board, not a queue; skipping it`); continue; }
        else if (b.mode !== "push") await this.bus.call("board_subscribe", { board: name, mode: "push" });
        joined.set(name, f);
        queues.add(name);
      } catch (e) {
        this.o.log(`fleet ${f.name}: couldn't join #${name}: ${msg(e)}`);
      }
    }
    this.joined.clear();
    for (const [k, v] of joined) this.joined.set(k, v);
    this.queues.clear();
    for (const q of queues) this.queues.add(q);
    for (const b of boards.values()) {
      if (b.kind === "queue" && b.mode === "push" && !joined.has(b.name)) {
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

  // One slot's work: a request's run, a subtask's run, or a fanned-out
  // request's synthesis. A run that returns a plan fans out instead of
  // finishing; a subtask's end may queue its parent's synthesis. Never
  // throws past recording an outcome: anything unexpected finishes the row
  // failed.
  private async exec(row: Row): Promise<void> {
    let body: string | null;
    try {
      body = await this.outcome(row);
    } catch (e) {
      body = `[factory] failed: the factory couldn't run this: ${msg(e)}`;
    }
    if (body === null) return; // fanned out: its synthesis finishes it
    this.store.finish(row, clip(body));
    // Before the send's await: a crash during it must not strand a parent
    // whose subtasks all finished.
    if (row.parent !== null && this.store.synthesizeWhenDone(row.parent)) this.o.log(`request ${row.parent}: every subtask finished; synthesizing`);
    await this.send(this.store.get(row)!);
  }

  // The row's reply, or null when its run fanned out.
  private async outcome(row: Row): Promise<string | null> {
    const synth = row.phase === "synthesize";
    const max = this.o.maxSubtasks ?? 5;
    const set = this.settingsFor(row);
    if (typeof set === "string") return set;
    const ownDir = (s: Settings | string) => typeof s !== "string" && s.workdir.mode !== "shared";
    const routes = this.fleets().find((f) => f.name === row.persona)?.routes ?? [];
    const input: Request = synth
      ? { ...row, task: synthesisPrompt(row.task, this.store.subtasks(row.seq).map((s) => ({ title: s.title ?? "", reply: s.reply, dir: ownDir(this.settingsFor(s)) ? String(s.seq) : undefined }))), context: undefined }
      : row.fanout ? { ...row, task: `${row.task}\n\n${triageInstruction(max, ownDir(set), row.source === "board" ? routes.map((r) => ({ name: r.profile, agent: r.agent, tools: r.policy.tools?.join(", ") ?? "the default: no shell, no web fetch" })) : [])}` } : row;
    const out = await this.runAgent(row, input, set);
    const who = set.agent ?? row.agent;
    let body: string;
    if (typeof out === "string") body = out;
    else if (!out.ok) body = `[factory] failed: ${this.runner.harness} agent \`${who}\`: ${this.stopping ? "the factory stopped while this ran" : out.error}`;
    else {
      const plan = row.fanout && !synth ? parsePlan(out.text, max) : null;
      if (plan && typeof plan !== "string") {
        const why = await this.fanOut(row, plan);
        if (!why) return null;
        body = `[factory] failed: ${why}`;
      } else if (typeof plan === "string") {
        body = `[factory] failed: ${this.runner.harness} agent \`${who}\` returned a plan the factory can't use: ${plan}. Nothing was fanned out.`;
      } else {
        body = synth
          ? `[factory] done: ${this.runner.harness} agent \`${who}\`, combining ${this.store.subtasks(row.seq).length} subtasks on #${row.fanoutBoard}\n\n${out.text}`
          : `[factory] done: ${this.runner.harness} agent \`${who}\`\n\n${out.text}`;
      }
    }
    return body;
  }

  // Runs the row's agent on `input`; a string is a failure reply that needed no run.
  private async runAgent(row: Row, input: Request, set: Settings): Promise<Outcome | string> {
    const name = set.agent ?? row.agent;
    const agent = this.runner.roster().find((a) => a.name === name);
    if (!agent) return `[factory] failed: agent \`${name}\` left the ${this.runner.harness} roster before this ran; nothing was spawned.`;
    let place: Place;
    try {
      place = await this.o.workspaces.place(set.workdir, { tree: row.parent ?? row.seq, sub: row.parent !== null ? row.seq : null, synthesis: row.phase === "synthesize" });
    } catch (e) {
      return `[factory] failed: couldn't make the ${set.workdir.mode} working directory: ${msg(e)}; nothing was spawned.`;
    }
    const ac = new AbortController();
    this.children.add(ac);
    const t = setTimeout(() => ac.abort(), this.o.timeoutMs);
    this.o.log(`request ${row.id}: running ${this.runner.harness} agent ${agent.name}${row.phase === "synthesize" ? " (synthesis)" : row.parent !== null ? " (subtask)" : ""} for ${row.requester}`);
    const run = this.store.startRun(row.seq, agent.name);
    let ended: RunOutcome = "failed";
    let out: Outcome | undefined;
    try {
      out = await this.runner.run(agent, input, ac.signal, set.policy, place, join(this.o.runs, `${run}.jsonl`));
      ended = out.run?.stop ?? (out.ok ? "ok" : ac.signal.aborted ? "timeout" : "failed");
      return out;
    } catch (e) {
      return `[factory] failed: ${this.runner.harness} agent \`${agent.name}\` couldn't start: ${msg(e)}`;
    } finally {
      clearTimeout(t);
      this.children.delete(ac);
      this.store.endRun(run, ended, out?.run);
      const m = out?.run;
      this.o.log(`request ${row.id}: run ${run} ended ${ended}${m?.turns !== undefined ? `, ${m.turns} turn(s)` : ""}${m?.costUsd !== undefined ? `, $${m.costUsd.toFixed(4)}` : ""}`);
    }
  }

  // The run's policy and working-directory mode, from the config as it is
  // now: a fleet task and its subtasks (persona = the fleet's name) get the
  // fleet's; a delegation the global ones. A fleet gone from the config
  // fails the run rather than fall back to the global lists, which may be
  // wider than its profile.
  // A routed subtask (#645) gets its profile's, which must still be one of
  // its project's.
  private settingsFor(row: Row): Settings | string {
    const global: Settings = { policy: this.cfg.policy, workdir: this.cfg.workdir };
    if (row.source === "dm") return global;
    const f = this.fleets().find((f) => f.name === row.persona);
    if (!f) return `[factory] failed: fleet "${oneLine(row.persona)}" is no longer in the factory's config; nothing was spawned.`;
    if (row.profile !== null) {
      const r = f.routes?.find((r) => r.profile === row.profile);
      if (!r) return `[factory] failed: profile "${row.profile}" is no longer one of ${f.name}'s; nothing was spawned.`;
      return { policy: r.policy, workdir: r.workdir, agent: r.agent };
    }
    // The fleet's agent as the config now names it, so a reload never pairs
    // one agent with another's tool lists.
    return { policy: f.policy ?? global.policy, workdir: f.workdir ?? global.workdir, agent: f.agent };
  }

  // A plan's fan-out: a broadcast board `task-<post id>` as the durable,
  // visible record (anyone may read, subscribe or comment), one post per
  // subtask, each run here on the worker pool with its outcome in its
  // thread. The factory can't be a lane for posts it wrote (the core never
  // hands a poster its own post), so the board is a record, not a queue.
  // Returns why it couldn't, or null.
  private async fanOut(row: Row, plan: Plan): Promise<string | null> {
    if (row.source !== "board") return "only a fleet task fans out";
    // Routing (#645), checked before anything is posted: a subtask may name
    // only one of its project's profiles, so no plan widens what runs.
    const routes = this.fleets().find((f) => f.name === row.persona)?.routes ?? [];
    for (const [i, s] of plan.subtasks.entries()) {
      if (s.profile !== undefined && !routes.some((r) => r.profile === s.profile)) {
        return `subtask ${i + 1} names profile "${oneLine(s.profile)}", which isn't one of ${row.persona}'s (${routes.length ? routes.map((r) => r.profile).join(", ") : "it names none"}). Nothing was fanned out.`;
      }
    }
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
    const n = plan.subtasks.length, subtasks: { r: Request; title: string; profile?: string; agent?: string }[] = [];
    for (const [i, s] of plan.subtasks.entries()) {
      try {
        const route = s.profile !== undefined ? routes.find((r) => r.profile === s.profile)! : undefined;
        const res = (await this.bus.call("board_post", { board, body: `[factory] subtask ${i + 1}/${n}${route ? ` (${route.profile})` : ""}: ${s.title}\n\n${s.task}` })) as { post_id?: unknown };
        if (typeof res?.post_id !== "number") throw new Error("board_post returned no post_id");
        subtasks.push({ r: { source: "board", board, id: res.post_id, requester: row.requester, persona: row.persona, task: s.task }, title: s.title, ...(route ? { profile: route.profile, agent: route.agent } : {}) });
      } catch (e) {
        return `couldn't post subtask ${i + 1} of ${n} on #${board} (${subtasks.length} posted, none run): ${msg(e)}`;
      }
    }
    this.store.fanOut(row, board, subtasks);
    this.o.log(`request ${row.id}: fanned out ${n} subtasks on #${board}`);
    const agents = [...new Set(subtasks.map((s) => s.agent ?? row.agent))];
    const as = agents.length === 1 ? `each run as \`${agents[0]}\`` : `each run as its profile's agent`;
    await this.reply(row, `[factory] fanned out: ${n} subtasks on #${board}, ${as} with its outcome in its thread. The combined result follows in this thread.`).catch((e) => this.o.log(`couldn't announce the fan-out of ${row.source} ${row.id}: ${msg(e)}`));
    return null;
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
    // After the prune: a tree goes once its request's row has.
    const t = await this.o.workspaces.sweep((seq) => this.store.has(seq));
    if (t) this.o.log(`removed ${t} working director${t === 1 ? "y" : "ies"} of pruned requests`);
    const x = this.sweepTranscripts();
    if (x) this.o.log(`removed ${x} transcript${x === 1 ? "" : "s"} of pruned runs`);
  }

  // A transcript goes once its run's row has (pruned with its request).
  // Anything else in the directory is left alone.
  private sweepTranscripts(): number {
    let n = 0;
    let names: string[];
    try { names = readdirSync(this.o.runs); } catch { return 0; }
    for (const f of names) {
      const m = /^(\d+)\.jsonl$/.exec(f);
      if (!m || this.store.hasRun(Number(m[1]))) continue;
      try { rmSync(join(this.o.runs, f), { force: true }); n++; } catch {}
    }
    return n;
  }
}

type Settings = { policy: Policy; workdir: Workdir; agent?: string };

function clip(body: string): string {
  const bytes = new TextEncoder().encode(body);
  if (bytes.length <= MAX_REPLY_BYTES) return body;
  const cut = new TextDecoder().decode(bytes.slice(0, MAX_REPLY_BYTES)).replace(/�$/, "");
  return `${cut}\n\n[factory] output truncated at ${MAX_REPLY_BYTES} bytes.`;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
