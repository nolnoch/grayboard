// The aliases store's row types and group interface (#807 P3 C5a, docs/future/postgres-server.md D2): names in scopes,
// keyed by address, which Repo (db.ts) composes and the Postgres store (pg/) implements. Type-only imports, so a module
// under pg/ may import it (pg/isolation.test.ts); db.ts re-exports every name.
import type { ScopeKind } from "../../core/addresses.ts";
import type { AliasScopeRow } from "../../core/boards.ts";
import type { Read, Tx } from "./tx_base.ts";

export type { AliasScopeRow };

// An alias (#284): a name in a scope, `<scope_ref>/<name>`. A person scope's
// ref is the user's email; a team or service scope's is the principal's name.
export type Alias = { id: number; address: string; scope_kind: ScopeKind; scope_ref: string; name: string; created_at: number };

// The scope a create names: its address is `${scope_ref}/${name}`.
export type AliasTarget = { scope_kind: ScopeKind; scope_ref: string; name: string };

// Every write and read returns a promise (#807 P3 A6d, A7f3, A7g2), on the caller's handle.
export interface AliasesStore {
  // Inserts the alias unless its address exists: null, writing nothing and leaving the body usable, when it does (two
  // lazy creates of one address, #807 P3 C5 decision 3). Every caller reads null as "exists". createdBy: the principal
  // that made it (the binder's user for a lazy create).
  create(tx: Tx, scope: AliasTarget, createdBy: string): Promise<Alias | null>;
  find(r: Read, address: string): Promise<Alias | undefined>;
  // The alias row locked for the rest of the body (#807 P3 C5 decision 2), or undefined when it's gone: "delete" before
  // a remove (its holds checked after it), "use" before a hold or a writes_as (bindings' take, C10a). Serially it is
  // find; on SQLite the single writer is the lock, on Postgres FOR UPDATE / FOR NO KEY UPDATE.
  lock(tx: Tx, address: string, mode: "use" | "delete"): Promise<Alias | undefined>;
  // The scope cap's lock (#807 P3 C5 decision 1), held until the body ends: two creators in one scope count in turn.
  // A no-op on SQLite (the single writer); a per-scope advisory lock on Postgres. aliasCapRefusal takes it.
  lockScope(tx: Tx, scope: { scope_kind: ScopeKind; scope_ref: string }): Promise<void>;
  listForScope(r: Read, kind: ScopeKind, ref: string): Promise<Alias[]>;
  // The scope's names less the Slack link's human, for the cap (#347).
  countForScope(r: Read, kind: ScopeKind, ref: string): Promise<number>;
  // Every scope's alias of this name.
  findAllByName(r: Read, name: string): Promise<Alias[]>;
  // When each of these addresses was last used, and the cwd or place of the
  // session that holds or last held it (ALIAS_SESSION_SQL); unused ones are absent.
  seen(r: Read, addresses: string[]): Promise<Map<string, { last_seen: number; cwd: string | null; place: string | null }>>;
  // Also deletes the alias's read points.
  remove(tx: Tx, address: string): Promise<void>;
  // Sets or clears the handle's human mark (core markHuman: one linked user's Slack handle), touching its last_seen.
  markHuman(tx: Tx, handle: string, human: boolean): Promise<void>;
  // Whether the handle carries the human mark (core isHuman) (#807 P3 B5b1b2).
  isHuman(r: Read, handle: string): Promise<boolean>;
  // Each of addresses' scope columns (core aliasScopeRows); an address with no aliases row is absent.
  scopesOf(r: Read, addresses: string[]): Promise<Map<string, AliasScopeRow>>;
  // Of handles, those carrying the human mark (core humansAmong) (#807 P3 B5b2).
  humansAmong(r: Read, handles: string[]): Promise<Set<string>>;
}
