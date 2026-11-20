// The bindings store on Postgres (#807 P3 C10a-b, docs/future/postgres-server.md D3, D6): store/bindings.ts's
// BindingsStore, each method on its caller's handle through pgOf. The SQLite store (db.ts makeRepo's bindings, over
// core/bindings.ts and core/boards.ts) is the reference; what differs, and why:
// - take locks before it checks. The alias row first, through the aliases store's lock "use" (FOR NO KEY UPDATE): two
//   takes, or a take and a tools-only root's writes_as (application.ts hostedWritesAs takes the same lock), serialize,
//   so the second's userOf sees the first's committed hold or writes_as; a gone alias is no take (a delete won). Then
//   the taking ID's ids row FOR KEY SHARE, unended (E4): an end locks that row FOR UPDATE first, so a take waits for it
//   and then reads it ended (null), or the end waits for the take and releases its hold. KEY SHARE, not SHARE: it
//   doesn't conflict with a presence touch's UPDATE (FOR NO KEY UPDATE). Then core's upsert, its 2-argument MAX as
//   GREATEST; its conflict WHERE (the same ID's re-take) is the backstop the locks make unreachable.
// - registerId inserts if absent (ON CONFLICT (id) DO NOTHING RETURNING): a second registration of one ID waits on the
//   first's uncommitted row and gets no row, then re-reads its ended_at for IdCollision, where a plain insert fails
//   23505 and aborts its whole body. The tombstone is consumed after the insert, so a registration racing a prune of
//   the same keyed ID waits on the prune's delete and then reads the tombstone it committed (ReusedId). A child's root
//   is read FOR KEY SHARE and an ended one refused (E3), as take refuses an ended ID.
// - setIdFacts and setMeta read the row FOR NO KEY UPDATE before they diff it, so a second writer waits and diffs
//   against the first's committed values (no lost update, and a before that is the previous after). setMeta's UPDATE
//   writes the five label columns from the locked row; it never interpolates a column name.
// - log's refusal coalescing reads the session's last row for the name and then updates it, unlocked: two concurrent
//   refusals may write two rows where SQLite writes one with a count of 2, a declared benign race (it only counts).
// - json_each(?) is `= ANY($1::text[])`; userOf's rowid tiebreak is ids.seq (0001's identity column, the insertion
//   order) and its `IS NOT ?2` is IS DISTINCT FROM; lastSeen is one statement over its handles.
// - Booleans are booleans (viewer, keyed, local_resume, launcher, queue_off), mapped back where the contract's types
//   are numbers (idFacts.launcher 1/0). int8 columns go through the mappers. Text columns are COLLATE "C", so the
//   ORDER BYs that SQLite runs in byte order (HOLD_ORDER's address) match; they say so explicitly.
// - Stamps the caller doesn't give read the store's clock (SQLite's core reads Date.now()).
//
// Runtime imports stay off bun:sqlite, db.ts, core/bindings.ts and core/boards.ts (pg/isolation.test.ts): the SQL is
// restated, and the text cleaners come from core/text.ts, IdCollision from core/errors.ts.
import { addressParts } from "../../../core/addresses.ts";
import { CoreError, IdCollision } from "../../../core/errors.ts";
import { cleanFact, cleanPlace } from "../../../core/text.ts";
import type { AliasesStore } from "../aliases.ts";
import type { AliasMetaDiff, AliasMetaSet, AliasUse, BindingsStore, IdSessionFacts, UnboundFacts } from "../bindings.ts";
import { int8, int8OrNull } from "./sql.ts";
import { pgOf } from "./tx.ts";

type Row = Record<string, unknown>;

// core REFUSED_COALESCE_MS (core/bindings.ts), restated: a test pins the two equal.
export const REFUSED_COALESCE_MS = 60_000;
// core ALIAS_META_KEYS (core/boards.ts), restated: the only label columns setMeta writes.
const META_KEYS = ["task", "owner", "source_board", "spec_hash", "description"] as const;
type MetaKey = (typeof META_KEYS)[number];

// An ended root's child (E3): refused as take refuses an ended ID.
export const endedRootText = (root: string) => `root session ${root} has ended; a child can't register under it`;

