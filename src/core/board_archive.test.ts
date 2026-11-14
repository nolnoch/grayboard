// #635: a board's creator (or the user) archives it: it leaves board_list,
// refuses new top-level posts, and stays readable by name.
import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";

import {
  archiveBoard,
  boardCatalog,
  createBoard,
  declareHuman,
  ensureAlias,
  ensureBoard,
  getBoard,
  listBoards,
  post,
  read,
  subscribe,
  touchAlias,
} from "./boards.ts";
import { callBoardTool } from "./tools.ts";
import { claim, listClaims, release, sweepExpired } from "./claims.ts";
import { initCoreSchema } from "./schema.ts";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  initCoreSchema(db);
  for (const h of ["be", "sim", "fe"]) {
    ensureAlias(db, h, "test");
    touchAlias(db, h);
  }
  createBoard(db, "be", "task-1", "One fan-out task");
  subscribe(db, "sim", "task-1", "push");
});

const names = (h: string) => listBoards(db, [h]).map((b) => b.name);
const tool = (h: string, name: string, args: Record<string, unknown>, ctx = {}) => callBoardTool(db, h, name, args, ctx).result as Record<string, unknown>;

test("an archived board leaves board_list, refuses top-level posts, and is read and replied to by name", () => {
  const root = post(db, "sim", "task-1", "first").post.id;
  expect(names("sim")).toContain("task-1");

  const archived = tool("be", "board_archive", { board: "#task-1" });
  expect(archived.name).toBe("task-1");
  expect(archived.archived_by).toBe("be");
  expect(typeof archived.archived_at).toBe("number");
  expect(names("sim")).not.toContain("task-1");
  expect(listBoards(db, () => true).map((b) => b.name)).not.toContain("task-1");

  expect(() => tool("sim", "board_post", { board: "task-1", body: "new work" })).toThrow(/#task-1 is archived; reply in one of its threads/);
  const reply = post(db, "sim", "task-1", "done", root);
  expect(reply.wake).toEqual(["be"]);
  expect(read(db, "be", "task-1", { before_id: 999 }).posts.map((p) => p.body)).toEqual(["first", "done"]);
  // The catalog still lists it, marked.
  expect(boardCatalog(db, "sim").boards.find((b) => b.name === "task-1")?.archived_by).toBe("be");
});

test("open boards carry no archive keys; reopening clears them and takes top-level posts again", () => {
  expect(Object.keys(getBoard(db, "task-1")!)).not.toContain("archived_at");
  expect(Object.keys(listBoards(db, ["sim"])[0]!)).not.toContain("archived_at");
  expect(Object.keys(tool("be", "board_create", { name: "other", purpose: "p" }))).not.toContain("archived_at");

  tool("be", "board_archive", { board: "task-1" });
  const reopened = tool("be", "board_archive", { board: "task-1", archived: false });
  expect(Object.keys(reopened)).not.toContain("archived_at");
  expect(names("sim")).toContain("task-1");
  expect(post(db, "sim", "task-1", "back").wake).toEqual(["be"]);
});

test("a repeat is answered from state, and changes nothing", () => {
  const first = callBoardTool(db, "be", "board_archive", { board: "task-1" });
  expect(first.boards).toEqual(["task-1"]);
  const again = callBoardTool(db, "be", "board_archive", { board: "task-1" });
  expect(again.boards).toBeUndefined();
  expect((again.result as { note: string }).note).toMatch(/^#task-1 was already archived at \S+ by be$/);
  expect((again.result as { archived_at: number }).archived_at).toBe((first.result as { archived_at: number }).archived_at);
  tool("be", "board_archive", { board: "task-1", archived: false });
  expect(tool("be", "board_archive", { board: "task-1", archived: false }).note).toBe("#task-1 isn't archived");
});

test("only the creator, by any of its addresses, or the user archives or reopens", () => {
  expect(() => tool("sim", "board_archive", { board: "task-1" })).toThrow(/only #task-1's creator \(be\) or your user/);
  expect(tool("sim", "board_archive", { board: "task-1" }, { addresses: ["sim", "be"] }).archived_by).toBe("sim");
  expect(() => tool("fe", "board_archive", { board: "task-1", archived: false })).toThrow(/only #task-1's creator/);
  // The Slack bridge's human, and a declared human handle.
  expect(tool("fe", "board_archive", { board: "task-1", archived: false }, { human: true }).name).toBe("task-1");
  declareHuman(db, "wade");
  expect(tool("wade", "board_archive", { board: "task-1" }).archived_by).toBe("wade");
});

test("a mode's own boards never archive, and an unseen board reads as missing", () => {
  ensureBoard(db, "announce", "announcements", null, "grayboard");
  declareHuman(db, "wade");
  expect(() => archiveBoard(db, "wade", "announce", true)).toThrow(/#announce belongs to the bus itself/);
  ensureBoard(db, "core", "Team core", "team:core", "be");
  expect(() => archiveBoard(db, "be", "core", true)).toThrow(/#core belongs to the bus itself/);
  expect(() => archiveBoard(db, "be", "nope", true)).toThrow(/no such board #nope/);
});

test("board_create on an archived name says so, including its same-arguments repeat", () => {
  tool("be", "board_archive", { board: "task-1" });
  expect(() => tool("be", "board_create", { name: "task-1", purpose: "One fan-out task" })).toThrow(/#task-1 already exists, archived; board_archive\(board, false\) reopens it/);
  expect(() => tool("fe", "board_create", { name: "task-1", purpose: "x" })).toThrow(/already exists, archived/);
});

test("a new claim can't announce on an archived board; one already there still releases and expires on it", () => {
  claim(db, "be", "lane:a", { board: "task-1" });
  claim(db, "be", "lane:b", { board: "task-1" });
  tool("be", "board_archive", { board: "task-1" });

  expect(() => claim(db, "fe", "lane:c", { board: "task-1" })).toThrow(/#task-1 is archived/);
  expect(listClaims(db).map((c) => c.key)).toEqual(["lane:a", "lane:b"]);

  expect(release(db, "be", "lane:a").wake).toContain("sim");
  db.prepare(`UPDATE claims SET expires_at = 1 WHERE key = 'lane:b'`).run();
  expect(sweepExpired(db).wake).toContain("sim");
  expect(read(db, "sim", "task-1", { before_id: 999 }).posts.map((p) => p.body)).toEqual([
    "[claim] lane:a",
    "[claim] lane:b",
    "[release] lane:a",
    "[expired] lane:b: not released by be; check with them before relying on it",
  ]);
});

test("an archived queue board takes no new work; a live delivery still acks by reply", () => {
  createBoard(db, "be", "q", "work", null, { kind: "queue" });
  subscribe(db, "sim", "q", "push");
  const work = post(db, "be", "q", "job").post.id;
  expect(listClaims(db).map((c) => c.holder)).toEqual(["sim"]);
  tool("be", "board_archive", { board: "q" });
  expect(() => post(db, "be", "q", "job 2")).toThrow(/#q is archived/);
  post(db, "sim", "q", "done", work);
  expect(listClaims(db)).toEqual([]);
});

test("a database from before #635 gains the columns, and its boards read as open", () => {
  const old = new Database(":memory:");
  old.exec(`CREATE TABLE boards (name TEXT PRIMARY KEY, purpose TEXT NOT NULL, scope TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'broadcast')`);
  old.exec(`INSERT INTO boards VALUES ('legacy', 'p', NULL, 'be', 1, 'broadcast')`);
  initCoreSchema(old);
  initCoreSchema(old);
  const cols = (old.prepare(`PRAGMA table_info(boards)`).all() as { name: string }[]).map((c) => c.name);
  expect(cols).toEqual(expect.arrayContaining(["archived_at", "archived_by"]));
  expect(getBoard(old, "legacy")).toEqual({ name: "legacy", purpose: "p", scope: null, created_by: "be", created_at: 1, kind: "broadcast" });
});
