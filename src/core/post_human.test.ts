// #1355: a post's human mark is recorded on its row when written, not worked out at delivery from whether its
// author is the declared human now.
import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";

import { createBoard, declareHuman, ensureAlias, markDelivered, pendingFor, post, postHuman, subscribe, touchAlias } from "./boards.ts";
import type { Pending } from "../shared/notifications.ts";
import { callBoardTool } from "./tools.ts";
import { initCoreSchema } from "./schema.ts";

let db: Database;

const seen = (h: string) => {
  ensureAlias(db, h, "test");
  touchAlias(db, h);
};

const pushes = (h: string): Extract<Pending, { kind: "push" }>[] => {
  const items = pendingFor(db, h, { all: true });
  for (const i of items) markDelivered(db, h, i);
  return items.filter((i): i is Extract<Pending, { kind: "push" }> => i.kind === "push");
};

const stored = (id: number) => (db.prepare(`SELECT human FROM posts WHERE id = ?`).get(id) as { human: number | null }).human;

beforeEach(() => {
  db = new Database(":memory:");
  initCoreSchema(db);
  for (const h of ["be", "fe", "alex"]) seen(h);
  createBoard(db, "be", "#e2e", "End-to-end fixtures and runs");
  subscribe(db, "be", "e2e", "push");
});

test("a handle declared human after it wrote never marks its own post or a claim's system post", () => {
  const own = callBoardTool(db, "fe", "board_post", { board: "e2e", body: "selector ready" });
  callBoardTool(db, "fe", "claim_take", { key: "ticket:ENG-142", board: "e2e" });
  callBoardTool(db, "fe", "claim_release", { key: "ticket:ENG-142" });
  declareHuman(db, "fe");

  const got = pushes("be");
  expect(got.map((p) => p.post.body)).toEqual(["selector ready", "[claim] ticket:ENG-142", "[release] ticket:ENG-142"]);
  for (const p of got) {
    expect(p.post.author).toBe("fe");
    expect(stored(p.post.id)).toBe(0);
    expect(postHuman(db, p.post)).toBe(false);
  }
  expect((own.result as { post_id: number }).post_id).toBe(got[0]!.post.id);
});

test("a declared human's own words stay marked, even once another handle is declared", () => {
  declareHuman(db, "alex");
  const r = post(db, "alex", "e2e", "merge it", null, { strictIds: true });
  expect(stored(r.post.id)).toBe(1);
  declareHuman(db, "fe");
  expect(postHuman(db, r.post)).toBe(true);
});

test("a system post written as the declared human's handle is never marked", () => {
  declareHuman(db, "alex");
  const r = post(db, "alex", "e2e", "[release] ticket:ENG-142");
  expect(stored(r.post.id)).toBe(0);
  expect(postHuman(db, r.post)).toBe(false);
});

test("a row from before the column (null) keeps today's rule: its author is the declared human now", () => {
  const r = post(db, "fe", "e2e", "older", null, { strictIds: true });
  db.prepare(`UPDATE posts SET human = NULL WHERE id = ?`).run(r.post.id);
  expect(postHuman(db, r.post)).toBe(false);
  declareHuman(db, "fe");
  expect(postHuman(db, r.post)).toBe(true);
});
