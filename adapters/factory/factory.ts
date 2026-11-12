// The run loop (docs/factory.md §4–§6), harness-neutral: take a
// delegation that passes the authority check, record it before anything
// else, answer in its thread at once, run it on a free slot, and reply with
// the outcome. Every reply goes to the request's sender, in its thread.
import type { Delivery, FactoryBus } from "./bus.ts";
import { oneLine, requestOf, type Request } from "./delegate.ts";
import { resolvePersona, type Runner } from "./runner.ts";
import type { Row, Store } from "./store.ts";

export type FactoryOptions = {
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
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly bus: FactoryBus, private readonly store: Store, private readonly runner: Runner, private readonly o: FactoryOptions) {}

  // Runs until the bus closes; resolves with why.
  async run(): Promise<string> {
    for (const r of this.store.interrupted(() => `[factory] interrupted: the factory stopped while this ran; nothing is running for it now. Re-delegate it if it's still wanted.`)) {
      this.o.log(`request ${r.id} was running when the factory last stopped; reporting it interrupted`);
    }
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
    const v = requestOf(d);
    if (!v) return;
    if ("ignored" in v) { this.o.log(`ignored: ${v.ignored}`); return; }
    const r = v.request;
    const agent = resolvePersona(r.persona, this.runner.roster());
    if (!agent) {
      if (this.store.admitFinished(r, this.declineBody(r))) await this.send(this.store.get(r.id)!);
      return;
    }
    if (!this.store.admit(r, agent.name)) { this.o.log(`request ${r.id} already taken; redelivery ignored`); return; }
    const where = this.running < this.o.maxConcurrent ? "starting now" : `queued, ${this.store.queuedAhead(r.id)} ahead`;
    // §13's launcher contract: say it was taken before the work starts. Not
    // stored: a lost acknowledgement costs nothing the outcome won't say.
    await this.reply(r, `[factory] taken: persona "${oneLine(r.persona)}" runs as ${this.runner.harness} agent \`${agent.name}\`, ${where}. The outcome follows in this thread.`).catch((e) => this.o.log(`couldn't acknowledge request ${r.id}: ${msg(e)}`));
    this.pump();
  }

  private pump(): void {
    while (!this.stopping && this.running < this.o.maxConcurrent) {
      const row = this.store.next();
      if (!row) return;
      this.running++;
      void this.exec(row).finally(() => { this.running--; this.pump(); });
    }
  }

  private async exec(row: Row): Promise<void> {
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
    this.store.finish(row.id, clip(body));
    await this.send(this.store.get(row.id)!);
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
      this.store.markReplied(row.id);
    } catch (e) {
      this.o.log(`couldn't send the outcome of request ${row.id}; will retry: ${msg(e)}`);
    }
  }

  private reply(r: { id: number; requester: string }, body: string): Promise<unknown> {
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
