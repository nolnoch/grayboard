// The bindings store's group interface (#807 P3 C10a-a, docs/future/postgres-server.md D2): holds (alias_holds), the
// sessions' ids rows, binding events and presence, which Repo (db.ts) composes and the Postgres store (pg/, C10a-b)
// implements. Type-only imports, so a module under pg/ may import it (pg/isolation.test.ts); db.ts re-exports
// AliasMetaDiff and BindingsStore.
// The SQLite store delegates to core (core/bindings.ts, core/boards.ts); bindings.contract.ts pins each method's serial
// answer on both stores.
import type { AliasUse, BindingEvent, IdRow } from "../../core/bindings.ts";
import type { AliasMetaDiff, AliasMetaSet, IdFacts, IdSessionFacts, ReusedId, UnboundFacts } from "../../core/boards.ts";
import type { Read, Tx } from "./tx_base.ts";

export type { AliasMetaDiff, AliasMetaSet, AliasUse, BindingEvent, IdFacts, IdRow, IdSessionFacts, ReusedId, UnboundFacts };

// Every read returns a promise on the caller's handle (#807 P3 B1a), and every write runs on the caller's Tx (B1c); a
// settled Tx is refused. A Read sees committed state; a body's Tx sees its own writes.
export interface BindingsStore {
  // The aliases a session holds, oldest hold first: by bound_at, then address (HOLD_ORDER), never insertion order.
  holdsOf(r: Read, id: string): Promise<string[]>;
  // holdsOf for each of ids in one statement; an ID that holds nothing maps to [].
  holdsOfMany(r: Read, ids: string[]): Promise<Map<string, string[]>>;
  // The session holding an address now, or null.
  holderOf(r: Read, address: string): Promise<string | null>;
  // holderOf for each of addresses in one statement; a free address is absent.
  holdersOf(r: Read, addresses: string[]): Promise<Map<string, string>>;
  // An unended session acting as an address (core aliasUser): holding it, or a tools-only session writing as it
  // (writes_as); with exceptPrincipal, only another principal's (a null principal counts as another). One answer
  // whatever the plan: the holder before a writer, then the earliest started_at, then the earliest registered (the
  // insertion order of ids rows: SQLite rowid, Postgres ids.seq).
  userOf(r: Read, address: string, exceptPrincipal?: string | null): Promise<string | null>;
  // The address set a caller acting as address reads as (core addressSet): address first, then the rest of the
  // holding (or named) session's addresses, holds in HOLD_ORDER then its ID, when that session is principal's;
  // [address] alone otherwise, and always for a null principal.
  addressSet(r: Read, address: string, principal: string | null): Promise<string[]>;
  // The session's row as the server checks it; viewer is a boolean on every store. Undefined: no row.
  idRow(r: Read, id: string): Promise<IdRow | undefined>;
  // The sessions not yet ended, viewers aside; any order.
  unendedIds(r: Read): Promise<string[]>;
  // The statuses set on these sessions; an ID with no status (or no row) is absent.
  idStatuses(r: Read, ids: string[]): Promise<Map<string, { status: string; status_at: number | null }>>;
  // The aliases unended sessions with a principal act as (held, or written as with held false), every principal's
  // (null) or one's; any order.
  aliasUses(r: Read, principal: string | null): Promise<AliasUse[]>;
  // When each handle (an alias or a session ID) was last seen; a repeat once, one never seen (or with no row) absent.
  lastSeen(r: Read, handles: string[]): Promise<Map<string, number>>;
  // Holds address for id (D3): null, writing nothing, when another session holds it or another principal's
  // session acts as it (userOf with exceptPrincipal = principal). A same-ID re-take moves its bound_at. bound_at
  // stays after the ID's other holds, so two takes in one millisecond keep their order (HOLD_ORDER). The check and
  // the upsert are one method, so a store whose transactions interleave locks the alias row first (C10a-b). A re-take
  // at or before its own bound_at stamps now (only the ID's other holds bound it), even moving the stamp back. A take
  // by an ended ID is not pinned: SQLite writes the hold; Postgres (C10a-b, E4) returns null. Nor is a take with no
  // alias row or no ids row: SQLite writes the hold, Postgres returns null; neither is reachable today, since the one
  // caller (application.ts bind) creates the alias and checks the session live just before it takes.
  take(tx: Tx, address: string, id: string, principal: string, now: number): Promise<{ bound_at: number } | null>;
  // Drops id's hold on address; a hold another session took since stays.
  release(tx: Tx, address: string, id: string): Promise<void>;
  // A binding_events row at `at` (the wall clock when absent, core logBinding's default). A refusal repeating the
  // session's last row for the name (same detail, within REFUSED_COALESCE_MS of its last stamp) is one row with a
  // count and last_at, not a new row.
  log(tx: Tx, id: string, name: string, event: BindingEvent, detail?: string | null, at?: number): Promise<void>;
  // Moves the alias's last_seen (to the wall clock when now is absent); an address that isn't an alias is left alone.
  touchAlias(tx: Tx, address: string, now?: number): Promise<void>;
  // Moves the session's last_seen (to the wall clock when now is absent).
  touchId(tx: Tx, id: string, now?: number): Promise<void>;
  // A new session's ids row from facts (core registerId: harness, model and effort cleaned, place cleaned; delivery
  // 'none' for a writer or a child, else 'push'; started_at and last_seen stamped now). Rejects with IdCollision,
  // carrying the existing row's ended_at, when the ID has a row, writing nothing. An ID's tombstone (only keyed IDs
  // leave one, at prune) is consumed and returned (ReusedId) whether or not this registration is keyed, for the
  // caller to audit as id.reused; null otherwise. A child (rootId) of an ended root is not pinned: SQLite registers
  // it; Postgres (C10a-b, E3) refuses it, and refuses an existing ID under an ended root with id_ended before
  // IdCollision; neither is reachable today, since the one caller (application.ts) registers only an ID with no row,
  // and never a child.
  registerId(tx: Tx, facts: IdFacts): Promise<ReusedId | null>;
  // Sets the named facts (undefined leaves one alone), cleaned; the before and after of both when either changed,
  // null when nothing did (no write) or there's no such ID.
  setIdFacts(tx: Tx, id: string, facts: { model?: string | null; effort?: string | null }): Promise<{ before: IdSessionFacts; after: IdSessionFacts } | null>;
  // The session's place, cleaned (null clears it).
  setPlace(tx: Tx, id: string, place: string | null): Promise<void>;
  // Writes an alias's labels (#284 S12) from a parsed meta, only the fields whose value changes (a null clears one).
  // Returns each changed key's value before and after, or null when nothing changed (no write); rejects when the
  // alias has no row. The caller audits the diff on the same Tx (alias.meta_set; application.ts setAliasLabels): the
  // store never writes audit rows here (#807 P3 C10a Q3).
  setMeta(tx: Tx, address: string, meta: AliasMetaSet): Promise<AliasMetaDiff | null>;
  // The board tools' session reads and writes (#807 P3 B5b1b1). The viewer sessions' IDs (core viewers).
  viewerIds(r: Read): Promise<Set<string>>;
  // Each of ids' facts peer_list shows for an unbound session (core unboundRows' read); an ID with no row is absent.
  idFacts(r: Read, ids: string[]): Promise<Map<string, UnboundFacts>>;
  // Touches `handle` and sets the status of the session holding it (an ID: its own, while unended) to `text`,
  // already cleaned (core statusText); empty clears it (status and status_at null). false: no live session holds it
  // (core setStatus).
  setStatus(tx: Tx, handle: string, text: string, now: number): Promise<boolean>;
  // A name's queue-board opt-out, touching it (core setQueueParticipation).
  setQueueParticipation(tx: Tx, handle: string, on: boolean): Promise<void>;
}
