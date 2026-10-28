// Server access through the Resolver (#284 S12, S13): who an address acts
// for decides what it sees, creates and mentions.
import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { idAddress } from "../core/bindings.ts";
import { endSession } from "../core/session_end.ts";
import { registerId, type Board, type CoreDb } from "../core/boards.ts";
import { mayActIn, serverAccess } from "./access.ts";
import { openDatabase, type Repo } from "./db.ts";

const person = (email: string, name: string) => ({ scope_kind: "person" as const, scope_ref: email, name });
const team = (ref: string, name: string) => ({ scope_kind: "team" as const, scope_ref: ref, name });
const board = (name: string, scope: string | null): Board => ({ name, purpose: "", scope, created_by: "x", created_at: 0 });

const OPEN = board("general", null);
const ENG = board("eng", "team:eng");
const OPS = board("ops", "team:ops");
const WADE_ID = idAddress("a".repeat(64));

let repo: Repo;
let db: CoreDb;
let access: ReturnType<typeof serverAccess>;

beforeEach(() => {
  ({ repo, db } = openDatabase(":memory:", { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) }));
  const wade = repo.users.upsertByEmail("wade@example.com", null);
  const bob = repo.users.upsertByEmail("bob@example.com", null);
  const eve = repo.users.upsertByEmail("eve@example.com", null);
  const eng = repo.teams.create("eng", wade.id);
  repo.teams.addMember(eng.id, wade.id);
  repo.teams.addMember(eng.id, bob.id);
  const ops = repo.teams.create("ops", eve.id);
  repo.teams.addMember(ops.id, eve.id);
  repo.teams.addMember(ops.id, wade.id);
  for (const [email, name] of [["wade@example.com", "be"], ["bob@example.com", "be"], ["bob@example.com", "qa"], ["eve@example.com", "be"]] as const) {
    repo.aliases.create(person(email, name), email);
  }
  repo.aliases.create(team("eng", "deploy"), "wade@example.com");
  registerId(db, { id: WADE_ID, principal: "wade@example.com", launcher: false });
  access = serverAccess(repo, db);
});

describe("Resolver", () => {
  test("maps IDs, person aliases, team aliases and team broadcasts to principals", () => {
    const r = repo.resolver;
    expect(r.principalOf(WADE_ID)).toEqual({ kind: "user", name: "wade@example.com" });
    expect(r.principalOf("wade@example.com/be")).toEqual({ kind: "user", name: "wade@example.com" });
    expect(r.principalOf("eng/deploy")).toEqual({ kind: "team", name: "eng" });
    expect(r.principalOf("team:eng")).toEqual({ kind: "team", name: "eng" });
  });

  test("names no principal for an unknown scope, an unregistered ID, a bare name or a viewer handle", () => {
    const r = repo.resolver;
    for (const a of ["nobody@example.com/be", "nope/x", "team:nope", idAddress("f".repeat(64)), "be", "wade@example.com/~abc", ""]) {
      expect(r.principalOf(a)).toBeNull();
    }
  });

  test("team:x names only a team", () => {
    expect(repo.resolver.principalOf("team:wade@example.com")).toBeNull();
  });
});

describe("canSee", () => {
  test("open boards: any address with a principal, including an ID", () => {
    expect(access.canSee("wade@example.com/be", OPEN)).toBe(true);
    expect(access.canSee(WADE_ID, OPEN)).toBe(true);
    expect(access.canSee("eng/deploy", OPEN)).toBe(true);
    expect(access.canSee("nobody@example.com/be", OPEN)).toBe(false);
  });

  test("team boards: members' addresses and the team's own aliases", () => {
    expect(access.canSee("bob@example.com/be", ENG)).toBe(true);
    expect(access.canSee(WADE_ID, ENG)).toBe(true);
    expect(access.canSee("eve@example.com/be", ENG)).toBe(false);
    expect(access.canSee("eng/deploy", ENG)).toBe(true);
  });

  test("a team alias acts as its team: it can't see its binder's other teams' boards", () => {
    // wade is in ops; eng/deploy (bound by wade) is not.
    expect(access.canSee("wade@example.com/be", OPS)).toBe(true);
    expect(access.canSee("eng/deploy", OPS)).toBe(false);
  });
});

describe("checkCreate", () => {
  test("open boards for anyone; team boards for members and the team's aliases", () => {
    expect(access.checkCreate("eve@example.com/be", null)).toBeNull();
    expect(access.checkCreate(WADE_ID, "team:eng")).toBeNull();
    expect(access.checkCreate("eng/deploy", "team:eng")).toBeNull();
    expect(access.checkCreate("eve@example.com/be", "team:eng")).toBe(`you're not a member of team "eng"`);
    expect(access.checkCreate("eng/deploy", "team:ops")).toBe(`you're not a member of team "ops"`);
    expect(access.checkCreate("wade@example.com/be", "team:nope")).toBe(`no such team "nope"`);
    expect(access.checkCreate("wade@example.com/be", "open")).toBe(`invalid board scope "open"`);
  });
});

