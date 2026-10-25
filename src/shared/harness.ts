// Harness self-identification (#245): which coding agent this session runs
// under, and how its subagents reach the bus. Facts the session reports so
// delegation routing can prefer a launcher whose subagents reach the bus
// natively over one that can only relay (#184's owner ruling).
//
// Detection is env-based, from each harness's documented markers (the #184
// research, ~/llm/grayboard/delegation-research/): no single marker is
// authoritative, so an explicit BUS_HARNESS overrides everything and an
// unrecognized environment reports null rather than guessing.

// How a spawned subagent reaches the bus (#184 owner ruling):
// - native: the subagent holds its own bus connection (pi background
//   children, Claude Code MCP inheritance, OpenCode per-process sessions)
// - fabric: a proxy layer carries its traffic (@cursor/sdk's own-MCP spawns)
// - relay: the launcher speaks for it (the floor case, viable everywhere)
export type CommsMechanism = "native" | "fabric" | "relay";
export const COMMS_MECHANISMS: readonly CommsMechanism[] = ["native", "fabric", "relay"];

// Higher wins the auto-pick: a launcher whose subagents reach the bus on
// their own is a better target than one that can only relay. Unknown values
// rank as relay.
export function commsRank(comms: string | null | undefined): number {
  switch (comms) {
    case "native": return 2;
    case "fabric": return 1;
    default: return 0;
  }
}

// The env markers each harness sets, probed in order of reliability. The
// first match wins; BUS_HARNESS overrides all of them.
// `env` is required: callers pass process.env (tests pass their own), so
// this module has no runtime globals.
export function detectHarness(env: Record<string, string | undefined>): string | null {
  const explicit = env.BUS_HARNESS?.trim();
  if (explicit) return explicit.slice(0, 40);
  // Claude Code sets CLAUDECODE=1 in every subprocess it spawns.
  if (env.CLAUDECODE === "1") return "claude-code";
  // OpenCode: config env or dir (OPENCODE=1 inside its shells is unverified).
  if (env.OPENCODE_CONFIG || env.OPENCODE_CONFIG_DIR) return "opencode";
  // pi: its agent dir (set for children it spawns; the default dir is
  // deliberately not a marker — too many false positives).
  if (env.PI_CODING_AGENT_DIR) return "pi";
  // Cursor: env vars are documented but which reach spawned subprocesses is
  // unverified, so only the worker marker counts.
  if (env.CURSOR_AGENT_WORKER_ID) return "cursor";
  return null;
}

// The comms mechanism a harness's subagents use by default, from the #184
// research; BUS_COMMS overrides (e.g. a Cursor CLI user overriding the
// in-editor relay default). Unknown harnesses report the floor.
export function defaultComms(harness: string | null, env: Record<string, string | undefined>): CommsMechanism {
  const explicit = env.BUS_COMMS?.trim() as CommsMechanism | undefined;
  if (explicit && COMMS_MECHANISMS.includes(explicit)) return explicit;
  switch (harness) {
    case "claude-code":
    case "pi":
    case "opencode": return "native";
    default: return "relay";
  }
}

export function isCommsMechanism(v: unknown): v is CommsMechanism {
  return typeof v === "string" && COMMS_MECHANISMS.includes(v as CommsMechanism);
}
