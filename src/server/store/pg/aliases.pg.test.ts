// #807 P3 C5b: the aliases store's races on Postgres (c5-scope §5.2 T-C5-1…6, docs/future/postgres-server.md D3),
// each in T-P12's shape (tests/support/pg_race.ts): A's body holds its transaction open at a gate, B's starts, and the
// race waits until B is blocked on a lock or done. The end state is asserted before `waited`, so a race whose lock is
// gone fails on what it broke (a scope past its cap, a hold on a deleted alias, two users on one alias), not on a
// timeout. The bindings side (take, a tools-only root's writes_as) is C10a's: until then T-C5-4…6 race the real
// aliases.lock against raw-SQL stand-ins for it, which C10a replaces with the real methods. Without
// GRAYBOARD_TEST_PG_URL they skip.
import { expect, test } from "bun:test";
import { describePg } from "../../../../tests/support/pg.ts";
import { committed, outcome, pgPair, race, type PgPair } from "../../../../tests/support/pg_race.ts";
import { aliasCapRefusal } from "../../alias_cap.ts";
import type { AliasTarget } from "../aliases.ts";
import type { Tx } from "../tx_base.ts";
import { makePgAliases } from "./aliases.ts";
import { pgFailure } from "./errors.ts";
import { pgOf } from "./tx.ts";

const ME = "you@example.com";
const person = (name: string): AliasTarget => ({ scope_kind: "person", scope_ref: ME, name });
const X = `${ME}/x`;
const al = makePgAliases({ clock: () => 1_800_000_000_000 });

const count = async (p: PgPair, table: "aliases" | "alias_holds") => Number((await p.db.sql`SELECT count(*) AS n FROM ${p.db.sql(table)}`)[0].n);

