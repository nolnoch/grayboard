// Server access through the Resolver (#284 S12, S13): who an address acts
// for decides what it sees, creates and mentions.
import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { idAddress } from "../core/bindings.ts";
import { registerId, type Board, type CoreDb } from "../core/boards.ts";
import type { Principal } from "../core/resolver.ts";
import { boardAccess } from "./access.ts";
import { authorize } from "./policy.ts";
import { openDatabase, type Repo } from "./db.ts";
import { scratchDbPath } from "../../tests/support/scratch_db.ts";
import { seed } from "../../tests/support/seed.ts";
import { NO_MEMBER_AUTHORITY } from "./store/identity.ts";

const person = (email: string, name: string) => ({ scope_kind: "person" as const, scope_ref: email, name });
const team = (ref: string, name: string) => ({ scope_kind: "team" as const, scope_ref: ref, name });
const board = (name: string, scope: string | null): Board => ({ name, purpose: "", scope, created_by: "x", created_at: 0 });

const OPEN = board("general", null);
const ENG = board("eng", "team:eng");
const OPS = board("ops", "team:ops");
const WADE_ID = idAddress("a".repeat(64));

let repo: Repo;
let db: CoreDb;
// boardAccess's methods on the committed state; resolveMention on a body's Tx, as the server calls it.
type Scope = Parameters<ReturnType<typeof boardAccess>["seesAlias"]>[2];
let access: {
  canSee(handle: string, board: Board): Promise<boolean>;
  checkCreate(handle: string, scope: string | null): Promise<string | null>;
  resolveMention(token: string, author: string, board: Board, strict: boolean): Promise<string | null>;
  seesAliasMeta(handle: string, scope: Scope): Promise<boolean>;
  seesAlias(handle: string, scope: Scope): Promise<boolean>;
};

beforeEach(async () => {
  ({ repo, db } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) }));
  await seed(repo, async tx => {
    const wade = await repo.users.upsertByEmail(tx, "wade@example.com", null);
    const bob = await repo.users.upsertByEmail(tx, "bob@example.com", null);
    const eve = await repo.users.upsertByEmail(tx, "eve@example.com", null);
    const eng = await repo.teams.create(tx, "eng", wade.id);
    await repo.teams.addMember(tx, eng.id, wade.id, NO_MEMBER_AUTHORITY);
    await repo.teams.addMember(tx, eng.id, bob.id, NO_MEMBER_AUTHORITY);
    const ops = await repo.teams.create(tx, "ops", eve.id);
    await repo.teams.addMember(tx, ops.id, eve.id, NO_MEMBER_AUTHORITY);
    await repo.teams.addMember(tx, ops.id, wade.id, NO_MEMBER_AUTHORITY);
    for (const [email, name] of [["wade@example.com", "be"], ["bob@example.com", "be"], ["bob@example.com", "qa"], ["eve@example.com", "be"]] as const) {
      await repo.aliases.create(tx, person(email, name), email);
    }
    await repo.aliases.create(tx, team("eng", "deploy"), "wade@example.com");
    registerId(db, { id: WADE_ID, principal: "wade@example.com", launcher: false });
  });
  const a = boardAccess(repo);
  access = {
    canSee: (handle, b) => a.canSee(repo.read, handle, b),
    checkCreate: (handle, scope) => a.checkCreate(repo.read, handle, scope),
    resolveMention: (token, author, b, strict) => seed(repo, tx => a.resolveMention(tx, token, author, b, strict)),
    seesAliasMeta: (handle, scope) => a.seesAliasMeta(repo.read, handle, scope),
    seesAlias: (handle, scope) => a.seesAlias(repo.read, handle, scope),
  };
});

describe("Resolver", () => {
  test("maps IDs, person aliases, team aliases and team broadcasts to principals", async () => {
    const r = { principalOf: (address: string) => repo.principals.of(repo.read, address) };
    expect(await r.principalOf(WADE_ID)).toEqual({ kind: "user", name: "wade@example.com" });
    expect(await r.principalOf("wade@example.com/be")).toEqual({ kind: "user", name: "wade@example.com" });
    expect(await r.principalOf("eng/deploy")).toEqual({ kind: "team", name: "eng" });
    expect(await r.principalOf("team:eng")).toEqual({ kind: "team", name: "eng" });
  });

  test("names no principal for an unknown scope, an unregistered ID, a bare name or a viewer handle", async () => {
    const r = { principalOf: (address: string) => repo.principals.of(repo.read, address) };
    for (const a of ["nobody@example.com/be", "nope/x", "team:nope", idAddress("f".repeat(64)), "be", "wade@example.com/~abc", ""]) {
      expect(await r.principalOf(a)).toBeNull();
    }
  });

  test("team:x names only a team", async () => {
    expect(await repo.principals.of(repo.read, "team:wade@example.com")).toBeNull();
  });
});

