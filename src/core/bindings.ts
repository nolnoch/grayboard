// Session IDs, binding history and the unbound session's text (#182), shared
// by both modes. A session ID names one grayboard mcp process; a name is the
// durable mailbox a session binds to once it knows its task.
import { createHash, randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";
import { DM_INBOX_INSTRUCTION } from "../shared/inbox.ts";
import { BOARD_INSTRUCTIONS } from "./tools.ts";
import { SESSION_ID, crockford13 } from "./session_id.ts";
import { addressParts, type ScopeKind } from "./addresses.ts";
import { CoreError } from "./errors.ts";
import { canSeeBoard, normalizeBoard, type UnboundPeer } from "./boards.ts";

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
 * BUS_SESSION_KEY: an orchestrator minted this session's key, so it knows
 * the ID before the process exists (#284 decision 2). Undefined when unset;
 * throws on a malformed one. Both modes read it here, once.
 */
export function envSessionKey(env: Record<string, string | undefined> = process.env): string | undefined {
  const key = env.BUS_SESSION_KEY;
  if (key !== undefined && !SESSION_KEY.test(key)) throw new Error("BUS_SESSION_KEY must be 64 lowercase hex characters");
  return key;
}

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

/**
 * Session `id` holds `address` from `now`, or from just after its newest
 * other hold when that is later (#284 S1): two binds in one millisecond keep
 * the order they were made in, so the primary is the one bound first. The
 * alias's last_bound_at moves (S12). Call inside the bind's write
 * transaction, for a new hold only: a re-bind of a held alias changes neither.
 */
export function holdAlias(db: Database, address: string, id: string, now = Date.now()): void {
  db.prepare(
    `INSERT INTO alias_holds (address, id, bound_at)
       VALUES (?1, ?2, MAX(?3, COALESCE((SELECT MAX(bound_at) + 1 FROM alias_holds WHERE id = ?2 AND address != ?1), ?3)))
     ON CONFLICT(address) DO UPDATE SET id = excluded.id, bound_at = excluded.bound_at`,
  ).run(address, id, now);
  db.prepare(`UPDATE aliases SET last_bound_at = ? WHERE address = ?`).run(now, address);
}

/** How many aliases one session may hold at once (#284 S1): each is a socket, a registry entry and a drain stream. */
export const MAX_HOLDS = 8;

/** The refusal for a bind past MAX_HOLDS. */
export function tooManyHolds(held: string[]): string {
  return `this session already holds ${held.length} names (${held.join(", ")}); unbind one first`;
}

/** Session `id` no longer holds `address`; a hold another session took since stays. */
export function dropHold(db: Database, address: string, id: string): void {
  db.prepare(`DELETE FROM alias_holds WHERE address = ? AND id = ?`).run(address, id);
}

/** The session holding `address` now, or null. */
export function holderOf(db: Database, address: string): string | null {
  return (db.prepare(`SELECT id FROM alias_holds WHERE address = ?`).get(address) as { id: string } | null)?.id ?? null;
}

/** The aliases session `id` holds, oldest hold first. */
export function holdsOf(db: Database, id: string): string[] {
  return (db.prepare(`SELECT address FROM alias_holds WHERE id = ? ORDER BY bound_at, address`).all(id) as { address: string }[]).map((r) => r.address);
}

/** Session `id`'s address set (#284 S1): the aliases it holds, oldest first, then its ID. */
export function sessionAddresses(db: Database, id: string): string[] {
  return [...holdsOf(db, id), id];
}

/** The address a session sends as by default (#284 S1): its oldest hold, else its ID. */
export function primaryOf(holds: string[], id: string): string {
  return holds[0] ?? id;
}

/**
 * The address a write names with `as` (#284 S3), checked against the
 * caller's `addresses`: a bare name in the caller's own scope (`ownScope`,
 * the server's `email`; null in local mode, whose aliases are bare), or a
 * scope/name or ID as given.
 */
export function actingAs(input: string, addresses: string[], ownScope: string | null): string {
  const p = addressParts(input);
  const address = p?.kind === "bare" && ownScope !== null ? `${ownScope}/${p.name}` : p?.address;
  if (address !== undefined && p?.kind !== "team" && addresses.includes(address)) return address;
  throw new CoreError(`"${input}" isn't one of this session's addresses: ${addresses.join(", ")}`);
}

/**
 * The address a board tool acts as (#284 S3, S14): `as` when given
 * (board_post, claim_take), checked against `asAddresses`; for a board read,
 * post or subscription without it, the first of `addresses` (primary first,
 * the ID last) that can see the board, else the primary, whose refusal
 * stands. Every other tool acts as the primary. Callers resolve it before
 * callBoardTool and pass the args without `as`.
 */
export function boardActor(
  db: Database,
  tool: string,
  args: Record<string, unknown>,
  s: { addresses: string[]; asAddresses: string[]; ownScope: string | null },
): string {
  const primary = s.addresses[0]!;
  if (args.as !== undefined) return actingAs(String(args.as), s.asAddresses, s.ownScope);
  if ((tool !== "board_read" && tool !== "board_post" && tool !== "board_subscribe") || typeof args.board !== "string") return primary;
  let board: string;
  try {
    board = normalizeBoard(args.board);
  } catch {
    return primary;
  }
  return s.addresses.find((h) => canSeeBoard(db, h, board)) ?? primary;
}

/**
 * The address a DM reply goes out as without `as` (#284 S4): the parent's
 * recipient, else its sender, when that is an alias the session holds; null
 * means the primary. The ID is never picked, so a thread that reached the ID
 * before a bind moves onto an alias that outlives the session.
 */
export function replySender(parent: { sender: string; recipient: string }, holds: string[]): string | null {
  return [parent.recipient, parent.sender].find((a) => holds.includes(a)) ?? null;
}

/**
 * The address set a caller acting as `address` reads as (#284 S8), for a
 * request that names one address (HTTP `?as=`, `grayboard claim`): `address`
 * first, then the rest of the address set of the session it is or that holds
 * it, when that session is `principal`'s (null: local mode's one implicit
 * scope), so another principal's session's addresses never join the set.
 */
export function addressSet(db: Database, address: string, principal: string | null): string[] {
  const id = addressParts(address)?.kind === "id" ? address : holderOf(db, address);
  const row = id === null ? undefined : idRow(db, id);
  if (id === null || !row || row.principal !== principal) return [address];
  return [address, ...sessionAddresses(db, id).filter((a) => a !== address)];
}

/**
 * A session acting as `address`, live or in its grace: holding it, or a
 * tools-only session writing as it; with `exceptPrincipal`, only another
 * principal's. An alias in use is exclusive across principals (#284 S8,
 * decided): their binds, writes_as and `?as=` are refused alias_held while
 * it is, and no one deletes it.
 */
export function aliasUser(db: Database, address: string, exceptPrincipal: string | null = null): string | null {
  return (db.prepare(
    `SELECT i.id FROM ids i
      WHERE i.ended_at IS NULL AND (?2 IS NULL OR i.principal IS NOT ?2)
        AND (i.id IN (SELECT id FROM alias_holds WHERE address = ?1) OR i.writes_as = ?1)
      LIMIT 1`,
  ).get(address, exceptPrincipal) as { id: string } | null)?.id ?? null;
}

/**
 * The one alias_held refusal text, wherever an alias in use is refused (a
 * bind, writes_as, `?as=`, a delete): who uses it, then what to do instead.
 */
export function aliasHeldText(address: string, who: string, instead: string): string {
  return `"${address}" is in use by ${who}; ${instead}`;
}

/** A session's `ids` row, as the server checks it. */
export type IdRow = { principal: string | null; ended_at: number | null; place: string | null; writes_as: string | null; viewer: boolean };

export function idRow(db: Database, id: string): IdRow | undefined {
  const r = db.prepare(`SELECT principal, ended_at, place, writes_as, viewer FROM ids WHERE id = ?`).get(id) as (Omit<IdRow, "viewer"> & { viewer: number }) | null;
  return r ? { ...r, viewer: r.viewer === 1 } : undefined;
}

/** The sessions not yet ended (viewers aside), every principal's or one's. */
export function unendedIds(db: Database, principal: string | null = null): string[] {
  return (db.prepare(`SELECT id FROM ids WHERE ended_at IS NULL AND viewer = 0 AND (?1 IS NULL OR principal = ?1)`).all(principal) as { id: string }[]).map((r) => r.id);
}

/** The statuses set on these sessions, by ID. */
export function idStatuses(db: Database, ids: string[]): Map<string, { status: string; status_at: number | null }> {
  const rows = db.prepare(`SELECT id, status, status_at FROM ids WHERE status IS NOT NULL AND id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids)) as { id: string; status: string; status_at: number | null }[];
  return new Map(rows.map(({ id, ...s }) => [id, s]));
}

/** A session acting as an alias: holding it, or a tools-only session writing as it. principal: the session's. */
export type AliasUse = { id: string; principal: string; address: string; scope_kind: ScopeKind; scope_ref: string; held: boolean };

/** The aliases unended sessions act as, every principal's or one's. */
export function aliasUses(db: Database, principal: string | null): AliasUse[] {
  return (db.prepare(
    `SELECT * FROM (
       SELECT h.id, i.principal, a.address, a.scope_kind, a.scope_ref, 1 AS held FROM alias_holds h
         JOIN ids i ON i.id = h.id JOIN aliases a ON a.address = h.address
        WHERE i.ended_at IS NULL AND i.principal IS NOT NULL
       UNION ALL
       SELECT i.id, i.principal, a.address, a.scope_kind, a.scope_ref, 0 FROM ids i JOIN aliases a ON a.address = i.writes_as
        WHERE i.ended_at IS NULL AND i.principal IS NOT NULL)
     WHERE ?1 IS NULL OR principal = ?1`,
  ).all(principal) as (Omit<AliasUse, "held"> & { held: number })[]).map((r) => ({ ...r, held: r.held === 1 }));
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

export const BIND_TOOL = {
  name: "bind",
  _meta: { "anthropic/alwaysLoad": true },
  description:
    "bind(name, create?, meta?): take a bus name for this session once you know its task, or add another; you send as the first you bound, and unbind releases one you're done with. A name that has never existed needs create: true.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "The name: 1-32 chars of a-z 0-9 _ -, specific to the work (eng-142-idle-anim, not fe)." },
      create: { type: "boolean", description: "Optional. true to create a name that has never existed (a guard against typos)." },
      meta: { type: "object", description: 'Optional. One-line labels peers see in peer_list: task, owner, source_board, spec_hash, description; "" clears one.' },
    },
    required: ["name"],
  },
};

export const UNBIND_TOOL = {
  name: "unbind",
  description: "unbind(name): release one of your aliases; its mail and claims stay with it for its next holder.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "A name this session holds." },
    },
    required: ["name"],
  },
};

export const WHOAMI_TOOL = {
  name: "whoami",
  description: "whoami(): your session ID, the aliases you hold (oldest first; you send as the first) and your principal.",
  inputSchema: { type: "object", properties: {} },
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
 * A session with no name (#284 S13): it acts as its ID. One sentence
 * beside its bound instructions, with `notes` on why it has no name and the
 * candidates.
 */
export function unboundInstruction(id: string, candidates: Candidate[], notes: string[] = []): string {
  const why = notes.map((n) => ` ${n}`).join("");
  const list = candidates.length ? ` Candidates (free now): ${candidates.map(describe).join("; ")}.` : "";
  return `This session has no bus name yet, so it acts as its ID: peers reach it at ${id}, and it posts, sends and claims as ${id}.${why} Bind a name with bind(name) once you know your task; what the ID has stays with this session.${list}`;
}

/** An explicit name a live session already held at start. */
export function heldNote(name: string, holder: string): string {
  return `BUS_IDENTITY asked for "${name}", but ${holder} holds it, so this session started without a name.`;
}

/**
 * A name record (decision 14) this restart couldn't take back. `holdsOthers`:
 * it took back another name from the record (#284 S10).
 */
export function restoreNote(name: string, why: string, holdsOthers = false): string {
  return `This grayboard process restarted; the one before it held "${name}", but ${why}, so ${holdsOthers ? "this session doesn't hold it" : "this one started without a name"}.`;
}

/**
 * The parent is a launcher (npx, a shell), not the harness: each restart gets
 * a new parent, so the name record never matches it.
 */
export function launcherNote(launcher: string): string {
  return `Its parent process is a launcher (${launcher}), so if this grayboard process restarts, its name won't come back; register grayboard as a direct command to keep it.`;
}

/**
 * What a session whose primary is `name` is told: at start, or in a bind or
 * unbind result. `general` is everything not about the name, which a session
 * that has bound already has; `modeGeneral` adds a mode's own general
 * sentences. `others` are the session's other holds (#284 S16): one sentence,
 * only when there are any. `named` goes last: variable length, so a client
 * cut loses it, not the fixed text.
 */
export function boundInstructions(name: string, general: boolean, modeGeneral: () => string[], named: string[], others: string[] = []): string[] {
  return [
    `You are identity "${name}" on the grayboard bus, which coordinates between agents.`,
    ...(others.length ? [`You also hold ${quoted(others)}; you send as "${name}".`] : []),
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

/** bind's refusal in a tools-only process. */
export const TOOLS_ONLY_BIND = "this grayboard process is tools-only (BUS_PUSH=off); its name comes from the session that owns delivery";

/** unbind's note on the claims that stay with the name it released (#284 S6, S2). */
export function leftNote(released: string, left: string[]): string[] {
  return left.length ? [`Claims stay with the name they were taken under; these are now "${released}"'s next holder's: ${left.join(", ")}.`] : [];
}

// "a", "b" for a sentence.
function quoted(names: string[]): string {
  return names.map((n) => `"${n}"`).join(", ");
}

/** peer_list's row for a live session with no name. */
export function unboundPeer(sessionId: string, where: string | null, self: boolean, status?: { text: string; age: string }): UnboundPeer {
  return {
    session_id: sessionId,
    unbound: true,
    online: true,
    ...(where ? { where } : {}),
    ...(status ? { status: status.text, status_age: status.age } : {}),
    ...(self ? { self: true } : {}),
  };
}

/**
 * bind's result: what changed, then the startup text for the session's
 * primary (instructions are fixed at initialize, so bind's result carries
 * them). `held` is every hold after the bind, oldest first.
 * `instructions(general)` builds it; the text leaves out the general part,
 * which the model already has (an unbound session's instructions carry it).
 * `structuredContent` carries the full set, name and general alike, for
 * adapters that replace their system-prompt section with it (pi, opencode),
 * so they never parse the text; its `name` is the name bound.
 */
export function bindOk(name: string, held: string[], instructions: (general: boolean) => string[], notes: string[] = []) {
  const text = [
    held.length > 1
      ? `Bound to "${name}"; you hold ${quoted(held)} and send as "${held[0]}".`
      : `Bound to "${name}"; the instructions' note that this session has no bus name no longer applies.`,
    ...notes,
    ...instructions(false),
  ].join(" ");
  return { content: [{ type: "text" as const, text }], structuredContent: { name, instructions: instructions(true) } };
}

/**
 * unbind's result (#284 S2), built like bindOk's: the release, the claims
 * that stay with the alias, the new primary when it changed, then the
 * instructions for the session as it is now (its new primary's, or its ID's
 * with the unbound line). `structuredContent.name` is the primary now.
 */
export function unbindOk(alias: string, primaryBefore: string, primaryAfter: string, left: string[], instructions: (general: boolean) => string[]) {
  const text = [
    `Released "${alias}"; mail to it queues for its next holder.`,
    ...leftNote(alias, left),
    ...(primaryAfter !== primaryBefore ? [`You now send as "${primaryAfter}".`] : []),
    ...instructions(false),
  ].join(" ");
  return { content: [{ type: "text" as const, text }], structuredContent: { name: primaryAfter, instructions: instructions(true) } };
}

/** unbind's answer for a name this session doesn't hold: already released. */
export function notHolding(name: string): string {
  return `not holding "${name}"`;
}

/** The notice for a bind that completed but whose result the agent never saw. */
export function bindMissed(name: string, why: string, result: string): string {
  return `bind("${name}") completed after ${why}. ${result}`;
}

/** The notice for an unbind that completed but whose result the agent never saw. */
export function unbindMissed(name: string, why: string, result: string): string {
  return `unbind("${name}") completed after ${why}. ${result}`;
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
