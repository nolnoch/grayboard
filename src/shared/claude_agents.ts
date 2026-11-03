// Claude Code's subagents as child sessions (#551): the hook-joined record.
//
// Claude Code tells a third-party MCP server only `_meta["claudecode/toolUseId"]`
// on a tool call; which agent made it reaches only hooks. So a PreToolUse hook
// writes one record per grayboard call, named by the call's tool_use_id, holding
// the subagent's agent_id or ROOT for a main-agent call, and the MCP side (local
// `grayboard mcp`, the hosted plugin) takes the record that names its call.
//
// Layout, under a base directory (the local socket dir, or the plugin's
// CLAUDE_PLUGIN_DATA): `claude-agents/<CLAUDE_PID>/`
//   start                 procStart(CLAUDE_PID), written by SessionStart: a reader
//                         whose harness started at another time sees a recycled pid
//   <tool_use_id>         a record: the agent id, or ROOT
//   <id>.taken.<pid>      a record a reader claimed (rename is the atomic take)
//   ended/<name>          hosted only: an agent id whose SubagentStop ran
//   model, effort         hosted only: the root session's latest model and
//                         effort (#545), each written whole by one hook event
//
// Records and facts are harness-asserted, in a same-user directory. A forged
// record can only attribute a call to a child of the same root (docs/boards.md
// §3). Any same-user process can write any session's facts, so a forged fact
// misreports that session's display model or effort: facts grant nothing, and
// it is the records' boundary and #229's.
//
// Facts (#545, measured on Claude Code 2.1.316): SessionStart's `model` and
// PostModelSwitch's `to_model` (after the user confirms a switch; PreModelSwitch
// runs before that dialog) are the model, a full ID (`claude-opus-5-5`;
// `to_model` is the ID as given to /model); the root's grayboard PreToolUse
// `effort.level` is the effort, absent on a model without one, so that call and
// a model switch remove the effort file. SessionStart carries no effort. No
// payload names a subagent's model, so a child session reports none.
//
// Imports nothing heavy: the local hook entry (src/cli/main.ts) loads this
// module alone, so a hook costs a process start and a few file operations.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { procStart, procStarts } from "./proc.ts";
import { SESSION_FACT_MAX } from "./protocol.ts";
import { validSourceId } from "./session_meta.ts";

/** A main-agent call's record. */
export const ROOT = "-";
/**
 * A leftover take or temporary older than this is pruned. A record itself has
 * no age limit: Claude Code runs PreToolUse before its permission prompt, so a
 * call may reach the server any time after its record was written, and a
 * tool_use_id is never reused (#553 audit 1).
 */
export const LEFTOVER_TTL_MS = 10 * 60_000;
/** Records, and SubagentStop markers, kept per session; the hook drops the oldest past it. */
export const RECORD_CAP = 256;
/** The `_meta` key Claude Code puts the call's tool_use_id under. */
export const TOOL_USE_META = "claudecode/toolUseId";

const TOOL_USE_ID = /^toolu_[A-Za-z0-9_]{1,128}$/;
export const validToolUseId = (id: unknown): id is string => typeof id === "string" && TOOL_USE_ID.test(id);

export const agentsRoot = (base: string) => join(base, "claude-agents");
export const sessionDir = (base: string, claudePid: number) => join(agentsRoot(base), String(claudePid));

export type HookEvent = "session-start" | "pre-tool-use" | "model-switch" | "subagent-stop" | "session-end";
export const HOOK_EVENTS: readonly HookEvent[] = ["session-start", "pre-tool-use", "model-switch", "subagent-stop", "session-end"];

/** The root's facts, one file each. */
export const FACTS = ["model", "effort"] as const;
export type Fact = (typeof FACTS)[number];
// A model id or effort level: printable ASCII without spaces, as Claude Code's
// are (`claude-opus-5-5`, `claude-opus-5-5[1m]`, `high`), no longer than the
// server keeps, so what it shows is what the hook wrote.
const FACT = new RegExp(`^[\\x21-\\x7e]{1,${SESSION_FACT_MAX}}$`);
export const validFact = (v: unknown): v is string => typeof v === "string" && FACT.test(v);

// Writes a fact Claude Code reported; a malformed one writes nothing.
function putFact(dir: string, fact: Fact, value: unknown) {
  if (!validFact(value)) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  put(join(dir, fact), value);
}

const dropFact = (dir: string, fact: Fact) => rmSync(join(dir, fact), { force: true });