describe("canSee", () => {
  test("open boards: any address with a principal, including an ID", async () => {
    expect(await access.canSee("wade@example.com/be", OPEN)).toBe(true);
    expect(await access.canSee(WADE_ID, OPEN)).toBe(true);
    expect(await access.canSee("eng/deploy", OPEN)).toBe(true);
    expect(await access.canSee("nobody@example.com/be", OPEN)).toBe(false);
  });

  test("team boards: members' addresses and the team's own aliases", async () => {
    expect(await access.canSee("bob@example.com/be", ENG)).toBe(true);
    expect(await access.canSee(WADE_ID, ENG)).toBe(true);
    expect(await access.canSee("eve@example.com/be", ENG)).toBe(false);
    expect(await access.canSee("eng/deploy", ENG)).toBe(true);
  });

  test("a team alias acts as its team: it can't see its binder's other teams' boards", async () => {
    // wade is in ops; eng/deploy (bound by wade) is not.
    expect(await access.canSee("wade@example.com/be", OPS)).toBe(true);
    expect(await access.canSee("eng/deploy", OPS)).toBe(false);
  });
});

describe("checkCreate", () => {
  test("open boards for anyone; team boards for members and the team's aliases", async () => {
    expect(await access.checkCreate("eve@example.com/be", null)).toBeNull();
    expect(await access.checkCreate(WADE_ID, "team:eng")).toBeNull();
    expect(await access.checkCreate("eng/deploy", "team:eng")).toBeNull();
    expect(await access.checkCreate("eve@example.com/be", "team:eng")).toBe(`no such team "eng"`);
    expect(await access.checkCreate("eng/deploy", "team:ops")).toBe(`no such team "ops"`);
    expect(await access.checkCreate("wade@example.com/be", "team:nope")).toBe(`no such team "nope"`);
    expect(await access.checkCreate("wade@example.com/be", "open")).toBe(`invalid board scope "open"`);
  });
});

describe("resolveMention", () => {
  const AUTHOR = "wade@example.com/be";

  test("@scope/name is that alias exactly; the email-local-part shorthand is gone", async () => {
    expect(await access.resolveMention("bob@example.com/qa", AUTHOR, OPEN, true)).toBe("bob@example.com/qa");
    expect(await access.resolveMention("eng/deploy", AUTHOR, OPEN, true)).toBe("eng/deploy");
    expect(await access.resolveMention("bob/qa", AUTHOR, OPEN, true)).toBeNull();
    expect(await access.resolveMention("bob@example.com/nope", AUTHOR, OPEN, true)).toBeNull();
  });

  test("a bare name is the author's own scope's first, for an alias or an ID author", async () => {
    expect(await access.resolveMention("be", AUTHOR, OPEN, true)).toBe("wade@example.com/be");
    expect(await access.resolveMention("be", WADE_ID, OPEN, true)).toBe("wade@example.com/be");
    expect(await access.resolveMention("deploy", "eng/other", OPEN, true)).toBe("eng/deploy");
  });

  test("never another scope's: a strict post refuses naming the roster's matches, a system post leaves it unresolved (F-08)", async () => {
    await expect(access.resolveMention("qa", AUTHOR, OPEN, true)).rejects.toThrow("@qa isn't in your scope; name it in full: bob@example.com/qa");
    expect(await access.resolveMention("qa", AUTHOR, OPEN, false)).toBeNull();
    await expect(access.resolveMention("deploy", AUTHOR, ENG, true)).rejects.toThrow("@deploy isn't in your scope; name it in full: eng/deploy");
    await expect(access.resolveMention("be", "eng/deploy", OPEN, true)).rejects.toThrow(
      "@be isn't in your scope; name it in full: bob@example.com/be, eve@example.com/be, wade@example.com/be",
    );
    expect(await access.resolveMention("be", "eng/deploy", OPEN, false)).toBeNull();
    // Only the board's roster is named: on eng, eve's be can't see it.
    await expect(access.resolveMention("be", "eng/deploy", ENG, true)).rejects.toThrow("@be isn't in your scope; name it in full: bob@example.com/be, wade@example.com/be");
    // bob isn't in ops, so his qa isn't on the ops roster: nothing to name.
    expect(await access.resolveMention("qa", "eve@example.com/be", OPS, true)).toBeNull();
  });

  test("a bare @human is only ever your own", async () => {
    await seed(repo, tx => repo.aliases.create(tx, person("bob@example.com", "human"), "bob@example.com"));
    expect(await access.resolveMention("human", AUTHOR, OPEN, true)).toBeNull();
    expect(await access.resolveMention("human", "bob@example.com/qa", OPEN, true)).toBe("bob@example.com/human");
  });

  test("an exact human mention follows DM reach", async () => {
    await seed(repo, tx => repo.aliases.create(tx, person("bob@example.com", "human"), "bob@example.com"));
    expect(await access.resolveMention("bob@example.com/human", AUTHOR, OPEN, true)).toBe("bob@example.com/human");
    expect(await access.resolveMention("bob@example.com/human", "eve@example.com/be", OPEN, true)).toBeNull();
    expect(await access.resolveMention("bob@example.com/human", "eng/deploy", OPEN, true)).toBe("bob@example.com/human");
  });

  test("@id: resolves a live ID; an ended one refuses a strict post and is unresolved otherwise", async () => {
    expect(await access.resolveMention(WADE_ID, AUTHOR, OPEN, true)).toBe(WADE_ID);
    await seed(repo, tx => repo.sessionEnd.end(tx, WADE_ID, 5));
    await expect(access.resolveMention(WADE_ID, AUTHOR, OPEN, true)).rejects.toThrow(/^id_ended:/);
    expect(await access.resolveMention(WADE_ID, AUTHOR, OPEN, false)).toBeNull();
    expect(await access.resolveMention(idAddress("f".repeat(64)), AUTHOR, OPEN, false)).toBeNull();
  });

  test("a team broadcast is never a mention", async () => {
    expect(await access.resolveMention("team:eng", AUTHOR, ENG, true)).toBeNull();
  });
});