export function makePgBindings({ clock, aliases }: { clock: () => number; aliases: Pick<AliasesStore, "lock"> }): BindingsStore {
  const holdsOf: BindingsStore["holdsOf"] = async (r, id) =>
    (await pgOf(r)`SELECT address FROM alias_holds WHERE id = ${id} ORDER BY bound_at, address COLLATE "C"` as Row[]).map(x => x.address as string);
  const holderOf: BindingsStore["holderOf"] = async (r, address) => {
    const [row] = await pgOf(r)`SELECT id FROM alias_holds WHERE address = ${address}`;
    return (row?.id as string | undefined) ?? null;
  };
  const idRow: BindingsStore["idRow"] = async (r, id) => {
    const [x] = await pgOf(r)`SELECT principal, ended_at, place, writes_as, viewer FROM ids WHERE id = ${id}`;
    return x ? { principal: x.principal, ended_at: int8OrNull(x.ended_at), place: x.place, writes_as: x.writes_as, viewer: x.viewer === true } : undefined;
  };
  // core aliasUser.
  const userOf: BindingsStore["userOf"] = async (r, address, exceptPrincipal = null) => {
    const [row] = await pgOf(r)`SELECT i.id FROM ids i
      WHERE i.ended_at IS NULL AND (${exceptPrincipal}::text IS NULL OR i.principal IS DISTINCT FROM ${exceptPrincipal}::text)
        AND (i.id IN (SELECT id FROM alias_holds WHERE address = ${address}) OR i.writes_as = ${address})
      ORDER BY (i.id IN (SELECT id FROM alias_holds WHERE address = ${address})) DESC, i.started_at, i.seq
      LIMIT 1`;
    return (row?.id as string | undefined) ?? null;
  };
  // core touchAlias.
  const touchAlias: BindingsStore["touchAlias"] = async (tx, address, now = clock()) => {
    await pgOf(tx)`UPDATE aliases SET last_seen = ${now}::int8 WHERE address = ${address}`;
  };

  return {
    holdsOf,
    async holdsOfMany(r, ids) {
      const out = new Map<string, string[]>(ids.map(id => [id, []]));
      const rows: Row[] = await pgOf(r)`SELECT id, address FROM alias_holds WHERE id = ANY(${ids}::text[]) ORDER BY bound_at, address COLLATE "C"`;
      for (const x of rows) out.get(x.id as string)!.push(x.address as string);
      return out;
    },
    holderOf,
    async holdersOf(r, addresses) {
      const rows: Row[] = await pgOf(r)`SELECT id, address FROM alias_holds WHERE address = ANY(${addresses}::text[])`;
      return new Map(rows.map(x => [x.address as string, x.id as string]));
    },
    userOf,
    // core addressSet: three reads on one handle (a Read's skew is a session's own binds and ends, which the caller's
    // next request sees).
    async addressSet(r, address, principal) {
      if (principal === null) return [address];
      const id = addressParts(address)?.kind === "id" ? address : await holderOf(r, address);
      const row = id === null ? undefined : await idRow(r, id);
      if (id === null || !row || row.principal !== principal) return [address];
      return [address, ...[...await holdsOf(r, id), id].filter(a => a !== address)];
    },
    idRow,
    async unendedIds(r) {
      return (await pgOf(r)`SELECT id FROM ids WHERE ended_at IS NULL AND NOT viewer` as Row[]).map(x => x.id as string);
    },
    async idStatuses(r, ids) {
      const rows: Row[] = await pgOf(r)`SELECT id, status, status_at FROM ids WHERE status IS NOT NULL AND id = ANY(${ids}::text[])`;
      return new Map(rows.map(x => [x.id as string, { status: x.status as string, status_at: int8OrNull(x.status_at) }]));
    },
    // core aliasUses.
    async aliasUses(r, principal) {
      const rows: Row[] = await pgOf(r)`SELECT * FROM (
          SELECT h.id, i.principal, a.address, a.scope_kind, a.scope_ref, true AS held FROM alias_holds h
            JOIN ids i ON i.id = h.id JOIN aliases a ON a.address = h.address
           WHERE i.ended_at IS NULL AND i.principal IS NOT NULL
          UNION ALL
          SELECT i.id, i.principal, a.address, a.scope_kind, a.scope_ref, false FROM ids i JOIN aliases a ON a.address = i.writes_as
           WHERE i.ended_at IS NULL AND i.principal IS NOT NULL) u
        WHERE ${principal}::text IS NULL OR principal = ${principal}::text`;
      return rows.map((x): AliasUse => ({
        id: x.id as string, principal: x.principal as string, address: x.address as string,
        scope_kind: x.scope_kind as AliasUse["scope_kind"], scope_ref: x.scope_ref as string, held: x.held === true,
      }));
    },
    // core lastSeen per handle, in one statement: an ID's from its ids row, any other handle's from its alias row.
    async lastSeen(r, handles) {
      const unique = [...new Set(handles)];
      const ids = unique.filter(h => addressParts(h)?.kind === "id"), names = unique.filter(h => addressParts(h)?.kind !== "id");
      const rows: Row[] = await pgOf(r)`SELECT id AS handle, last_seen FROM ids WHERE id = ANY(${ids}::text[])
        UNION ALL SELECT address, last_seen FROM aliases WHERE address = ANY(${names}::text[]) AND last_seen IS NOT NULL`;
      return new Map(rows.map(x => [x.handle as string, int8(x.last_seen)]));
    },
    async take(tx, address, id, principal, now) {
      const sql = pgOf(tx);
      if (!(await aliases.lock(tx, address, "use"))) return null;
      const [live] = await sql`SELECT 1 FROM ids WHERE id = ${id} AND ended_at IS NULL FOR KEY SHARE`;
      if (!live) return null;
      if (await userOf(tx, address, principal)) return null;
      const [row] = await sql`INSERT INTO alias_holds (address, id, bound_at)
          VALUES (${address}, ${id}, GREATEST(${now}::int8, COALESCE((SELECT MAX(bound_at) + 1 FROM alias_holds WHERE id = ${id} AND address <> ${address}), ${now}::int8)))
        ON CONFLICT (address) DO UPDATE SET bound_at = excluded.bound_at WHERE alias_holds.id = excluded.id
        RETURNING bound_at`;
      return row ? { bound_at: int8(row.bound_at) } : null;
    },
    async release(tx, address, id) {
      await pgOf(tx)`DELETE FROM alias_holds WHERE address = ${address} AND id = ${id}`;
    },
    // core logBinding.
    async log(tx, id, name, event, detail = null, at = clock()) {
      const sql = pgOf(tx);
      if (event === "refused") {
        const [last] = await sql`SELECT id, event, detail, COALESCE(last_at, at) AS seen FROM binding_events
          WHERE session_id = ${id} AND name = ${name} ORDER BY id DESC LIMIT 1`;
        if (last?.event === "refused" && last.detail === detail && at - int8(last.seen) <= REFUSED_COALESCE_MS) {
          await sql`UPDATE binding_events SET count = COALESCE(count, 1) + 1, last_at = ${at}::int8 WHERE id = ${last.id}`;
          return;
        }
      }
      await sql`INSERT INTO binding_events (session_id, name, event, at, detail) VALUES (${id}, ${name}, ${event}, ${at}::int8, ${detail}::text)`;
    },
    touchAlias,
    async touchId(tx, id, now = clock()) {
      await pgOf(tx)`UPDATE ids SET last_seen = ${now}::int8 WHERE id = ${id}`;
    },
    // core registerId.
    async registerId(tx, f) {
      const sql = pgOf(tx);
      if (f.rootId !== undefined) {
        const [root] = await sql`SELECT ended_at FROM ids WHERE id = ${f.rootId} FOR KEY SHARE`;
        if (root && root.ended_at !== null) throw new CoreError(endedRootText(f.rootId), "id_ended");
      }
      const now = clock();
      // A row a prune deletes between the insert and the re-read frees the ID: insert again.
      for (let attempt = 0; ; attempt++) {
        const [made] = await sql`INSERT INTO ids (id, principal, harness, cwd, place, launcher, started_at, last_seen, delivery, writes_as, viewer,
            keyed, model, effort, root_id, harness_session, local_resume)
          VALUES (${f.id}, ${f.principal}::text, ${cleanFact(f.harness)}::text, ${f.cwd ?? null}::text, ${cleanPlace(f.place ?? null)}::text,
            ${f.launcher}::boolean, ${now}::int8, ${now}::int8, ${f.writesAs === undefined && f.rootId === undefined ? "push" : "none"},
            ${f.writesAs ?? null}::text, ${f.viewer === true}::boolean, ${f.keyed === true}::boolean, ${cleanFact(f.model)}::text,
            ${cleanFact(f.effort)}::text, ${f.rootId ?? null}::text, ${f.harnessSession ?? null}::text, ${f.localResume === true}::boolean)
          ON CONFLICT (id) DO NOTHING RETURNING id`;
        if (made) break;
        const [prior] = await sql`SELECT ended_at FROM ids WHERE id = ${f.id}`;
        if (prior) throw new IdCollision(f.id, int8OrNull(prior.ended_at));
        if (attempt >= 2) throw new Error(`grayboard: registering ${f.id} found its row and then didn't, three times`);
      }
      const [gone] = await sql`DELETE FROM pruned_ids WHERE id = ${f.id} RETURNING ended_at, pruned_at`;
      return gone ? { ended_at: int8(gone.ended_at), pruned_at: int8(gone.pruned_at) } : null;
    },
    // core setIdFacts, reading the row FOR NO KEY UPDATE.
    async setIdFacts(tx, id, facts) {
      const sql = pgOf(tx);
      const [row] = await sql`SELECT model, effort FROM ids WHERE id = ${id} FOR NO KEY UPDATE`;
      if (!row) return null;
      const before: IdSessionFacts = { model: row.model as string | null, effort: row.effort as string | null };
      const after: IdSessionFacts = {
        model: facts.model === undefined ? before.model : cleanFact(facts.model),
        effort: facts.effort === undefined ? before.effort : cleanFact(facts.effort),
      };
      if (after.model === before.model && after.effort === before.effort) return null;
      await sql`UPDATE ids SET model = ${after.model}::text, effort = ${after.effort}::text WHERE id = ${id}`;
      return { before, after };
    },
    async setPlace(tx, id, place) {
      await pgOf(tx)`UPDATE ids SET place = ${cleanPlace(place)}::text WHERE id = ${id}`;
    },
    // core writeAliasMeta, reading the row FOR NO KEY UPDATE.
    async setMeta(tx, address, meta) {
      const keys = Object.keys(meta) as MetaKey[];
      for (const k of keys) if (!(META_KEYS as readonly string[]).includes(k)) throw new Error(`grayboard: unknown alias label ${JSON.stringify(k)}`);
      if (!keys.length) return null;
      const sql = pgOf(tx);
      const [cur] = await sql`SELECT task, owner, source_board, spec_hash, description FROM aliases WHERE address = ${address} FOR NO KEY UPDATE`;
      if (!cur) throw new Error(`grayboard: no alias "${address}" to label`);
      const before: AliasMetaSet = {}, after: AliasMetaSet = {};
      for (const k of keys) if ((meta[k] ?? null) !== cur[k]) { before[k] = (cur[k] as string | null) ?? null; after[k] = meta[k] ?? null; }
      if (!Object.keys(after).length) return null;
      const next = Object.fromEntries(META_KEYS.map(k => [k, k in after ? after[k] ?? null : cur[k] as string | null])) as Record<MetaKey, string | null>;
      await sql`UPDATE aliases SET task = ${next.task}::text, owner = ${next.owner}::text, source_board = ${next.source_board}::text,
        spec_hash = ${next.spec_hash}::text, description = ${next.description}::text WHERE address = ${address}`;
      return { before, after } satisfies AliasMetaDiff;
    },
    async viewerIds(r) {
      return new Set((await pgOf(r)`SELECT id FROM ids WHERE viewer` as Row[]).map(x => x.id as string));
    },
    async idFacts(r, ids) {
      const rows: Row[] = await pgOf(r)`SELECT id, principal, harness, model, effort, launcher FROM ids WHERE id = ANY(${ids}::text[])`;
      return new Map(rows.map((x): [string, UnboundFacts] => [x.id as string, {
        principal: x.principal as string | null, harness: x.harness as string | null, model: x.model as string | null,
        effort: x.effort as string | null, launcher: x.launcher === null ? null : x.launcher === true ? 1 : 0,
      }]));
    },
    // core setStatus's touch, then writeStatus: an ID sets its own row while unended, a name its holder's.
    async setStatus(tx, handle, text, now) {
      await touchAlias(tx, handle, now);
      const sql = pgOf(tx);
      const [status, at] = [text || null, text ? now : null];
      const rows = addressParts(handle)?.kind === "id"
        ? await sql`UPDATE ids SET status = ${status}::text, status_at = ${at}::int8 WHERE id = ${handle} AND ended_at IS NULL RETURNING 1`
        : await sql`UPDATE ids SET status = ${status}::text, status_at = ${at}::int8 WHERE id = (SELECT id FROM alias_holds WHERE address = ${handle}) RETURNING 1`;
      return rows.length > 0;
    },
    // core setQueueParticipation: touches the alias (the store's clock), then sets or clears the opt-out.
    async setQueueParticipation(tx, handle, on) {
      await touchAlias(tx, handle);
      await pgOf(tx)`UPDATE aliases SET queue_off = ${on ? null : true}::boolean WHERE address = ${handle}`;
    },
  };
}
