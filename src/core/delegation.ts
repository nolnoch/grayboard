// Harness-mediated delegation (#184): a `delegate` request asks a launcher
// session — one whose harness can spawn subagents — to run a persona/task on
// one and report back. The request never names a model or reasoning tier:
// the receiving session's harness maps the persona to its own roster. The
// spawned subagent must be able to send and receive on the bus through one
// of three mechanisms (owner ruling, 2026-10-25): its own connection, a
// fabric, or its parent relaying for it — the floor case, viable everywhere.
import type { Database } from "bun:sqlite";

import { CoreError } from "./errors.ts";
import { age, humanHandles, lastSeen, rosterHandles } from "./boards.ts";
import type { ToolDef } from "./tools.ts";

// The launchers on the roster: handles whose live session opted in
// (BUS_LAUNCHER=1, or the hello's launcher flag). Humans can't spawn — a
// bridge holds their identity — and viewers have no handles row.
export function launchers(db: Database): string[] {
  return (db.prepare(`SELECT name FROM handles WHERE launcher = 1 AND (human IS NULL OR human = 0) ORDER BY name`).all() as { name: string }[]).map((r) => r.name);
}

// One session row notes the capability; the next session on the handle
// rewrites it (the row describes the live session, as cwd and status do).
export function setLauncher(db: Database, handle: string, on: boolean): void {
  db.prepare(`UPDATE handles SET launcher = ? WHERE name = ?`).run(on ? 1 : 0, handle);
}

export function isLauncher(db: Database, handle: string): boolean {
  return !!db.prepare(`SELECT launcher FROM handles WHERE name = ? AND launcher = 1 AND (human IS NULL OR human = 0)`).get(handle);
}

const MAX_PERSONA_CHARS = 80;
const MAX_TASK_CHARS = 8000;
const MAX_CONTEXT_CHARS = 4000;

function field(raw: unknown, name: string, max: number): string {
  if (typeof raw !== "string" || !raw.trim()) throw new CoreError(`${name} must be a non-empty string`);
  const v = raw.trim();
  if (v.length > max) throw new CoreError(`${name} is over ${max} chars (${v.length}); brief it and link the rest`);
  return v;
}

function optField(raw: unknown, name: string, max: number): string | undefined {
  return raw === undefined || raw === null ? undefined : field(raw, name, max);
}

// The user's human handle, for the degrade path: local mode's declared human,
// or (on a server, where handles are user@org/name) the caller's own. Only
// one that has connected at least once — a human nobody can reach is no
// fallback. null when there isn't one.
function humanFallbackHandle(db: Database, requester: string): string | null {
  const candidates = requester.includes("/")
    ? [`${requester.split("/").slice(0, -1).join("/")}/human`]
    : humanHandles(db);
  for (const h of candidates) {
    if (h !== requester && lastSeen(db, h) !== null) return h;
  }
  return null;
}

export type Delegation = { to: string; body: string; humanFallback?: true };

// Resolve the launcher and build the payload. Explicit `to` must be a live
// launcher; without one, the first live launcher (by name) takes it —
// rotation across launchers is a follow-up. No live launcher: the request
// surfaces to the requester's human instead (the issue's degrade path), who
// hand-spawns or starts a launcher. Errors name the undo.
export function resolveDelegation(
  db: Database,
  requester: string,
  args: { persona?: unknown; task?: unknown; context?: unknown; to?: unknown },
  online: (handle: string) => boolean,
): Delegation {
  const persona = field(args.persona, "persona", MAX_PERSONA_CHARS);
  const task = field(args.task, "task", MAX_TASK_CHARS);
  const context = optField(args.context, "context", MAX_CONTEXT_CHARS);
  const brief = { requester, persona, task, context };

  if (args.to !== undefined) {
    if (typeof args.to !== "string" || !args.to.trim()) throw new CoreError("to must be a string");
    const to = args.to.trim();
    if (!rosterHandles(db).includes(to)) throw new CoreError(`no agent "${to}" has ever connected; peer_list shows exact handles`);
    if (!isLauncher(db, to)) throw new CoreError(`"${to}" isn't a launcher session (it starts one with BUS_LAUNCHER=1)`);
    if (!online(to)) throw new CoreError(`"${to}" is a launcher but offline; peer_list shows who's live`);
    return { to, body: delegationBody(brief) };
  }

  const live = launchers(db).filter((h) => h !== requester && online(h));
  if (live.length) return { to: live[0]!, body: delegationBody(brief) };

  const human = humanFallbackHandle(db, requester);
  if (human) return { to: human, body: humanFallbackBody(brief), humanFallback: true };
  throw new CoreError("no live launcher session (a session started with BUS_LAUNCHER=1) and no human to fall back to; start one or pass to");
}