// Who may bind or write as an alias (#284 S9), keyed by principal.
// #284 S13: peer_list's alias labels are judged for the calling session's
// ID, whose principal is its user even when its primary is a team alias.
test("seesAliasMeta: only a principal that may act in the alias's scope", async () => {
  const eveId = idAddress("e".repeat(64));
  await seed(repo, () => registerId(db, { id: eveId, principal: "eve@example.com", launcher: false }));
  expect(await access.seesAliasMeta(WADE_ID, { scope_kind: "team", scope_ref: "eng" })).toBe(true);
  expect(await access.seesAliasMeta(WADE_ID, { scope_kind: "person", scope_ref: "wade@example.com" })).toBe(true);
  expect(await access.seesAliasMeta(eveId, { scope_kind: "team", scope_ref: "eng" })).toBe(false);
  expect(await access.seesAliasMeta(eveId, { scope_kind: "person", scope_ref: "wade@example.com" })).toBe(false);
  expect(await access.seesAliasMeta(WADE_ID, { scope_kind: "person", scope_ref: null })).toBe(false);
  expect(await access.seesAliasMeta(idAddress("f".repeat(64)), { scope_kind: "team", scope_ref: "eng" })).toBe(false);
});

// #348: a team's alias names reach the team and its members; people's names
// are the open directory. No admin exemption, and an unknown address sees none.
test("seesAlias: a person scope to anyone signed in, a team's to its members and its own aliases", async () => {
  const eveId = idAddress("e".repeat(64));
  await seed(repo, async tx => {
    registerId(db, { id: eveId, principal: "eve@example.com", launcher: false });
    await repo.aliases.create(tx, team("eng", "build"), "wade@example.com");
    await repo.aliases.create(tx, team("ops", "run"), "eve@example.com");
  });
  const eng = { scope_kind: "team" as const, scope_ref: "eng" };
  expect(await access.seesAlias(WADE_ID, eng)).toBe(true);
  expect(await access.seesAlias(eveId, eng)).toBe(false);
  expect(await access.seesAlias(eveId, { scope_kind: "person", scope_ref: "wade@example.com" })).toBe(true);
  // A team alias acts for its team: its own team's names, not another's.
  expect(await access.seesAlias("eng/build", eng)).toBe(true);
  expect(await access.seesAlias("ops/run", eng)).toBe(false);
  expect(await access.seesAlias(idAddress("f".repeat(64)), { scope_kind: "person", scope_ref: "wade@example.com" })).toBe(true);
  expect(await access.seesAlias(idAddress("f".repeat(64)), eng)).toBe(false);
  expect(await access.seesAlias(WADE_ID, { scope_kind: "team", scope_ref: null })).toBe(false);
});

test("scope.act: a user acts in its own person scope and its teams' scopes, a service in its own scope only (#270)", async () => {
  const bob = { kind: "user" as const, name: "bob@example.com" };
  const may = async (p: Principal, kind: "person" | "team" | "service", ref: string) => {
    const d = await authorize(repo, repo.read, {}, { verb: "scope.act", principal: p, scope: { scope_kind: kind, scope_ref: ref } });
    return d.allow ? null : d.reason;
  };
  expect(await may(bob, "person", "bob@example.com")).toBeNull();
  expect(await may(bob, "person", "wade@example.com")).toBe("wade@example.com's scope isn't bob@example.com's");
  expect(await may(bob, "team", "eng")).toBeNull();
  expect(await may(bob, "team", "ops")).toBe("bob@example.com isn't a member of team ops");
  expect(await may(bob, "team", "nosuch")).toBe("bob@example.com isn't a member of team nosuch");
  expect(await may(bob, "service", "ci")).toBe("no user acts in service ci's scope");
  expect(await may({ kind: "service", name: "ci" }, "team", "eng")).toBe("ci is a service; it acts only in its own scope");
  expect(await may({ kind: "service", name: "ci" }, "service", "ci")).toBeNull();
  expect(await may({ kind: "team", name: "eng" }, "team", "eng")).toBe("eng is a team, not a user");
  await seed(repo, async (tx) => repo.teams.removeMember(tx, (await repo.teams.findByName(tx, "eng"))!.id, (await repo.users.findByEmail(tx, "bob@example.com"))!.id, NO_MEMBER_AUTHORITY));
  expect(await may(bob, "team", "eng")).toBe("bob@example.com isn't a member of team eng");
});
