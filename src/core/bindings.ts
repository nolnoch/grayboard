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

// `fresh`: the name has never existed, so binding it needs create: true.
export type Candidate = { name: string; queued: number; claims: number; where: string | null; suggested?: true; fresh?: true };

/** What a name has waiting, for ranking candidates. */
export type NameStats = { name: string; queued: number; claims: number; last_seen: number; where: string | null };

/**
 * Candidates in offer order: `suggested` (the checkout's default) first, then
 * the most pending work (queued DMs plus held claims), then the most recently
 * used. The caller has already dropped names that aren't free; `suggested` is
 * listed even if it has never been used, when the caller passes it.
 */
export function orderCandidates(pool: NameStats[], suggested: string | null): Candidate[] {
  const work = (s: NameStats) => s.queued + s.claims;
  const rest = pool.filter((s) => s.name !== suggested).sort((a, b) => work(b) - work(a) || b.last_seen - a.last_seen);
  const known = suggested === null ? undefined : pool.find((s) => s.name === suggested);
  const first = suggested === null ? [] : [{ ...(known ?? { name: suggested, queued: 0, claims: 0, where: null, fresh: true as const }), suggested: true as const }];
  return [...first, ...rest].map((s) => ({
    name: s.name, queued: s.queued, claims: s.claims, where: s.where,
    ...("suggested" in s ? { suggested: true as const } : {}),
    ...("fresh" in s ? { fresh: true as const } : {}),
  }));
}

/** At most this many candidates in the unbound instructions: their cost is paid by every unbound session. */
export const MAX_CANDIDATES = 5;

function describe(c: Candidate): string {
  const parts = c.fresh
    ? ["new: bind with create: true"]
    : [`${c.queued} queued DM${c.queued === 1 ? "" : "s"}`, `${c.claims} claim${c.claims === 1 ? "" : "s"}`];
  if (c.where) parts.push(`last in ${c.where}`);
  return `${c.name} (${c.suggested ? "this checkout's default: " : ""}${parts.join(", ")})`;
}

/**
 * The unbound session's instructions: one sentence, `notes` on why it has no
 * name (heldNote, restoreNote, launcherNote), and the candidates.
 */
export function unboundInstruction(candidates: Candidate[], notes: string[] = []): string {
  const why = notes.map((n) => ` ${n}`).join("");
  const list = candidates.length ? ` Candidates (free now): ${candidates.map(describe).join("; ")}.` : "";
  return `This session has no bus name yet.${why} Bind one with bind(name) once you know your task, or don't bind if the task doesn't need the bus.${list} Until then you can read boards, peers and claims; you send and receive nothing.`;
}

/** An explicit name a live session already held at start. */
export function heldNote(name: string, holder: string): string {
  return `BUS_IDENTITY asked for "${name}", but ${holder} holds it, so this session started without a name.`;
}

/** A name record (decision 14) this restart couldn't take back. */
export function restoreNote(name: string, why: string): string {
  return `This grayboard process restarted; the one before it held "${name}", but ${why}, so this one started without a name.`;
}

/**
 * The parent is a launcher (npx, a shell), not the harness: each restart gets
 * a new parent, so the name record never matches it.
 */
export function launcherNote(launcher: string): string {
  return `Its parent process is a launcher (${launcher}), so if this grayboard process restarts, its name won't come back; register grayboard as a direct command to keep it.`;
}

/**
 * bind's result: what changed, then `instructions`, the startup text for the
 * name (instructions are fixed at initialize, so bind's result carries them).
 * `structuredContent` repeats the name and instructions for adapters that put
 * the instructions in the system prompt themselves (pi, opencode), so they
 * never parse the text.
 */
export function bindOk(name: string, previous: string | null, moved: string[], instructions: string[]) {
  const text = [
    previous
      ? `Bound to "${name}" (was "${previous}"); DMs queued to "${previous}" stay for its next holder.`
      : `Bound to "${name}"; the instructions' note that this session has no bus name no longer applies.`,
    ...(moved.length ? [`Your claims moved from "${previous}" to "${name}": ${moved.join(", ")}.`] : []),
    ...instructions,
  ].join(" ");
  return { content: [{ type: "text" as const, text }], structuredContent: { name, instructions } };
}

/** The refusal for a name that has never existed, without create: true. */
export function unknownNameError(name: string, known: string[]): string {
  return `no name "${name}" has ever been used${known.length ? `; closest: ${known.join(", ")}` : ""}. Pass create: true to make a new one.`;
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
