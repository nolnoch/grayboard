// The `<channel>` renderer and the wake rule (#430), over the notifications
// core builds for the server's inbox items.
import { expect, test } from "bun:test";
import { render, wakes } from "../src/channel.ts";
import { boardNotification, dmNotification } from "../../../src/core/tools.ts";
import type { Post } from "../../../src/core/boards.ts";

const post: Post = { id: 7, board: "e2e", author: "you@example.com/fe", body: "ship it", parent_id: 3, created_at: 1700000000000 };

test("render gives the shape pi and omp show, escaping &, \" and < in attribute values only", () => {
  expect(render({ content: "hello <b> & \"you\"", meta: { from: "a&b \"c\" <d>", message_id: "12" } }, "grayboard")).toBe(
    `<channel source="grayboard" from="a&amp;b &quot;c&quot; &lt;d>" message_id="12">\nhello <b> & "you"\n</channel>`,
  );
  expect(render({ content: "no meta" }, "grayboard-pi")).toBe(`<channel source="grayboard-pi">\nno meta\n</channel>`);
  // Attribute order is the meta's own, as core builds it.
  const dm = dmNotification({ id: 41, sender: "you@example.com/be", body: "hi", parent_id: null, created_at: 1700000000000 });
  expect(render(dm, "grayboard")).toBe(`<channel source="grayboard" message_id="41" from="you@example.com/be" created_at="1700000000000">\nhi\n</channel>`);
});

test("the wake rule: actionable items wake; digests and deferred thread replies never do", () => {
  // The server's actionable flag (src/server/delivery.ts): direct and
  // non-deferred push items are actionable; deferred pushes and digests aren't.
  const direct = dmNotification({ id: 1, sender: "you@example.com/be", body: "act", parent_id: null, created_at: 1 });
  const push = boardNotification({ kind: "push", reason: "mention", post });
  const deferred = boardNotification({ kind: "push", reason: "thread", post, deferred: true });
  const digest = boardNotification({ kind: "digest", board: "e2e", unread: 2, latest: post });
  expect(deferred.meta.deferred).toBe("true");
  expect(digest.meta.kind).toBe("digest");
  expect([wakes(true, direct.meta), wakes(true, push.meta), wakes(false, deferred.meta), wakes(false, digest.meta)]).toEqual([true, true, false, false]);
  // The meta decides even when the flag disagrees: a digest or a deferred
  // reply is context only.
  expect([wakes(true, digest.meta), wakes(true, deferred.meta), wakes(false, push.meta), wakes(true)]).toEqual([false, false, false, true]);
});
