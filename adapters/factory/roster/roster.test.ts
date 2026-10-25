// The fleet roster's pins (#124's rescoped shape, #293): each behavior here
// fails when its implementation is removed — the reviewer reverts and
// reruns. Integration tests run against a real TestServer with fake member
// sessions (real grayboard mcp children, the tests/support pattern).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientBus } from "../bus.ts";
import { openStore } from "./store.ts";
import {
  boardsFor, dataDir, dispatch, loadConfig, observePresence, postSummaries,
  startRoster, statusSummary, syncFromConfig, validateConfig,
} from "./roster.ts";
import { TestServer } from "../../../tests/support/server.ts";
import { call, closeSessions } from "../../../tests/support/mcp.ts";
import { until } from "../../../tests/support/until.ts";

let dir: string;
let srv: TestServer;
let token: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grayboard-roster-"));
  process.env.FACTORY_DATA_DIR = join(dir, "data");
  srv = new TestServer();
});

afterEach(async () => {
  await closeSessions();
  srv.stop();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.FACTORY_DATA_DIR;
});

const configPath = (): string => join(dir, "fleets.json");
const writeConfig = (fleets: { name: string; members: string[] }[]): void => {
  writeFileSync(configPath(), JSON.stringify({ fleets }));
};

describe("roster config", () => {
  test("a valid config parses; a handle may serve two fleets", () => {
    writeConfig([
      { name: "research", members: ["you@example.com/r1", "you@example.com/r2"] },
      { name: "docs", members: ["you@example.com/r1"] },
    ]);
    const cfg = loadConfig(configPath());
    expect(cfg.fleets).toHaveLength(2);
    expect(cfg.fleets[0]!.members).toEqual(["you@example.com/r1", "you@example.com/r2"]);
  });

  test("refusals name the problem: duplicate fleet, duplicate member, bad handle, no members", () => {
    expect(() => validateConfig({ fleets: [{ name: "a", members: ["x"] }, { name: "a", members: ["y"] }] }))
      .toThrow('fleet "a" appears twice');
    expect(() => validateConfig({ fleets: [{ name: "a", members: ["x", "x"] }] }))
      .toThrow('fleet "a" lists "x" twice');
    expect(() => validateConfig({ fleets: [{ name: "a", members: ["two words"] }] })).toThrow("invalid member handle");
    expect(() => validateConfig({ fleets: [{ name: "a", members: [] }] })).toThrow("at least one member");
    expect(() => validateConfig({ fleets: [{ name: "a", members: [null] }] })).toThrow("invalid member handle");
  });
});

describe("roster store", () => {
  test("fleet and member rows persist across a reopen; presence upserts", () => {
    const d = join(dir, "data");
    const s1 = openStore(d);
    s1.addFleet({ name: "research", queueBoard: "research-tasks", statusBoard: "research-status" }, 1);
    s1.addMember("research", "you@example.com/r1", 1);
    s1.setPresence("research", "you@example.com/r1", true, 2);
    s1.setPresence("research", "you@example.com/r1", false, 3);
    s1.close();
    const s2 = openStore(d);
    expect(s2.fleets().map((f) => f.name)).toEqual(["research"]);
    expect(s2.members("research").map((m) => m.handle)).toEqual(["you@example.com/r1"]);
    expect(s2.presence("research")[0]!.online).toBe(0);
    s2.close();
  });

  test("retention prunes old audit rows and keeps fresh ones", () => {
    const s = openStore(join(dir, "data"));
    s.log("old", "gone", 100);
    s.log("new", "kept", 100 + 50 * 24 * 60 * 60 * 1000);
    const removed = s.prune(30 * 24 * 60 * 60 * 1000, 100 + 50 * 24 * 60 * 60 * 1000);
    expect(removed).toBe(1);
    expect(s.events().map((e) => e.kind)).toEqual(["new"]);
    s.close();
  });
});

