// msg.send and human.reach through policy.ts `authorize` on the store's read handle (#807 P3 C10d2-a: the synchronous
// canSend and reachesHuman went with authorizeNow).
import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorize, type HumanReach } from "./policy.ts";
import { openDatabase, type Repo } from "./db.ts";
import { scratchDbPath } from "../../tests/support/scratch_db.ts";
import { seed } from "../../tests/support/seed.ts";

const FROM = "wade@example.com/fe";

describe("msg.send", () => {
  let repo: Repo;
  beforeEach(() => {
    repo = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) }).repo;
  });
  const send = (to: string) => authorize(repo, repo.read, { humanReach: "team" }, { verb: "msg.send", from: FROM, to });

  test("allows an agent -> agent send", async () => {
    expect((await send("bob@example.com/be")).allow).toBe(true);
  });

  test("refuses a stranger's human with a machine-readable code", async () => {
    expect(await send("bob@example.com/human")).toMatchObject({ allow: false, code: "forbidden" });
  });
});

// #284 S12: reach is decided by the sending address's principal.
describe("human.reach", () => {
  let repo: Repo;
  beforeEach(async () => {
    repo = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) }).repo;
    await seed(repo, async tx => {
      const wade = await repo.users.upsertByEmail(tx, "wade@example.com", null);
      const bob = await repo.users.upsertByEmail(tx, "bob@example.com", null);
      await repo.users.upsertByEmail(tx, "eve@example.com", null);
      const eng = await repo.teams.create(tx, "eng", wade.id);
      await repo.teams.addMember(tx, eng.id, wade.id);
      await repo.teams.addMember(tx, eng.id, bob.id);
      await repo.teams.create(tx, "ops", wade.id);
    });
  });
  const reaches = async (reach: HumanReach, from: string, to: string) =>
    (await authorize(repo, repo.read, { humanReach: reach }, { verb: "human.reach", from, to })).allow;

  test("a person reaches their own human and a teammate's, not a stranger's", async () => {
    expect(await reaches("team", "wade@example.com/fe", "wade@example.com/human")).toBe(true);
    expect(await reaches("team", "wade@example.com/fe", "bob@example.com/human")).toBe(true);
    expect(await reaches("team", "eve@example.com/fe", "bob@example.com/human")).toBe(false);
    expect(await reaches("all", "eve@example.com/fe", "bob@example.com/human")).toBe(true);
  });

  test("a team alias reaches its members' humans only", async () => {
    expect(await reaches("team", "eng/deploy", "bob@example.com/human")).toBe(true);
    expect(await reaches("team", "eng/deploy", "eve@example.com/human")).toBe(false);
    expect(await reaches("team", "ops/deploy", "bob@example.com/human")).toBe(false);
  });

  test("an address with no principal reaches no human; anything else isn't a human", async () => {
    expect(await reaches("team", "nobody/fe", "bob@example.com/human")).toBe(false);
    expect(await reaches("team", "~tail-1", "bob@example.com/human")).toBe(false);
    expect(await reaches("team", "nobody/fe", "bob@example.com/be")).toBe(true);
  });
});
