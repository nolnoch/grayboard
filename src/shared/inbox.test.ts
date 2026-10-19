import { expect, test } from "bun:test";

import { promised, showPending, unanswered } from "./inbox.ts";

const msg = (id: number, sender: string, recipient: string, parent_id: number | null = null) =>
  ({ id, sender, recipient, body: `m${id}`, parent_id, created_at: 0 });

test("a promise stands until the promiser's next message in the thread", () => {
  const thread = [msg(1, "fe", "be"), msg(2, "be", "fe", 1), msg(3, "fe", "be", 2), msg(4, "be", "fe", 3)];
  const threadOf = () => thread;
  // be promised in 2; fe's reply in 3 doesn't keep it, be's 4 does.
  expect(promised("be", [thread[1]!], () => thread.slice(0, 3), 0)).toEqual([
    { id: 2, to: "fe", parent_id: 1, age: "0m", body: "m2" },
  ]);
  expect(promised("be", [thread[1]!], threadOf, 0)).toEqual([]);
  // A later pending message supersedes the earlier one: only the latest stands.
  expect(promised("be", [thread[1]!, thread[3]!], threadOf, 0).map((p) => p.id)).toEqual([4]);
  // unanswered is the same rule from the other side.
  expect(unanswered("be", [thread[2]!], threadOf, 0)).toEqual([]);
});

test("rows show pending only when it's set", () => {
  expect(showPending({ id: 1, pending: 0 })).toEqual({ id: 1 });
  expect(showPending({ id: 1, pending: 1 })).toEqual({ id: 1, pending: true });
});
