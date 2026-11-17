import type { SessionContext } from "@opencode/plugin/promise/session";
import { accessExpiry, Refusal } from "./core/model.js";
import { InsufficientScope } from "./core/wire.js";

// OpenCode's native MCP client sends `initialize` without a session ID and keeps
// its instructions for the process, so every session's system prompt carries
// grayboard's session-less unbound text (#531). On each primary request of an
// enrolled root, the plugin's `context` hook rebuilds grayboard's entry in that
// prompt with the root's current server instructions: omp's #441 rewrite. A
// subagent of an enrolled root gets its own: the server's child text (#535).

// A session's current server instructions; `signal` aborts at shutdown.
export type Fetcher = (sessionID: string, signal: AbortSignal) => Promise<string | undefined>;
export type Plan = "none" | "replace";
// `root` is set for a subagent: the root it writes as, whose changes refresh it.
// `abort` stops its fetch once the entry is forgotten.
type Root = { text?: string; fresh: boolean; generation: number; fetching?: Promise<void>; reported: boolean; root?: string; abort: AbortController };

// OpenCode puts no timeout on the hook and a rejected hook fails the step; a
// fetch that outruns this still fills the cache for the next request.
export const DEADLINE_MS = 2_000;
const EXECUTE_LINE = "    Use tools from this server through `execute` under `tools[";

// The lines that open OpenCode's core/mcp-guidance segment: its initial render,
// and each of its "changed" renders that lists entries (@opencode/core 2.1.4,
// src/mcp/instructions.ts).
const MCP_SEGMENT = new Set([
  "<mcp_instructions>",
  "The available MCP server instructions have changed. This list supersedes the previous one.",
  "New MCP server instructions are available in addition to those previously listed:",
  "The following MCP server instructions have changed. Each entry replaces the previously listed server with the same name:",
]);

// The [start, stop) lines of a part's MCP instructions. OpenCode joins its
// instruction sources with a blank line, the code-mode catalog first and MCP
// instructions next, ahead of references, skills and project instruction
// files (#538). The segment holds no blank line: `entries()` indents every
// instruction line, an empty one too. So it runs from the first opening line
// that starts a segment to the next blank line, and a project file or skill
// that quotes a grayboard entry later in the part is never rewritten. The
// search stops at the first project file (core/instructions renders each as
// `Instructions from: <path>`), so a part with no MCP instructions is left
// alone even where a file quotes a whole segment.
function mcpSegment(lines: string[]): [number, number] | undefined {
  let start = -1;
  for (let i = 0; i < lines.length && start < 0; i++) {
    if (i > 0 && lines[i - 1] !== "") continue;
    if (lines[i]!.startsWith("Instructions from: ")) return undefined;
    if (MCP_SEGMENT.has(lines[i]!)) start = i;
  }
  if (start < 0) return undefined;
  const stop = lines.indexOf("", start + 1);
  return [start, stop < 0 ? lines.length : stop];
}

// `text` with every grayboard entry in its MCP instructions rebuilt around
// `current`, exactly as OpenCode's `entries()` writes one: the frame and its
// codemode line kept, each instruction line indented four spaces. That
// indentation is why server text can never write the `  </server>` line that
// closes the frame, or the blank line that ends the segment. An `mcpName`
// naming another server's entry never gets here: enrollment needs that
// entry's grant to carry both Grayboard scopes (binding.ts).
export function rebuild(text: string, mcpName: string, current: string): { plan: Plan; text: string } {
  const open = `  <server name="${mcpName}">`, close = "  </server>";
  const lines = text.split("\n");
  const segment = mcpSegment(lines);
  if (!segment) return { plan: "none", text };
  const [start, stop] = segment;
  const out: string[] = [];
  let plan: Plan = "none";
  for (let i = 0; i < lines.length; i++) {
    const end = i >= start && i < stop && lines[i] === open ? lines.indexOf(close, i + 1) : -1;
    if (end < 0 || end >= stop) { out.push(lines[i]!); continue; }
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

// Each session's last fetched instructions, refetched after `invalidate`, which
// a root passes on to its subagents. One fetch in flight per session; one that
// ends after an invalidation fetches again. The retained adapters' cache is
// hosted-core's `HostedProxy.instructions`/`forget` (adapters/hosted-core/src/proxy.ts),
// which keeps no text after a failure; this one keeps the last text (OpenCode's
// prompt already carries the unbound text, so none is worse than stale, #538).
// The proxy invalidates on a bind/unbind result or `alias_lost`, and
// `RootDelivery`'s sink (adapters/hosted-core/src/root.ts) on a Controller record
// whose state or holds changed; this one does both, through the Controller's
// `bindingChanged` and `watchRoots` (lifecycle.ts), which also watches ownership.
// `signedOut` is the Controller's classification (core/controller.ts) narrowed
// to "drop the text": change one, check the other.
export class RootInstructions {
  private readonly roots = new Map<string, Root>();
  private readonly closing = new AbortController();
  constructor(
    private readonly fetch: Fetcher,
    // A fetch failure, once per session until a fetch for it succeeds; `root`
    // is the subagent's root.
    private readonly report: (sessionID: string, error: unknown, root?: string) => void,
    private readonly deadline = DEADLINE_MS,
  ) {}
  invalidate(sessionID: string) {
    for (const [id, r] of this.roots) if (id === sessionID || r.root === sessionID) { r.fresh = false; r.generation++; }
  }
  // An ended or unenrolled session's entry goes, with its subagents': a fetch
  // still running for one is aborted rather than left beside the next (#538).
  forget(sessionID: string) {
    for (const [id, r] of this.roots) if (id === sessionID || r.root === sessionID) { r.abort.abort(); this.roots.delete(id); }
  }
  close() { this.closing.abort(); this.roots.clear(); }
  // Sessions with an entry, for tests.
  get size() { return this.roots.size; }
  // What the root's next request carries: fresh text, the last fetched (a
  // refetch running, or the last one failed), or none.
  state(sessionID: string): "fresh" | "stale" | "none" {
    const r = this.roots.get(sessionID);
    return r?.text === undefined ? "none" : r.fresh && !r.reported ? "fresh" : "stale";
  }
  // The session's instructions within the deadline: fresh, or the last fetched
  // while a refetch runs. A subagent names its `root`.
  async current(sessionID: string, root?: string): Promise<string | undefined> {
    if (this.closing.signal.aborted) return;
    let r = this.roots.get(sessionID);
    if (r && r.root !== root) { this.forget(sessionID); r = undefined; }
    if (!r) { r = { fresh: false, generation: 0, reported: false, ...(root ? { root } : {}), abort: new AbortController() }; this.roots.set(sessionID, r); }
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
          const text = await this.fetch(sessionID, AbortSignal.any([this.closing.signal, r.abort.signal]));
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
          if (!r.reported) { r.reported = true; this.report(sessionID, error, r.root); }
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
