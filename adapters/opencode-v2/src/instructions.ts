import type { SessionContext } from "@opencode/plugin/promise/session";
import { accessExpiry, Refusal } from "./core/model.js";
import { InsufficientScope } from "./core/wire.js";

// OpenCode's native MCP client sends `initialize` without a session ID and keeps
// its instructions for the process, so every session's system prompt carries
// grayboard's session-less unbound text (#531). On each primary request of an
// enrolled root, the plugin's `context` hook rebuilds grayboard's entry in that
// prompt with the root's current server instructions: omp's #441 rewrite.

// A root's current server instructions; `signal` aborts at shutdown.
export type Fetcher = (sessionID: string, signal: AbortSignal) => Promise<string | undefined>;
export type Plan = "none" | "replace";
type Root = { text?: string; fresh: boolean; generation: number; fetching?: Promise<void>; reported: boolean };

// OpenCode puts no timeout on the hook and a rejected hook fails the step; a
// fetch that outruns this still fills the cache for the next request.
export const DEADLINE_MS = 2_000;
const EXECUTE_LINE = "    Use tools from this server through `execute` under `tools[";

// `text` with every grayboard entry rebuilt around `current`, exactly as
// OpenCode's `entries()` writes one: the frame and its codemode line kept,
// each instruction line indented four spaces. That indentation is why server
// text can never write the `  </server>` line that closes the frame.
export function rebuild(text: string, mcpName: string, current: string): { plan: Plan; text: string } {
  const open = `  <server name="${mcpName}">`, close = "  </server>";
  const lines = text.split("\n");
  const out: string[] = [];
  let plan: Plan = "none";
  for (let i = 0; i < lines.length; i++) {
    const end = lines[i] === open ? lines.indexOf(close, i + 1) : -1;
    if (end < 0) { out.push(lines[i]!); continue; }
    plan = "replace";
    out.push(open);
    if (lines[i + 1]?.startsWith(EXECUTE_LINE)) out.push(lines[i + 1]!);
    out.push(...current.split("\n").map(line => `    ${line}`), close);
    i = end;
  }
  return { plan, text: plan === "none" ? text : out.join("\n") };
}

// Only a new sign-in fetches them again: the root's cached text is dropped.
// An `expired` access is token rollover, which the Controller waits out, so it
// keeps the last text like any other transient failure.
function signedOut(error: unknown): boolean {
  const expiry = accessExpiry(error);
  if (expiry) return expiry.reason !== "expired";
  for (let e = error, depth = 0; e && depth < 8; e = e instanceof Error ? e.cause : undefined, depth++) {
    if (e instanceof InsufficientScope || e instanceof Refusal && (e.code === "auth" || e.code === "binding")) return true;
  }
  return false;
}

// Each root's last fetched instructions, refetched after `invalidate`. One
// fetch in flight per root; one that ends after an invalidation fetches again.
export class RootInstructions {
  private readonly roots = new Map<string, Root>();
  private readonly closing = new AbortController();
  constructor(
    private readonly fetch: Fetcher,
    // A fetch failure, once per root until a fetch for it succeeds.
    private readonly report: (sessionID: string, error: unknown) => void,
    private readonly deadline = DEADLINE_MS,
  ) {}
  invalidate(sessionID: string) {
    const r = this.roots.get(sessionID);
    if (r) { r.fresh = false; r.generation++; }
  }
  forget(sessionID: string) { this.invalidate(sessionID); this.roots.delete(sessionID); }
  close() { this.closing.abort(); this.roots.clear(); }
  // What the root's next request carries: fresh text, the last fetched (a
  // refetch running, or the last one failed), or none.
  state(sessionID: string): "fresh" | "stale" | "none" {
    const r = this.roots.get(sessionID);
    return r?.text === undefined ? "none" : r.fresh && !r.reported ? "fresh" : "stale";
  }
  // The root's instructions within the deadline: fresh, or the last fetched while a refetch runs.
  async current(sessionID: string): Promise<string | undefined> {
    if (this.closing.signal.aborted) return;
    let r = this.roots.get(sessionID);
    if (!r) { r = { fresh: false, generation: 0, reported: false }; this.roots.set(sessionID, r); }
    if (r.fresh) return r.text;
    const fetching = r.fetching ?? this.start(sessionID, r);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([fetching, new Promise<void>(resolve => { timer = setTimeout(resolve, this.deadline); })]);
    clearTimeout(timer);
    return this.roots.get(sessionID) === r ? r.text : undefined;
  }
  private start(sessionID: string, r: Root): Promise<void> {
    const run = async () => {
      for (;;) {
        const generation = r.generation;
        try {
          const text = await this.fetch(sessionID, this.closing.signal);
          if (this.roots.get(sessionID) !== r || this.closing.signal.aborted) return;
          r.text = text; r.reported = false;
          if (generation === r.generation) { r.fresh = true; return; }
        } catch (error) {
          if (this.roots.get(sessionID) !== r || this.closing.signal.aborted) return;
          // A transient failure (outage, deadline, rollover) keeps the last text
          // and stops refetching until the next invalidation, so an outage
          // costs one wait per root rather than one per request.
          if (signedOut(error)) r.text = undefined;
          else if (generation === r.generation) r.fresh = true;
          if (!r.reported) { r.reported = true; this.report(sessionID, error); }
          return;
        }
      }
    };
    const fetching = run().catch(() => {}).finally(() => { if (r.fetching === fetching) r.fetching = undefined; });
    r.fetching = fetching;
    return fetching;
  }
}

// The `context` hook's work on one request: grayboard's entry in the system
// prompt (OpenCode's `system[1]`, the session's initial context render) and in any persisted "instructions changed" system message, rebuilt
// around the root's current text. Never rejects.
export async function rewrite(request: Pick<SessionContext, "sessionID" | "system" | "messages">, mcpName: string, instructions: (sessionID: string) => Promise<string | undefined>): Promise<Plan> {
  try {
    const current = await instructions(request.sessionID);
    if (current === undefined) return "none";
    let plan: Plan = "none";
    const apply = (part: { text: string }) => {
      const rebuilt = rebuild(part.text, mcpName, current);
      if (rebuilt.plan === "none") return;
      plan = "replace";
      if (rebuilt.text !== part.text) part.text = rebuilt.text;
    };
    for (const part of request.system) apply(part as { text: string });
    const open = `  <server name="${mcpName}">`;
    for (const message of request.messages) {
      if (message.role !== "system") continue;
      for (const part of message.content) if (part.type === "text" && part.text.includes(open)) apply(part as { text: string });
    }
    return plan;
  } catch { return "none"; }
}
