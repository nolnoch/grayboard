// Session IDs, binding history and the unbound session's text (#182), shared
// by both modes. A session ID names one grayboard mcp process; a name is the
// durable mailbox a session binds to once it knows its task.
import type { Database } from "bun:sqlite";

export type BindingEvent = "bound" | "moved" | "released" | "refused";

/** 16 random hex characters, minted once per process and never reused. Not an address. */
export function mintSessionId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Buffer.from(b).toString("hex");
}

/** One binding_events row. */
export function logBinding(db: Database, sessionId: string, name: string, event: BindingEvent, detail: string | null = null, at = Date.now()): void {
  db.prepare(`INSERT INTO binding_events (session_id, name, event, at, detail) VALUES (?, ?, ?, ?, ?)`).run(sessionId, name, event, at, detail);
}

export const UNBOUND_ERROR =
  "no bus name yet. Call bind(name) to resume a name (see the candidates in your instructions, or peer_list), or bind(name, create: true) for a new one.";

/** What an unbound session may call: reads that need no name. */
export const UNBOUND_TOOLS = new Set(["bind", "board_list", "board_read", "peer_list", "claim_list"]);

export const BIND_TOOL = {
  name: "bind",
  _meta: { "anthropic/alwaysLoad": true },
  description:
    "bind(name, create?): take a bus name for this session once you know its task, or switch to another. Your claims move with you; DMs queued to the old name stay for its next holder. A name that has never existed needs create: true.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "The name: 1-32 chars of a-z 0-9 _ -, specific to the work (eng-142-idle-anim, not fe)." },
      create: { type: "boolean", description: "Optional. true to create a name that has never existed (a guard against typos)." },
    },
    required: ["name"],
  },
};

export type Candidate = { name: string; queued: number; claims: number; where: string | null; suggested?: true };

/** At most this many candidates in the unbound instructions: their cost is paid by every unbound session. */
export const MAX_CANDIDATES = 5;

function describe(c: Candidate): string {
  const parts = [`${c.queued} queued DM${c.queued === 1 ? "" : "s"}`, `${c.claims} claim${c.claims === 1 ? "" : "s"}`];
  if (c.where) parts.push(`last in ${c.where}`);
  return `${c.name} (${c.suggested ? "this checkout's default: " : ""}${parts.join(", ")})`;
}

/**
 * The unbound session's instructions: one sentence and the candidates.
 * `held` names the explicit name this session was started with and its
 * holder, when a live session already has it.
 */
export function unboundInstruction(candidates: Candidate[], held?: { name: string; holder: string }): string {
  const heldNote = held ? ` BUS_IDENTITY asked for "${held.name}", but ${held.holder} holds it, so this session started without a name.` : "";
  const list = candidates.length ? ` Candidates (free now): ${candidates.map(describe).join("; ")}.` : "";
  return `This session has no bus name yet.${heldNote} Bind one with bind(name) once you know your task, or don't bind if the task doesn't need the bus.${list} Until then you can read boards, peers and claims; you send and receive nothing.`;
}

/** Edit distance, for "did you mean" on a name that has never existed. */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length]!;
}

/** The `limit` names closest to `name`, nearest first. */
export function closestNames(name: string, known: string[], limit = 5): string[] {
  return known
    .map((k) => ({ k, d: distance(name, k) }))
    .sort((x, y) => x.d - y.d || x.k.localeCompare(y.k))
    .slice(0, limit)
    .map((x) => x.k);
}