// Write through a temporary name, so a reader never sees a partial file.
function put(path: string, text: string) {
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

function ageMs(path: string, now: number): number | undefined {
  try { return now - statSync(path).mtimeMs; } catch { return undefined; }
}

/**
 * One hook event. Never throws and prints nothing: a hook must never block or
 * alter a call; a record it failed to write surfaces as the reader's
 * missing-record error. `hosted` (the plugin's hook) also writes SubagentStop's
 * marker and the root's facts, which only the hosted plugin reads.
 */
export function runHook(event: string, stdin: string, o: { base: string; env: Record<string, string | undefined>; hosted: boolean; now?: number }): void {
  try {
    const pid = Number(o.env.CLAUDE_PID);
    if (!Number.isSafeInteger(pid) || pid <= 1) return;
    const input = JSON.parse(stdin) as Record<string, unknown>;
    const dir = sessionDir(o.base, pid);
    const now = o.now ?? Date.now();
    if (event === "session-start") {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const start = procStart(pid);
      // An unreadable start time is recorded empty: the reader then can't tell a
      // recycled pid, and treats the dir as its harness's (proc.ts's rule).
      put(join(dir, "start"), start ?? "");
      if (o.hosted) putFact(dir, "model", input.model);
      pruneSessions(o.base, pid);
    } else if (event === "pre-tool-use") {
      const id = input.tool_use_id;
      if (!validToolUseId(id)) return;
      const agent = input.agent_id;
      const content = agent === undefined ? ROOT : validSourceId(agent) && agent !== ROOT ? agent : undefined;
      if (content === undefined) return;
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      put(join(dir, id), content);
      pruneRecords(dir, now);
      // The root's effort, which the call this record names carries.
      // None means the model has no effort level, so the old one goes.
      if (o.hosted && content === ROOT) {
        const level = (input.effort as { level?: unknown } | undefined)?.level;
        if (level === undefined) dropFact(dir, "effort");
        else putFact(dir, "effort", level);
      }
    } else if (event === "model-switch") {
      // The new model's effort shows at the root's next grayboard call.
      if (o.hosted && validFact(input.to_model)) {
        putFact(dir, "model", input.to_model);
        dropFact(dir, "effort");
      }
    } else if (event === "subagent-stop") {
      if (!o.hosted) return;
      const agent = input.agent_id;
      if (!validSourceId(agent) || agent === ROOT) return;
      const ended = join(dir, "ended");
      mkdirSync(ended, { recursive: true, mode: 0o700 });
      put(join(ended, `${now}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`), agent);
      pruneEnded(ended);
    } else if (event === "session-end") {
      // The MCP process outlives a /clear, and so do its records.
      if (input.reason === "clear") return;
      rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // Said by the reader's missing-record error, never here.
  }
}

// Past the cap, the oldest records go; a take (or a temporary) older than
// LEFTOVER_TTL_MS was left by a process that died between its rename and its unlink.
function pruneRecords(dir: string, now: number) {
  const records: { name: string; mtime: number }[] = [];
  for (const name of readdirSync(dir)) {
    if (name.includes(".taken.") || name.includes(".tmp.")) {
      const age = ageMs(join(dir, name), now);
      if (age !== undefined && age > LEFTOVER_TTL_MS) rmSync(join(dir, name), { force: true });
    } else if (validToolUseId(name)) {
      const age = ageMs(join(dir, name), now);
      if (age !== undefined) records.push({ name, mtime: now - age });
    }
  }
  if (records.length <= RECORD_CAP) return;
  records.sort((a, b) => a.mtime - b.mtime);
  for (const r of records.slice(0, records.length - RECORD_CAP)) rmSync(join(dir, r.name), { force: true });
}

// Past the cap, the oldest SubagentStop markers go: one is written for every
// subagent, and only a session whose subagents call grayboard drains them.
// Names start with the write time, so name order is age order within a ms.
function pruneEnded(dir: string) {
  const markers = readdirSync(dir).filter(n => !n.includes(".tmp.") && !n.includes(".taken."));
  if (markers.length <= RECORD_CAP) return;
  markers.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  for (const name of markers.slice(0, markers.length - RECORD_CAP)) rmSync(join(dir, name), { force: true });
}

// Sibling session dirs whose pid no longer names the process that wrote them:
// a session that ended without SessionEnd (killed, crashed). One start-time
// read for all of them.
function pruneSessions(base: string, self: number) {
  const root = agentsRoot(base);
  const dirs = readdirSync(root).map(Number).filter(p => Number.isSafeInteger(p) && p > 1 && p !== self);
  if (!dirs.length) return;
  const starts = procStarts(dirs);
  for (const pid of dirs) {
    const now = starts.get(pid);
    let recorded: string | undefined;
    try { recorded = readFileSync(join(root, String(pid), "start"), "utf8"); } catch { recorded = undefined; }
    // Gone, or alive under another start time: a recycled pid. Unknown either way keeps it.
    const dead = !starts.has(pid) || (now !== null && now !== undefined && recorded !== undefined && recorded !== "" && recorded !== now);
    if (dead) rmSync(join(root, String(pid)), { recursive: true, force: true });
  }
}

/** Why a call has no usable record. */
export type MissingCause = "bad_tool_use_id" | "no_session" | "recycled_pid" | "absent" | "bad_record";
export type Taken = { agent: string | null } | { missing: MissingCause };

export const MISSING_TEXT: Record<MissingCause, string> = {
  bad_tool_use_id: "the call's tool_use_id isn't one Claude Code makes",
  no_session: "no SessionStart record for this Claude Code process (its grayboard hooks didn't run)",
  recycled_pid: "the record directory belongs to an earlier process with the same pid",
  absent: "the grayboard PreToolUse hook wrote no record for this call",
  bad_record: "the call's record isn't an agent id",
};

/**
 * Takes the record for `toolUseId` in `claudePid`'s dir: the agent id, null for
 * a main-agent call, or why there is none. `harnessStart` is the start time the
 * reader holds for that pid (null when unknown, which accepts any `start`).
 * The take is a rename, so of two concurrent readers exactly one gets it.
 */
export function takeRecord(base: string, claudePid: number, harnessStart: string | null, toolUseId: unknown): Taken {
  if (!validToolUseId(toolUseId)) return { missing: "bad_tool_use_id" };
  const dir = sessionDir(base, claudePid);
  let start: string;
  try { start = readFileSync(join(dir, "start"), "utf8"); } catch { return { missing: "no_session" }; }
  if (harnessStart !== null && start !== "" && start !== harnessStart) return { missing: "recycled_pid" };
  const taken = join(dir, `${toolUseId}.taken.${process.pid}`);
  try { renameSync(join(dir, toolUseId), taken); } catch { return { missing: "absent" }; }
  try {
    const content = readFileSync(taken, "utf8");
    if (content === ROOT) return { agent: null };
    return validSourceId(content) ? { agent: content } : { missing: "bad_record" };
  } catch {
    return { missing: "absent" };
  } finally {
    try { unlinkSync(taken); } catch { /* pruned by the hook's next write */ }
  }
}

/**
 * The root's latest facts in `claudePid`'s dir, read whole per request: none
 * without a SessionStart record or for a recycled pid's dir, and only the
 * facts a hook wrote. A fact file that can't be read or isn't one is left out
 * and passed to `bad` (the caller says it), so the other fact still goes.
 */
export function readFacts(base: string, claudePid: number, harnessStart: string | null, bad: (fact: Fact, error: string) => void): { model?: string; effort?: string } | undefined {
  const dir = sessionDir(base, claudePid);
  let start: string;
  try { start = readFileSync(join(dir, "start"), "utf8"); } catch { return undefined; }
  if (harnessStart !== null && start !== "" && start !== harnessStart) return undefined;
  const out: { model?: string; effort?: string } = {};
  for (const fact of FACTS) {
    let value: string;
    try { value = readFileSync(join(dir, fact), "utf8"); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") bad(fact, `couldn't read ${join(dir, fact)}: ${(e as Error).message}`);
      continue;
    }
    if (validFact(value)) out[fact] = value;
    else bad(fact, `${join(dir, fact)} isn't a Claude Code ${fact}`);
  }
  return out;
}

/** The agent ids whose SubagentStop ran since the last call, each consumed once. */
export function takeEnded(base: string, claudePid: number): string[] {
  const dir = join(sessionDir(base, claudePid), "ended");
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const out: string[] = [];
  for (const name of names) {
    if (name.includes(".tmp.") || name.includes(".taken.")) continue;
    const taken = join(dir, `${name}.taken.${process.pid}`);
    try { renameSync(join(dir, name), taken); } catch { continue; }
    try {
      const agent = readFileSync(taken, "utf8");
      if (validSourceId(agent) && agent !== ROOT) out.push(agent);
    } catch { /* a marker we can't read ends nothing */ }
    finally { try { unlinkSync(taken); } catch { /* gone */ } }
  }
  return out;
}