describePg("aliases store races (Postgres)", () => {
  // A create at the cap's check, as identityCreate, bindNow and hostedWritesAs run it: the refusal, then the create.
  const createCapped = (name: string, cap: number) => async (tx: Tx) =>
    await aliasCapRefusal(al, tx, person(name), cap) ? "capped" : await al.create(tx, person(name), ME) ? "created" : "exists";
  const atCapLessOne = (p: PgPair) => p.a.write(async tx => { await al.create(tx, person("a"), ME); await al.create(tx, person("b"), ME); });

  // Mutation: lockScope a no-op (both count 2 and create: 4 names at a cap of 3).
  test("T-C5-1: two creators of different names at a scope's last slot: one creates, the other is capped", async () => {
    await using p = await pgPair();
    await atCapLessOne(p);
    const r = await race(p, createCapped("c", 3), createCapped("d", 3));
    expect([outcome(r.a), outcome(r.b)]).toEqual(["created", "capped"]);
    expect(await count(p, "aliases")).toBe(3);
    expect(r.waitEvent).toBe("advisory");
  });

  // Mutation: aliasCapRefusal doesn't look the name up after the lock (B counts 3 and is capped for a name that exists).
  test("T-C5-2: two creators of the same name at the last slot: one creates, the other finds it and binds it", async () => {
    await using p = await pgPair();
    await atCapLessOne(p);
    const r = await race(p, createCapped("c", 3), createCapped("c", 3));
    expect([outcome(r.a), outcome(r.b)]).toEqual(["created", "exists"]);
    expect(await count(p, "aliases")).toBe(3);
    expect(r.waitEvent).toBe("advisory");
  });

  // Mutation: create as a plain INSERT (B fails 23505 and its whole body rolls back).
  test("T-C5-3: two lazy creates of one address: the second gets null and its body goes on to commit", async () => {
    await using p = await pgPair();
    const r = await race(p, tx => al.create(tx, person("x"), ME), async tx => {
      const again = await al.create(tx, person("x"), "other@example.com");
      const next = await al.create(tx, person("y"), ME);
      return { again, next: next?.address };
    });
    expect(committed(r.a)?.address).toBe(X);
    expect(outcome(r.b)).toEqual({ again: null, next: `${ME}/y` });
    expect((await p.db.sql`SELECT address, created_by_principal FROM aliases ORDER BY address`).map((x: Record<string, unknown>) => ({ ...x })))
      .toEqual([{ address: X, created_by_principal: ME }, { address: `${ME}/y`, created_by_principal: ME }]);
    expect(r.waited).toBe(true);
  });

  // Stand-ins for C10a's bindings.take and registerId's writes_as: aliases.lock "use", then aliasUser's check (another
  // user holds or writes as the alias), then the hold or the writes_as.
  const otherUser = async (tx: Tx, user: string) => (await pgOf(tx)`SELECT 1 FROM ids WHERE writes_as = ${X} AND principal IS DISTINCT FROM ${user}
    UNION ALL SELECT 1 FROM alias_holds h JOIN ids i ON i.id = h.id WHERE h.address = ${X} AND i.principal IS DISTINCT FROM ${user}`).length > 0;
  const take = (session: string, user: string) => async (tx: Tx) => {
    if (!await al.lock(tx, X, "use")) return "gone";
    if (await otherUser(tx, user)) return "held";
    await pgOf(tx)`INSERT INTO alias_holds (address, id, bound_at) VALUES (${X}, ${session}, 0)`;
    return "took";
  };
  const writesAs = (session: string, user: string) => async (tx: Tx) => {
    if (!await al.lock(tx, X, "use")) return "gone";
    if (await otherUser(tx, user)) return "held";
    await pgOf(tx)`UPDATE ids SET writes_as = ${X} WHERE id = ${session}`;
    return "wrote";
  };
  // identityDelete, teamDeleteAlias, adminServiceDeleteAlias and the Slack unlink: lock "delete", the holds check, remove.
  const del = async (tx: Tx) => {
    if (!await al.lock(tx, X, "delete")) return "gone";
    if ((await pgOf(tx)`SELECT 1 FROM alias_holds WHERE address = ${X}`).length) return "held";
    await al.remove(tx, X);
    return "removed";
  };
  async function world(p: PgPair) {
    await p.a.write(tx => al.create(tx, person("x"), ME));
    await p.db.sql`INSERT INTO ids (id, principal, started_at, last_seen) VALUES ('id:s1', 'u1@example.com', 0, 0), ('id:s2', 'u2@example.com', 0, 0)`;
  }
  const holds = async (p: PgPair) => [...await p.db.sql`SELECT address, id FROM alias_holds`];
  const writers = async (p: PgPair) => (await p.db.sql`SELECT id FROM ids WHERE writes_as IS NOT NULL ORDER BY id`).map((x: { id: string }) => x.id);

  // Mutation: the delete reads with find instead of lock (it misses the uncommitted hold and deletes the alias under it).
  test("T-C5-4: a delete racing a bind's take, take first: the delete sees the hold and refuses", async () => {
    await using p = await pgPair();
    await world(p);
    const r = await race(p, take("id:s1", "u1@example.com"), del);
    expect([outcome(r.a), outcome(r.b)]).toEqual(["took", "held"]);
    expect((await p.db.sql`SELECT address FROM aliases`).map((x: { address: string }) => x.address)).toEqual([X]);
    expect(await holds(p)).toEqual([{ address: X, id: "id:s1" }]);
    expect(r.waited).toBe(true);
  });

  // Mutation: "use" a plain read (the take reads the alias before the delete commits and holds a deleted alias).
  test("T-C5-5: a delete racing a bind's take, delete first: the take finds the alias gone and holds nothing", async () => {
    await using p = await pgPair();
    await world(p);
    const r = await race(p, del, take("id:s2", "u2@example.com"));
    expect([outcome(r.a), outcome(r.b)]).toEqual(["removed", "gone"]);
    expect(await count(p, "aliases")).toBe(0);
    expect(await holds(p)).toEqual([]);
    expect(r.waited).toBe(true);
  });

  // Mutation: "use" as FOR KEY SHARE, which doesn't conflict with itself (both pass their check: two users on X).
  test("T-C5-6: a tools-only root's writes_as and another user's take: the second is refused, in either order", async () => {
    {
      await using p = await pgPair();
      await world(p);
      const r = await race(p, writesAs("id:s1", "u1@example.com"), take("id:s2", "u2@example.com"));
      expect([outcome(r.a), outcome(r.b)]).toEqual(["wrote", "held"]);
      expect(await writers(p)).toEqual(["id:s1"]);
      expect(await holds(p)).toEqual([]);
      expect(r.waited).toBe(true);
    }
    {
      await using p = await pgPair();
      await world(p);
      const r = await race(p, take("id:s2", "u2@example.com"), writesAs("id:s1", "u1@example.com"));
      expect([outcome(r.a), outcome(r.b)]).toEqual(["took", "held"]);
      expect(await writers(p)).toEqual([]);
      expect(await holds(p)).toEqual([{ address: X, id: "id:s2" }]);
      expect(r.waited).toBe(true);
    }
  });

  // c5a audit F5: lock reads on the body's own connection and holds its row lock in the body's transaction, in the mode
  // asked. Mutations: lock on the pool (it can't see the body's uncommitted row, and locks nothing); either mode
  // weakened (another connection's NOWAIT lock succeeds).
  test("lock reads through the body's Tx and holds the row lock there, in its mode", async () => {
    await using p = await pgPair();
    await p.a.write(async tx => { await al.create(tx, person("x"), ME); await al.create(tx, person("z"), ME); });
    const elsewhere = async (address: string, mode: "FOR KEY SHARE" | "FOR NO KEY UPDATE") => {
      try {
        await p.db.sql.unsafe(`SELECT 1 FROM aliases WHERE address = $1 ${mode} NOWAIT`, [address]);
        return "free";
      } catch (e) { return pgFailure(e)?.kind ?? String(e); }
    };
    const seen = await p.a.write(async tx => {
      const fresh = await al.create(tx, person("new"), ME);
      const own = await al.lock(tx, `${ME}/new`, "delete");
      await al.lock(tx, X, "use");
      await al.lock(tx, `${ME}/z`, "delete");
      return {
        own: own?.id === fresh?.id && own !== undefined,
        useKeyShare: await elsewhere(X, "FOR KEY SHARE"), useNoKeyUpdate: await elsewhere(X, "FOR NO KEY UPDATE"),
        deleteKeyShare: await elsewhere(`${ME}/z`, "FOR KEY SHARE"),
      };
    });
    expect(seen).toEqual({ own: true, useKeyShare: "free", useNoKeyUpdate: "lock_unavailable", deleteKeyShare: "lock_unavailable" });
    // Released at commit.
    expect(await elsewhere(`${ME}/z`, "FOR KEY SHARE")).toBe("free");
  });
});
