// The aliases store on Postgres (#807 P3 C5, docs/future/postgres-server.md D3, D6): store/aliases.ts's AliasesStore,
// each method on its caller's handle through pgOf. The SQLite store (db.ts makeRepo's aliases, over core/boards.ts's
// markHuman, isHuman, humansAmong, aliasScopeRows and ALIAS_SESSION_SQL) is the reference; what differs, and why:
// - The scope cap's count runs after lockScope, a transaction-scoped advisory lock per scope (ALIAS_CAP_LOCK keyed by
//   hashtext(kind:ref)), which aliasCapRefusal takes in the creating body: two creators at cap-1 would otherwise both
//   count cap-1 and both insert. Advisory rather than the scope's parent row: a scope's parent is a user, a team or a
//   service, three tables, and FOR UPDATE on a row that isn't there locks nothing (decision 1). Never taken inside a
//   savepoint that rolls back: ROLLBACK TO frees it.
// - create is insert-if-absent (ON CONFLICT (address) DO NOTHING RETURNING): a second creator of one address waits on
//   the first's uncommitted row and gets no row, where a plain insert fails 23505 and aborts its whole body.
// - lock reads the alias row FOR UPDATE ("delete": a remove, its holds checked after it) or FOR NO KEY UPDATE ("use":
//   a hold or a writes_as, bindings' take, C10a). Two "use"s serialize, so a bind's take and a tools-only root's
//   writes_as for two users can't both pass their check; a delete and a take serialize, so no hold outlives its alias.
//   No table has a foreign key to aliases, so no FK check's KEY SHARE meets either.
// - human is boolean: a cleared mark stores NULL, as SQLite does, and the reads test the bare column.
// - No savepoints, and no generation bump (c5-scope §4).
//
// Runtime imports stay off bun:sqlite, db.ts and core/boards.ts (pg/isolation.test.ts): the SQL is restated.
import type { ScopeKind } from "../../../core/addresses.ts";
import { HUMAN_NAME } from "../../../shared/addressing.ts";
import type { Alias, AliasesStore, AliasScopeRow } from "../aliases.ts";
import { int8 } from "./sql.ts";
import { pgOf, type PgSql } from "./tx.ts";

// pg_advisory_xact_lock(class, key) for the alias cap (decision 1): the two-int4 form beside the OAuth caps' classes
// (pg/oauth.ts), keyed by hashtext(`${scope_kind}:${scope_ref}`). A collision only serializes two scopes' creates.
export const ALIAS_CAP_LOCK = 0x6762616c; // "gbal"

type Row = Record<string, unknown>;
const toAlias = (r: Row): Alias => ({
  id: int8(r.id), address: r.address as string, scope_kind: r.scope_kind as ScopeKind, scope_ref: r.scope_ref as string,
  name: r.name as string, created_at: int8(r.created_at),
});
const cols = (sql: PgSql) => sql.fragment`id, address, scope_kind, scope_ref, name, created_at`;
const one = async (rows: Promise<Row[]>) => { const [r] = await rows; return r ? toAlias(r) : undefined; };

export function makePgAliases({ clock }: { clock: () => number }): AliasesStore {
  const at = (sql: PgSql, address: string) => one(sql`SELECT ${cols(sql)} FROM aliases WHERE address = ${address}`);
  return {
    async create(tx, scope, createdBy) {
      const sql = pgOf(tx);
      const { scope_kind, scope_ref, name } = scope;
      return (await one(sql`INSERT INTO aliases (address, scope_kind, scope_ref, name, created_by_principal, created_at)
        VALUES (${`${scope_ref}/${name}`}, ${scope_kind}, ${scope_ref}, ${name}, ${createdBy}, ${clock()})
        ON CONFLICT (address) DO NOTHING RETURNING ${cols(sql)}`)) ?? null;
    },
    find: (r, address) => at(pgOf(r), address),
    async lock(tx, address, mode) {
      const sql = pgOf(tx);
      return one(mode === "delete"
        ? sql`SELECT ${cols(sql)} FROM aliases WHERE address = ${address} FOR UPDATE`
        : sql`SELECT ${cols(sql)} FROM aliases WHERE address = ${address} FOR NO KEY UPDATE`);
    },
    async lockScope(tx, scope) {
      await pgOf(tx)`SELECT pg_advisory_xact_lock(${ALIAS_CAP_LOCK}::int4, hashtext(${`${scope.scope_kind}:${scope.scope_ref}`}))`;
    },
    async listForScope(r, kind, ref) {
      const sql = pgOf(r);
      return (await sql`SELECT ${cols(sql)} FROM aliases WHERE scope_ref = ${ref} AND scope_kind = ${kind} ORDER BY name`).map(toAlias);
    },
    async countForScope(r, kind, ref) {
      const [row] = await pgOf(r)`SELECT count(*) AS n FROM aliases WHERE scope_ref = ${ref} AND scope_kind = ${kind} AND name != ${HUMAN_NAME}`;
      return int8(row.n);
    },
    async findAllByName(r, name) {
      const sql = pgOf(r);
      return (await sql`SELECT ${cols(sql)} FROM aliases WHERE name = ${name} ORDER BY address`).map(toAlias);
    },
    // core ALIAS_SESSION_SQL: the holder's session, else the last binder's once it has ended.
    async seen(r, addresses) {
      const rows: Row[] = await pgOf(r)`SELECT a.address, a.last_seen, i.cwd, i.place FROM aliases a LEFT JOIN ids i ON i.id = COALESCE(
          (SELECT id FROM alias_holds WHERE address = a.address),
          (SELECT l.session_id FROM (SELECT session_id FROM binding_events WHERE name = a.address AND event IN ('bound', 'moved') ORDER BY id DESC LIMIT 1) l
            JOIN ids e ON e.id = l.session_id WHERE e.ended_at IS NOT NULL))
        WHERE a.address = ANY(${addresses}::text[]) AND a.last_seen IS NOT NULL`;
      return new Map(rows.map(x => [x.address as string, { last_seen: int8(x.last_seen), cwd: x.cwd as string | null, place: x.place as string | null }]));
    },
    async remove(tx, address) {
      const sql = pgOf(tx);
      await sql`DELETE FROM mailbox_cursors WHERE address = ${address}`;
      await sql`DELETE FROM aliases WHERE address = ${address}`;
    },
    // core markHuman: touches last_seen (on the store's clock), then sets the mark or clears it to NULL.
    async markHuman(tx, handle, human) {
      await pgOf(tx)`UPDATE aliases SET last_seen = ${clock()}, human = ${human ? true : null}::boolean WHERE address = ${handle}`;
    },
    async isHuman(r, handle) {
      const [row] = await pgOf(r)`SELECT human FROM aliases WHERE address = ${handle}`;
      return row?.human === true;
    },
    async scopesOf(r, addresses) {
      const rows: Row[] = await pgOf(r)`SELECT address, scope_kind, scope_ref FROM aliases WHERE address = ANY(${[...new Set(addresses)]}::text[])`;
      return new Map(rows.map(x => [x.address as string, { scope_kind: x.scope_kind, scope_ref: x.scope_ref } as AliasScopeRow]));
    },
    async humansAmong(r, handles) {
      if (!handles.length) return new Set();
      const rows: Row[] = await pgOf(r)`SELECT address FROM aliases WHERE human AND address = ANY(${[...new Set(handles)]}::text[])`;
      return new Set(rows.map(x => x.address as string));
    },
  };
}
