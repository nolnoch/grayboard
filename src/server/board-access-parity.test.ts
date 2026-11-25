// The async board access (#807 P3 B5a0) gives serverAccess's answers: every method and branch, on the store's read
// handle and inside a write body, against the synchronous access the server installed until #807 P3 C10d2-a, kept as
// the parity tests' oracle (tests/support/sync_access.ts); and its reads go on the handle it's given,
// so a body sees its own uncommitted rows and not its rollback.
import { describe, test, expect, beforeEach } from "bun:test";
import type { CoreDb } from "../core/boards.ts";
import type { Principal } from "../core/resolver.ts";
import { boardAccess, scopeKey } from "./access.ts";
import type { Repo } from "./db.ts";
import type { Read, Tx } from "./store/tx.ts";
import { AUTHORS, B, BOARDS, D, E, ENG_ID, HANDLES, openBoardParity, SCOPES, TOKENS, TOOLS_ID, W, WADE_ID } from "../../tests/support/board_parity.ts";
import { principalCanSee, serverAccess } from "../../tests/support/sync_access.ts";
import { NO_MEMBER_AUTHORITY } from "./store/identity.ts";

let repo: Repo;
let db: CoreDb;

beforeEach(async () => {
  ({ repo, db } = await openBoardParity());
});

// A call's outcome, a throw as its message, so a refusal compares by text.
const outcome = <T>(f: () => T): { value: T } | { error: string } => {
  try { return { value: f() }; } catch (e) { return { error: (e as Error).message }; }
};
const outcomeAsync = async <T>(f: () => Promise<T>): Promise<{ value: T } | { error: string }> => {
  try { return { value: await f() }; } catch (e) { return { error: (e as Error).message }; }
};
const sorted = (s: Set<string>) => [...s].sort();

// Every row: [label, the sync answer, the async answer on handle r]. Run on the read handle and inside a body.
async function rows(r: Read, tx: Tx | null, humanReach: "team" | "all"): Promise<[string, unknown, unknown][]> {
  const sync = serverAccess(repo, db, humanReach), async = boardAccess(repo, humanReach);
  const out: [string, unknown, unknown][] = [];
  for (const b of BOARDS) {
    const each = HANDLES.filter(h => sync.canSee(h, b));
    for (const h of HANDLES) out.push([`canSee ${h} ${b.name}`, sync.canSee(h, b), await async.canSee(r, h, b)]);
    out.push([`canSeeMany ${b.name}`, each.sort(), sorted(await async.canSeeMany(r, HANDLES, b))]);
  }
  // A principal viewer (the read-only seer) against principalCanSee; a service principal sees only unscoped boards.
  const principals: Principal[] = [{ kind: "user", name: W }, { kind: "user", name: D }, { kind: "team", name: "ops" }, { kind: "service", name: "svc" }];
  for (const v of [...HANDLES, ...principals]) {
    const want = BOARDS.filter(b => typeof v === "string" ? sync.canSee(v, b) : principalCanSee(repo, db, v, b)).map(b => b.name).sort();
    out.push([`visibleTo ${typeof v === "string" ? v : `${v.kind}:${v.name}`}`, want, sorted(await async.visibleTo(r, v, BOARDS))]);
  }
  // A claimant's user by its principal's name (#1286): a person, a team, a service, and a name nobody has.
  for (const u of [W, B, E, D, "nobody@example.com", "eng", "ops", "svc", ""]) for (const b of BOARDS) out.push([`userSees ${u} ${b.name}`, sync.userSees!(u, b), await async.userSees(r, u, b)]);
  for (const h of HANDLES) {
    for (const scope of [null, "team:eng", "team:ops", "team:nope", "weird"]) out.push([`checkCreate ${h} ${scope}`, sync.checkCreate(h, scope), await async.checkCreate(r, h, scope)]);
    for (const s of SCOPES) {
      out.push([`seesAlias ${h} ${scopeKey(s)}`, sync.seesAlias!(h, s), await async.seesAlias(r, h, s)]);
      out.push([`seesAliasMeta ${h} ${scopeKey(s)}`, sync.seesAliasMeta(h, s), await async.seesAliasMeta(r, h, s)]);
    }
    out.push([`seesAliasScopes ${h}`, Object.fromEntries(SCOPES.map(s => [scopeKey(s), sync.seesAlias!(h, s)])), Object.fromEntries(await async.seesAliasScopes(r, h, SCOPES))]);
    out.push([`seesAliasMetaScopes ${h}`, Object.fromEntries(SCOPES.map(s => [scopeKey(s), sync.seesAliasMeta(h, s)])), Object.fromEntries(await async.seesAliasMetaScopes(r, h, SCOPES))]);
    out.push([`ownerOf ${h}`, sync.ownerOf!(h), await async.ownerOf(r, h)]);
    for (const a of HANDLES) out.push([`sameUser ${h} ${a}`, sync.sameUser!(h, a), await async.sameUser(r, h, a)]);
  }
  for (const from of AUTHORS) {
    const tos = [...HANDLES, `${B}/human`, `${D}/human`];
    for (const to of tos) out.push([`mayReach ${from} ${to}`, sync.mayReach!(from, to), await async.mayReach(r, from, to)]);
    out.push([`mayReachMany ${from}`, tos.filter(t => sync.mayReach!(from, t)).sort(), sorted(await async.mayReachMany(r, from, tos))]);
  }
  if (tx === null) return out;
  // resolveMention judges an @id: on a Tx: inside the body only.
  for (const author of AUTHORS) for (const b of BOARDS.slice(0, 3)) for (const strict of [true, false]) for (const viewer of [author, WADE_ID]) {
    for (const t of TOKENS) {
      out.push([`resolveMention ${t} ${author} ${b.name} ${strict} ${viewer}`, outcome(() => sync.resolveMention(t, author, b, strict, viewer)), await outcomeAsync(() => async.resolveMention(tx, t, author, b, strict, viewer))]);
    }
    // core's resolveMentions loop over the sync seam.
    const want = outcome(() => {
      const handles = new Set<string>(), unresolved: string[] = [];
      for (const t of TOKENS) { const h = sync.resolveMention(t, author, b, strict, viewer); if (h && sync.canSee(h, b)) handles.add(h); else unresolved.push(t); }
      return { handles: [...handles], unresolved };
    });
    out.push([`resolveMentions ${author} ${b.name} ${strict} ${viewer}`, want, await outcomeAsync(() => async.resolveMentions(tx, TOKENS, author, b, strict, viewer))]);
  }
  return out;
}