describe("resolveMention", () => {
  const AUTHOR = "wade@example.com/be";

  test("@scope/name is that alias exactly; the email-local-part shorthand is gone", () => {
    expect(access.resolveMention("bob@example.com/qa", AUTHOR, OPEN, true)).toBe("bob@example.com/qa");
    expect(access.resolveMention("eng/deploy", AUTHOR, OPEN, true)).toBe("eng/deploy");
    expect(access.resolveMention("bob/qa", AUTHOR, OPEN, true)).toBeNull();
    expect(access.resolveMention("bob@example.com/nope", AUTHOR, OPEN, true)).toBeNull();
  });

  test("a bare name is the author's own scope's first, for an alias or an ID author", () => {
    expect(access.resolveMention("be", AUTHOR, OPEN, true)).toBe("wade@example.com/be");
    expect(access.resolveMention("be", WADE_ID, OPEN, true)).toBe("wade@example.com/be");
    expect(access.resolveMention("deploy", "eng/other", OPEN, true)).toBe("eng/deploy");
  });

  test("else the one roster match the board can see", () => {
    expect(access.resolveMention("qa", AUTHOR, OPEN, true)).toBe("bob@example.com/qa");
    expect(access.resolveMention("deploy", AUTHOR, ENG, true)).toBe("eng/deploy");
    // bob isn't in ops, so his qa isn't on the ops roster.
    expect(access.resolveMention("qa", "eve@example.com/be", OPS, true)).toBeNull();
  });

  test("an ambiguous bare name refuses a strict post with the candidates, and is unresolved otherwise", () => {
    expect(() => access.resolveMention("be", "eng/deploy", OPEN, true)).toThrow(
      "@be matches bob@example.com/be, eve@example.com/be, wade@example.com/be; name one",
    );
    expect(access.resolveMention("be", "eng/deploy", OPEN, false)).toBeNull();
    // Only the board's roster counts: on eng, eve's be can't see it.
    expect(() => access.resolveMention("be", "eng/deploy", ENG, true)).toThrow("@be matches bob@example.com/be, wade@example.com/be; name one");
  });

  test("a bare @human is only ever your own", () => {
    repo.aliases.create(person("bob@example.com", "human"), "bob@example.com");
    expect(access.resolveMention("human", AUTHOR, OPEN, true)).toBeNull();
    expect(access.resolveMention("human", "bob@example.com/qa", OPEN, true)).toBe("bob@example.com/human");
  });

  test("an exact human mention follows DM reach", () => {
    repo.aliases.create(person("bob@example.com", "human"), "bob@example.com");
    expect(access.resolveMention("bob@example.com/human", AUTHOR, OPEN, true)).toBe("bob@example.com/human");
    expect(access.resolveMention("bob@example.com/human", "eve@example.com/be", OPEN, true)).toBeNull();
    expect(access.resolveMention("bob@example.com/human", "eng/deploy", OPEN, true)).toBe("bob@example.com/human");
  });

  test("@id: resolves a live ID; an ended one refuses a strict post and is unresolved otherwise", () => {
    expect(access.resolveMention(WADE_ID, AUTHOR, OPEN, true)).toBe(WADE_ID);
    repo.atomic(() => endSession(db, repo.mail, WADE_ID, { why: "test", now: 5 }));
    expect(() => access.resolveMention(WADE_ID, AUTHOR, OPEN, true)).toThrow(/^id_ended:/);
    expect(access.resolveMention(WADE_ID, AUTHOR, OPEN, false)).toBeNull();
    expect(access.resolveMention(idAddress("f".repeat(64)), AUTHOR, OPEN, false)).toBeNull();
  });

  test("a team broadcast is never a mention", () => {
    expect(access.resolveMention("team:eng", AUTHOR, ENG, true)).toBeNull();
  });
});

// Who may bind or write as an alias (#284 S9), keyed by principal.
// #284 S13: peer_list's alias labels are judged for the calling session's
// ID, whose principal is its user even when its primary is a team alias.
test("seesAliasMeta: only a principal that may act in the alias's scope", () => {
  const eveId = idAddress("e".repeat(64));
  registerId(db, { id: eveId, principal: "eve@example.com", launcher: false });
  expect(access.seesAliasMeta(WADE_ID, { scope_kind: "team", scope_ref: "eng" })).toBe(true);
  expect(access.seesAliasMeta(WADE_ID, { scope_kind: "person", scope_ref: "wade@example.com" })).toBe(true);
  expect(access.seesAliasMeta(eveId, { scope_kind: "team", scope_ref: "eng" })).toBe(false);
  expect(access.seesAliasMeta(eveId, { scope_kind: "person", scope_ref: "wade@example.com" })).toBe(false);
  expect(access.seesAliasMeta(WADE_ID, { scope_kind: "person", scope_ref: null })).toBe(false);
  expect(access.seesAliasMeta(idAddress("f".repeat(64)), { scope_kind: "team", scope_ref: "eng" })).toBe(false);
});

test("mayActIn: a user acts in its own person scope and its teams' scopes; service scopes wait for #270", () => {
  const bob = { kind: "user" as const, name: "bob@example.com" };
  const may = (p: Parameters<typeof mayActIn>[1], kind: "person" | "team" | "service", ref: string) => mayActIn(repo, p, { scope_kind: kind, scope_ref: ref });
  expect(may(bob, "person", "bob@example.com")).toBeNull();
  expect(may(bob, "person", "wade@example.com")).toBe("wade@example.com's scope isn't bob@example.com's");
  expect(may(bob, "team", "eng")).toBeNull();
  expect(may(bob, "team", "ops")).toBe("bob@example.com isn't a member of team ops");
  expect(may(bob, "team", "nosuch")).toBe("bob@example.com isn't a member of team nosuch");
  expect(may(bob, "service", "ci")).toBe("service principals arrive with #270");
  expect(may({ kind: "service", name: "ci" }, "team", "eng")).toBe("service principals arrive with #270");
  expect(may({ kind: "team", name: "eng" }, "team", "eng")).toBe("eng is a team, not a user");
  repo.teams.removeMember(repo.teams.findByName("eng")!.id, repo.users.findByEmail("bob@example.com")!.id);
  expect(may(bob, "team", "eng")).toBe("bob@example.com isn't a member of team eng");
});
