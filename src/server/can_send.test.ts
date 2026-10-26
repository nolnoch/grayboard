import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canSend, canAdmin, reachesHuman, type SendTarget, type SendContext } from "./can_send.ts";
import { openDatabase, type Repo } from "./db.ts";

const FROM = "wade@example.com/fe";

describe("canSend", () => {
  let ctx: SendContext;
  beforeEach(() => {
    const { repo } = openDatabase(":memory:", { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
    ctx = { db: repo, now: Date.now(), humanReach: "team" };
  });

  test("allows an agent -> agent send", () => {
    const target: SendTarget = { kind: "user", address: "bob@example.com/be" };
    expect(canSend(FROM, target, ctx).allow).toBe(true);
  });

  test("refuses a stranger's human with a machine-readable code", () => {
    const target: SendTarget = { kind: "user", address: "bob@example.com/human" };
    expect(canSend(FROM, target, ctx)).toMatchObject({ allow: false, code: "forbidden" });
  });

  test("canSend is synchronous", () => {
    const result = canSend(FROM, { kind: "user", address: "bob@example.com/be" }, ctx);
    // A Promise has a .then property; a plain object does not
    expect(result).not.toHaveProperty("then");
  });
});

// #284 S12: reach is decided by the sending address's principal.
describe("reachesHuman", () => {
  let repo: Repo;
  beforeEach(() => {
    repo = openDatabase(":memory:", { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) }).repo;
    const wade = repo.users.upsertByEmail("wade@example.com", null);
    const bob = repo.users.upsertByEmail("bob@example.com", null);
    repo.users.upsertByEmail("eve@example.com", null);
    const eng = repo.teams.create("eng", wade.id);
    repo.teams.addMember(eng.id, wade.id);
    repo.teams.addMember(eng.id, bob.id);
    repo.teams.create("ops", wade.id);
  });

  test("a person reaches their own human and a teammate's, not a stranger's", () => {
    expect(reachesHuman(repo, "team", "wade@example.com/fe", "wade@example.com/human")).toBe(true);
    expect(reachesHuman(repo, "team", "wade@example.com/fe", "bob@example.com/human")).toBe(true);
    expect(reachesHuman(repo, "team", "eve@example.com/fe", "bob@example.com/human")).toBe(false);
    expect(reachesHuman(repo, "all", "eve@example.com/fe", "bob@example.com/human")).toBe(true);
  });

  test("a team alias reaches its members' humans only", () => {
    expect(reachesHuman(repo, "team", "eng/deploy", "bob@example.com/human")).toBe(true);
    expect(reachesHuman(repo, "team", "eng/deploy", "eve@example.com/human")).toBe(false);
    expect(reachesHuman(repo, "team", "ops/deploy", "bob@example.com/human")).toBe(false);
  });

  test("an address with no principal reaches no human; anything else isn't a human", () => {
    expect(reachesHuman(repo, "team", "nobody/fe", "bob@example.com/human")).toBe(false);
    expect(reachesHuman(repo, "team", "~tail-1", "bob@example.com/human")).toBe(false);
    expect(reachesHuman(repo, "team", "nobody/fe", "bob@example.com/be")).toBe(true);
  });
});

describe("canAdmin", () => {
  test("allows emails on the admin list, case-insensitively", () => {
    expect(canAdmin("wade@example.com", ["wade@example.com"]).allow).toBe(true);
    expect(canAdmin("Wade@Example.com", ["wade@example.com"]).allow).toBe(true);
  });

  test("refuses everyone else, and everyone when no admins are configured", () => {
    expect(canAdmin("wade@example.com", ["bob@example.com"])).toMatchObject({ allow: false, code: "forbidden" });
    expect(canAdmin("wade@example.com", [])).toMatchObject({ allow: false, code: "forbidden", reason: expect.stringContaining("GRAYBOARD_ADMINS") });
  });
});