// What the launcher session receives. The harness owns the spawn surface: the
// payload asks for a subagent by persona, never a model or reasoning tier by
// name. The bus-capable floor is the owner ruling: the subagent sends and
// receives through its own connection, a fabric, or the launcher relaying for
// it — never by sharing the launcher's push channel (one delivery owner per
// handle).
export function delegationBody(b: { requester: string; persona: string; task: string; context?: string }): string {
  return [
    `[delegation request from ${b.requester}]`,
    `Persona: ${b.persona}`,
    `Task: ${b.task}`,
    b.context ? `\nContext: ${b.context}` : "",
    "",
    `Spawn a subagent with your own harness for this (its roster and reasoning tiers decide how — the request never names a model). Give the subagent the persona and task above, not your session's history.`,
    `The subagent must be able to send and receive on the bus: its own connection, a fabric, or you relaying for it (the floor — you report for it). Never share your push channel with it: one delivery owner per handle. If your harness's subagents can bind their own bus name, they may.`,
    `Reply in this thread with the result (dm_send to ${b.requester}, this message's id as parent_id).`,
  ].filter((s) => s !== "").join("\n");
}

// The degrade path: no launcher is live, so the human hand-spawns or starts
// one. Same brief, addressed to a person.
export function humanFallbackBody(b: { requester: string; persona: string; task: string; context?: string }): string {
  return [
    `[delegation request from ${b.requester} — no launcher session is live]`,
    `Persona: ${b.persona}`,
    `Task: ${b.task}`,
    b.context ? `\nContext: ${b.context}` : "",
    "",
    `No session on this machine is a launcher (a session started with BUS_LAUNCHER=1). Start one, or hand this to a session yourself; ${b.requester} waits for the result in this thread.`,
  ].filter((s) => s !== "").join("\n");
}

// Not alwaysLoad: a session that never delegates pays nothing but its line in
// the tool list. peer_list marks launchers, which is how a caller finds `to`.
export const DELEGATE_TOOL: ToolDef = {
  name: "delegate",
  description:
    "delegate(persona, task, to?, context?): hand work to a launcher session — one whose harness can spawn subagents (peer_list marks them launcher: true). The request names a persona, never a model: the launcher's harness picks the worker. Sent pending; the launcher reports the result in this thread. No live launcher: it goes to your human instead (human_fallback).",
  inputSchema: {
    type: "object",
    properties: {
      persona: { type: "string", description: `The role needed, e.g. "a researcher". At most ${MAX_PERSONA_CHARS} chars.` },
      task: { type: "string", description: `The task brief the subagent starts from. At most ${MAX_TASK_CHARS} chars; link longer material.` },
      to: { type: "string", description: "Optional. A specific launcher's handle. Default: any live launcher." },
      context: { type: "string", description: `Optional. Extra context for the subagent. At most ${MAX_CONTEXT_CHARS} chars.` },
    },
    required: ["persona", "task"],
  },
};

// Only launcher sessions pay this sentence: they're the ones who must act on
// a delegation request when it arrives.
export function launcherInstruction(): string[] {
  return [
    `You're a launcher session (BUS_LAUNCHER=1): when a delegation request arrives by DM, spawn a subagent with your own harness for it (persona, never a model name) and report the result in the requesting thread. The subagent reaches the bus through its own connection, a fabric, or you relaying for it; never share your push channel with it.`,
  ];
}

// The delegate result's note, the same in every mode.
export function delegateNote(delegatedAt: number, now = Date.now()): string {
  return `Delegated ${age(now - delegatedAt)} ago; dm_inbox lists it until the launcher reports in this thread.`;
}