const diverging = (rs: [string, unknown, unknown][]) => rs.filter(([, s, a]) => JSON.stringify(s) !== JSON.stringify(a)).map(([l, s, a]) => ({ l, s, a }));

describe("boardAccess agrees with serverAccess", () => {
  for (const humanReach of ["team", "all"] as const) {
    test(`on the read handle and inside a body (humanReach ${humanReach})`, async () => {
      const outside = await rows(repo.read, null, humanReach);
      expect(outside.length).toBeGreaterThan(500);
      expect(diverging(outside)).toEqual([]);
      const inside = await repo.write(tx => rows(tx, tx, humanReach));
      expect(diverging(inside)).toEqual([]);
      // The fixture reaches every answer: some rows allow and some refuse, and resolveMention resolves and refuses.
      const values = new Set(inside.map(([, s]) => JSON.stringify(s)));
      for (const v of ["true", "false", "null"]) expect(values.has(v)).toBe(true);
      // seer's fallbacks for an ID (#1286): a tools-only one as its writes_as name (eng/deploy, not wade) on ops; a
      // bound one as its primary (eng, not wade) on a service's names. Wade's own session is the control for both.
      const said = (l: string) => inside.find(([x]) => x === l)?.[1];
      const svc = scopeKey({ scope_kind: "service", scope_ref: "svc" });
      expect([said(`canSee ${TOOLS_ID} ops`), said(`canSee ${WADE_ID} ops`), said(`canSee ${TOOLS_ID} eng`)]).toEqual([false, true, true]);
      expect([said(`seesAlias ${ENG_ID} ${svc}`), said(`seesAlias ${WADE_ID} ${svc}`)]).toEqual([false, true]);
      expect(inside.some(([l, s]) => l.startsWith("resolveMention ") && JSON.stringify(s).includes("isn't in your scope"))).toBe(true);
      expect(inside.some(([l, s]) => l.startsWith("resolveMention ") && JSON.stringify(s).includes("id_ended"))).toBe(true);
    }, 60_000);
  }
});

test("its reads go on the handle it's given: a body sees its own membership, not its rollback", async () => {
  const a = boardAccess(repo), sync = serverAccess(repo, db);
  const eng = BOARDS[1]!, dan = `${D}/be`;
  const rolled = repo.write(async tx => {
    await repo.teams.addMember(tx, (await repo.teams.findByName(tx, "eng"))!.id, (await repo.users.findByEmail(tx, D))!.id, NO_MEMBER_AUTHORITY);
    expect([sync.canSee(dan, eng), await a.canSee(tx, dan, eng), sorted(await a.canSeeMany(tx, [dan], eng)), sorted(await a.visibleTo(tx, dan, BOARDS))]).toEqual([true, true, [dan], ["eng", "general"]]);
    expect(await a.checkCreate(tx, dan, "team:eng")).toBeNull();
    expect((await a.seesAliasScopes(tx, dan, [{ scope_kind: "team", scope_ref: "eng" }])).get(scopeKey({ scope_kind: "team", scope_ref: "eng" }))).toBe(true);
    expect(await a.resolveMention(tx, "eng/deploy", dan, eng, true)).toBe("eng/deploy");
    throw new Error("roll back");
  });
  await expect(rolled).rejects.toThrow("roll back");
  expect([sync.canSee(dan, eng), await a.canSee(repo.read, dan, eng), await a.checkCreate(repo.read, dan, "team:eng")]).toEqual([false, false, `no such team "eng"`]);
  // A kept Tx is refused by any method that reads on it.
  const kept = await repo.write(async tx => tx);
  await expect(a.canSeeMany(kept, [dan], eng)).rejects.toThrow(/used after its transaction settled/);
  await expect(a.resolveMention(kept, WADE_ID, dan, eng, true)).rejects.toThrow(/used after its transaction settled/);
});
