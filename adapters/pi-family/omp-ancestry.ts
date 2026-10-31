// Which top-level session an omp subagent belongs to (#280). omp runs task
// subagents in-process, each with its own extension runtime and `ctx.agent`
// ({ id, kind, parentId }), so every runtime records its session here under
// its agent id and a subagent finds its root by walking parentIds.
//
// Entries are never removed: omp keeps a finished subagent revivable for its
// idle TTL, and a nested one revived after its parent's run ended still has
// to reach the root. A main session's entry is overwritten when it starts a
// new session (/new, /resume, /fork), so a revived subagent registers under
// the root that is live now.

export type Agent = { raw: string; main: boolean; parent?: string };

// One map per process, shared by every runtime's copy of the bundle.
const KEY = Symbol.for("io.github.nolnoch.grayboard/omp-agents");
export const registry: Map<string, Agent> = ((globalThis as Record<symbol, unknown>)[KEY] ??= new Map()) as Map<string, Agent>;

// The root session reached from `parentId`, and the subagent sessions between
// (outermost first); undefined when the chain doesn't reach a main session
// (an unknown parent, or a cycle).
export function rootOf(agents: Map<string, Agent>, parentId: string | undefined): { root: string; via: string[] } | undefined {
  const via: string[] = [];
  let id = parentId;
  for (let hops = 0; id !== undefined && hops < agents.size; hops++) {
    const agent = agents.get(id);
    if (!agent) return undefined;
    if (agent.main) return { root: agent.raw, via };
    via.unshift(agent.raw);
    id = agent.parent;
  }
  return undefined;
}
