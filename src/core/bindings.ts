// Session IDs, binding history and the unbound session's text (#182), shared
// by both modes. A session ID names one grayboard mcp process; a name is the
// durable mailbox a session binds to once it knows its task.
import { createHash, randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";
import { DM_INBOX_INSTRUCTION } from "../shared/inbox.ts";
import { normalizeIdentityName } from "../shared/addressing.ts";
import { BOARD_INSTRUCTIONS } from "./tools.ts";
import type { UnboundPeer } from "./boards.ts";

export type BindingEvent = "bound" | "moved" | "released" | "refused";

/**
 * A session's secret (#182 audit 4): 32 random bytes, hex. A server-mode
 * hello carries the key, never the ID, and the server derives the ID from
 * it, so a session ID seen in peer_list or a refusal can't be presented by
 * another connection.
 */
export function mintSessionKey(): string {
  return randomBytes(32).toString("hex");
}

/** A session key's shape: 64 lowercase hex characters. */
export const SESSION_KEY = /^[0-9a-f]{64}$/;

/**
 * This process's session key: BUS_SESSION_KEY when set, so an orchestrator
 * that mints the key knows the session's ID before the process starts
 * (#284), else a fresh one. A malformed BUS_SESSION_KEY throws: startup
 * refuses rather than run under an ID nobody expects.
 */
export function sessionKeyFromEnv(env: Record<string, string | undefined> = process.env): string {
  const key = env.BUS_SESSION_KEY;
  if (key === undefined) return mintSessionKey();
  if (!SESSION_KEY.test(key)) throw new Error("BUS_SESSION_KEY must be 64 lowercase hex characters");
  return key;
}

// Crockford's base32, lowercased: no i, l, o or u, so an ID reads back
// unambiguously. IDs are only ever compared, never decoded.
const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

/** 16 hex characters (64 bits) as 13 Crockford base32 characters. */
export function crockford13(hex16: string): string {
  let n = BigInt(`0x${hex16}`);
  let out = "";
  for (let i = 0; i < 13; i++) {
    out = CROCKFORD[Number(n & 31n)]! + out;
    n >>= 5n;
  }
  return out;
}

/** A session ID's shape: `id:` and 13 Crockford characters. */
export const SESSION_ID = /^id:[0-9abcdefghjkmnpqrstvwxyz]{13}$/;

/** The session ID a key stands for: the first 64 bits of its SHA-256, as an `id:` address. */
export function idAddress(key: string): string {
  return `id:${crockford13(createHash("sha256").update(key).digest("hex").slice(0, 16))}`;
}

// A 1.x session ID: the same 64 bits as 16 hex characters. Binding history
// and name records written before #284 keep it; it is re-encoded on read,
// never rewritten.
const HEX_SESSION_ID = /^[0-9a-f]{16}$/;

/** A session ID in the `id:` form, re-encoding a 1.x one. */
export function asSessionId(s: string): string {
  return HEX_SESSION_ID.test(s) ? `id:${crockford13(s)}` : s;
}

// alias_holds (#284): which session holds each name now, one row per name.
// Local mode takes a hold inside acquire's BEGIN IMMEDIATE, after checking
// the current holder; the server takes one when its hub has settled the
// name's connection, so a hold here replaces whatever row was left.

/** Session `id` holds `address` from `now`. */
export function holdAlias(db: Database, address: string, id: string, now = Date.now()): void {
  db.prepare(
    `INSERT INTO alias_holds (address, id, bound_at) VALUES (?, ?, ?)
     ON CONFLICT(address) DO UPDATE SET id = excluded.id, bound_at = excluded.bound_at`,
  ).run(address, id, now);
}

/** Session `id` no longer holds `address`; a hold another session took since stays. */
export function dropHold(db: Database, address: string, id: string): void {
  db.prepare(`DELETE FROM alias_holds WHERE address = ? AND id = ?`).run(address, id);
}

/** The session holding `address`, or null. */
export function holderOf(db: Database, address: string): string | null {
  return (db.prepare(`SELECT id FROM alias_holds WHERE address = ?`).get(address) as { id: string } | null)?.id ?? null;
}

/** At server start: no connection outlives the server, so no hold is live. */
export function clearHolds(db: Database): void {
  db.prepare(`DELETE FROM alias_holds`).run();
}

/** One binding_events row, or one more repeat on a refusal's row. */
export function logBinding(db: Database, sessionId: string, name: string, event: BindingEvent, detail: string | null = null, at = Date.now()): void {
  // A retry loop refused for the same reason is one row with a count, not a
  // row per attempt (#210).
  if (event === "refused") {
    const last = db.prepare(
      `SELECT id, event, detail, COALESCE(last_at, at) AS seen FROM binding_events WHERE session_id = ? AND name = ? ORDER BY id DESC LIMIT 1`,
    ).get(sessionId, name) as { id: number; event: string; detail: string | null; seen: number } | null;
    if (last?.event === "refused" && last.detail === detail && at - last.seen <= REFUSED_COALESCE_MS) {
      db.prepare(`UPDATE binding_events SET count = COALESCE(count, 1) + 1, last_at = ? WHERE id = ?`).run(at, last.id);
      return;
    }
  }
  db.prepare(`INSERT INTO binding_events (session_id, name, event, at, detail) VALUES (?, ?, ?, ?, ?)`).run(sessionId, name, event, at, detail);
}

/** How long after a refusal an identical one from the same session joins its row. */
export const REFUSED_COALESCE_MS = 60_000;

/** The session ID of the name's latest bound or moved event, or null when it has none. */
function latestBinder(db: Database, name: string): string | null {
  const row = db.prepare(
    `SELECT session_id FROM binding_events WHERE name = ? AND event IN ('bound', 'moved') ORDER BY id DESC LIMIT 1`,
  ).get(name) as { session_id: string } | null;
  return row ? asSessionId(row.session_id) : null;
}

/**
 * Whether `sessionId` holds `name` by the record: the latest bound or moved
 * event for the name is its own. A rebind moves claims from the name it
 * leaves only then (#182 audit 3).
 */
export function lastBoundBy(db: Database, name: string, sessionId: string): boolean {
  return latestBinder(db, name) === sessionId;
}

/** A bind's claim to continue a session on its name, checked against the history. */
export type Continuity = { verified: boolean; detail: string };

/**
 * A hello's claim to continue `session` on `name` (#211): a reconnect of the
 * session itself, or a restart of an earlier one. Honoured only when the
 * name's latest bound or moved event is that session's, so the binding
 * history never records a continuation the bus didn't see. A restart names
 * a public ID, so on the server this shows the history, not descent (#259).
 * An unverified claim's detail names the latest binder, so the row explains
 * its refusal. Call it in the transaction that logs the bind.
 */
export function continuityOf(db: Database, name: string, claim: { reconnect: string } | { restartOf: string }): Continuity {
  const session = "reconnect" in claim ? claim.reconnect : claim.restartOf;
  const latest = latestBinder(db, name);
  if (latest === session) {
    return { verified: true, detail: "reconnect" in claim ? "reconnect" : `restored: restart of session ${session}` };
  }
  const what = "reconnect" in claim ? "reconnect" : `restored_from ${session}`;
  return { verified: false, detail: `${what} not verified: latest bound by ${latest ?? "nobody"}` };
}

/** Whether the name's latest bound, moved or released event is a release. */
export function lastWasRelease(db: Database, name: string): boolean {
  const row = db.prepare(
    `SELECT event FROM binding_events WHERE name = ? AND event IN ('bound', 'moved', 'released') ORDER BY id DESC LIMIT 1`,
  ).get(name) as { event: string } | null;
  return row?.event === "released";
}

export const UNBOUND_ERROR =
  "no bus name yet. Call bind(name) to resume a name (see the candidates in your instructions, or peer_list), or bind(name, create: true) for a new one.";

/** The reads that need no name: what a server lets a read-only connection call. */
export const UNBOUND_READS = new Set(["board_list", "board_read", "peer_list", "claim_list"]);
/** What an unbound session may call: those reads, and bind (which never reaches a server as a call). */
export const UNBOUND_TOOLS = new Set(["bind", ...UNBOUND_READS]);

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
 * What a session bound to `name` is told: at start, or in bind's result.
 * `general` is everything not about the name, which a rebind already has;
 * `modeGeneral` adds a mode's own general sentences. `named` goes last:
 * variable length, so a client cut loses it, not the fixed text.
 */
export function boundInstructions(name: string, general: boolean, modeGeneral: () => string[], named: string[]): string[] {
  return [
    `You are identity "${name}" on the grayboard bus, which coordinates between agents.`,
    ...(general
      ? [
          `Direct messages arrive as <channel source="grayboard" message_id="..." from="..." [parent_id="..."]>body</channel>; reply with dm_send(to=from, body, parent_id=message_id).`,
          DM_INBOX_INSTRUCTION,
          ...BOARD_INSTRUCTIONS,
          ...modeGeneral(),
          `Messages are durable: if the peer is offline they'll receive it when their session starts.`,
        ]
      : []),
    ...named,
  ];
}

type TextResult = { content: { type: "text"; text: string }[]; isError?: true };

/**
 * bind's checks before either mode acquires anything: the name to bind, or
 * the call's result (a refusal, or "already bound").
 */
export function bindTarget(a: Record<string, unknown>, bound: string | null, push: boolean): { name: string } | { result: TextResult } {
  const fail = (why: string): { result: TextResult } => ({ result: { content: [{ type: "text", text: `error: ${why}` }], isError: true } });
  if (!push) return fail("this grayboard process is tools-only (BUS_PUSH=off); its name comes from the session that owns delivery");
  const n = normalizeIdentityName(String(a.name));
  if (!n.ok) return fail(n.error);
  if (n.name === bound) return { result: { content: [{ type: "text", text: `already bound to "${n.name}"` }] } };
  return { name: n.name };
}

/** peer_list's row for a live session with no name. */
export function unboundPeer(sessionId: string, where: string | null, self: boolean): UnboundPeer {
  return { session_id: sessionId, unbound: true, online: true, ...(where ? { where } : {}), ...(self ? { self: true } : {}) };
}

/**
 * bind's result: what changed, then the startup text for the name
 * (instructions are fixed at initialize, so bind's result carries them).
 * `instructions(general)` builds it; the text leaves out the general part on
 * a rebind, which the model already has. `structuredContent` carries the full
 * set, name and general alike, for adapters that replace their system-prompt
 * section with it (pi, opencode), so they never parse the text.
 */
export function bindOk(name: string, previous: string | null, moved: string[], instructions: (general: boolean) => string[], notes: string[] = []) {
  const text = [
    previous
      ? `Bound to "${name}" (was "${previous}"); DMs queued to "${previous}" stay for its next holder.`
      : `Bound to "${name}"; the instructions' note that this session has no bus name no longer applies.`,
    ...(moved.length ? [`Your claims moved from "${previous}" to "${name}": ${moved.join(", ")}.`] : []),
    ...notes,
    ...instructions(previous === null),
  ].join(" ");
  return { content: [{ type: "text" as const, text }], structuredContent: { name, instructions: instructions(true) } };
}

/**
 * bind's warning against a server from before #182 (its hello_ok has no
 * `moved`): it creates any name it's given and moves no claims.
 */
export function oldServerBindNote(previous: string | null): string {
  return `This server predates name binding: it created the name if it was new (check the spelling), ${previous ? `left your claims on "${previous}", ` : ""}and recorded nothing; ask your user to update it.`;
}

/** The notice for a bind that completed but whose result the agent never saw. */
export function bindMissed(name: string, why: string, result: string): string {
  return `bind("${name}") completed after ${why}. ${result}`;
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