describe("roster on a live bus", () => {
  let bus: ClientBus;
  const member = (n: number) => `you@example.com/worker-${n}`;

  beforeEach(async () => {
    token = await srv.login("you@example.com");
  });

  afterEach(() => {
    bus?.close().catch(() => {});
  });

  const startWith = async (fleets: { name: string; members: string[] }[], intervalMs = 150) => {
    writeConfig(fleets);
    bus = new ClientBus(srv.base, () => token, "factory");
    await bus.boardCreate; // touch the property so a missing method fails here, clearly
    return startRoster(bus, configPath(), { intervalMs });
  };

  test("sync creates the fleet's boards idempotently and tracks members", async () => {
    const ctl = await startWith([{ name: "research", members: [member(1), member(2)] }]);
    try {
      const { queueBoard, statusBoard } = boardsFor("research");
      // The status board exists and is readable through the public surface.
      await until(async () => {
        const r = await bus.readBoard(statusBoard);
        return r.board === statusBoard;
      }, 10_000, "the status board to exist");
      // A same-args repeat is answered from state (#254's lost-answer
      // semantics); a different-purpose repeat is a different board intent
      // and refuses.
      await bus.boardCreate({ name: queueBoard, purpose: `the "research" fleet's task queue (one post, one member; #131/#124)`, kind: "queue", idempotencyKey: "board:again" });
      expect(bus.boardCreate({ name: queueBoard, purpose: "a different intent", kind: "queue", idempotencyKey: "board:diff" }).catch((e: Error) => e.message.includes("already exists"))).resolves.toBe(true);
      const s = openStore(join(dir, "data"));
      expect(s.fleets().map((f) => f.name)).toEqual(["research"]);
      expect(s.members("research").map((m) => m.handle).sort()).toEqual([member(1), member(2)]);
      s.close();
      void ctl;
    } finally {
      ctl.stop();
    }
  });

  test("presence is observed and the status summary is posted on change only", async () => {
    const { statusBoard } = boardsFor("research");
    // worker-1 is live from the start; worker-2 never connects this test.
    const w1 = await srv.session(token, "worker-1");
    void w1;
    const ctl = await startWith([{ name: "research", members: [member(1), member(2)] }]);
    try {
      // First observation: 1/2 online, posted to the status board.
      await until(async () => {
        const r = await bus.readBoard(statusBoard);
        return r.posts.some((p) => p.body.includes("1/2 members online"));
      }, 15_000, "the 1/2 status summary to be posted");

      // worker-2 joins: the change posts a new summary (append-only board).
      const w2 = await srv.session(token, "worker-2");
      void w2;
      await until(async () => {
        const r = await bus.readBoard(statusBoard);
        return r.posts.some((p) => p.body.includes("2/2 members online"));
      }, 15_000, "the 2/2 status summary to be posted");

      // Changeless cycles add no post: count the summaries, wait past a
      // cycle, count again.
      const before = (await bus.readBoard(statusBoard)).posts.filter((p) => p.body.startsWith("[fleet research]")).length;
      expect(before).toBe(2);
      await Bun.sleep(400);
      const after = (await bus.readBoard(statusBoard)).posts.filter((p) => p.body.startsWith("[fleet research]")).length;
      expect(after).toBe(2);
    } finally {
      ctl.stop();
    }
  });

  test("a dispatched task reaches exactly one member; the next task rotates", async () => {
    const { queueBoard } = boardsFor("research");
    const ctl = await startWith([{ name: "research", members: [member(1), member(2)] }]);
    try {
    // Both members are live lanes: subscribed push-mode on the queue board.
    const w1 = await srv.session(token, "worker-1");
    const w2 = await srv.session(token, "worker-2");
    await call(w1.c, "board_subscribe", { board: queueBoard, mode: "push" });
    await call(w2.c, "board_subscribe", { board: queueBoard, mode: "push" });

    const s = openStore(join(dir, "data"));
      const t1 = await dispatch(bus, s, "research", "task one: summarize the spec", "task:1");
      expect(t1.picked).toBe(member(1));
      const t2 = await dispatch(bus, s, "research", "task two: review the roster", "task:2");
      expect(t2.picked).toBe(member(2));

      // The delivery is real: the picked lane's session receives the task
      // as a board push — and the other lane does not (#131's one-subscriber
      // delivery).
      await until(() => w1.pushes.some((p) => p.content.includes("task one")), 10_000, "worker-1's push of task one");
      await until(() => w2.pushes.some((p) => p.content.includes("task two")), 10_000, "worker-2's push of task two");
      expect(w1.pushes.some((p) => p.content.includes("task two"))).toBe(false);
      expect(w2.pushes.some((p) => p.content.includes("task one"))).toBe(false);
      s.close();
    } finally {
      ctl.stop();
    }
  });

  test("a config change is picked up on a later cycle", async () => {
    // worker-1 is live from the start; worker-2 joins later in the test.
    const w1 = await srv.session(token, "worker-1");
    void w1;
    const ctl = await startWith([{ name: "research", members: [member(1)] }]);
    try {
      const { statusBoard } = boardsFor("research");
      await until(async () => {
        const r = await bus.readBoard(statusBoard);
        return r.posts.some((p) => p.body.includes("1/1 members online"));
      }, 15_000, "the first member's summary");
      writeConfig([{ name: "research", members: [member(1), member(2)] }]);
      await until(async () => {
        const r = await bus.readBoard(statusBoard);
        return r.posts.some((p) => p.body.includes("1/2 members online"));
      }, 15_000, "the added member to appear in the summary");
    } finally {
      ctl.stop();
    }
  });
});
