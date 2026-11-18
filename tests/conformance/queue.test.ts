// Conformance: queue boards (#807 B5b2), in every mode. A queue board hands each top-level post to one lane, which
// holds it as a `queue:<board>:<post>` claim until it replies.
import { expect } from "bun:test";
import { conformance, type Context } from "./scenario.ts";
import { until } from "../support/until.ts";

// `be` makes a queue board; `fe` and `sim` subscribe as its lanes. The creator's own subscription is never a lane
// for its own posts.
async function queueBoard({ ok, peers }: Context): Promise<void> {
  ok(await peers.be!.call("board_create", { name: "work", purpose: "tests", kind: "queue" }));
  for (const lane of ["fe", "sim"]) ok(await peers[lane]!.call("board_subscribe", { board: "work", mode: "push" }));
}
const queueClaims = async ({ ok, peers }: Context, who: string) => {
  const v = ok(await peers[who]!.call("claim_list"));
  return ((Array.isArray(v) ? v : v.claims) as any[]).filter((c) => c.key.startsWith("queue:"));
};
// The rotation orders lanes by when each was last handed work, in ms: let the clock move past `t` before the next post.
const tick = (t: number) => until(() => Date.now() > t, 1000, "a new millisecond");

conformance("queue", [
  {
    name: "a mention hands the post to that lane; the rotation then picks the least recently woken lane",
    peers: ["be", "fe", "sim"],
    async run(ctx) {
      const { ok, peers } = ctx;
      await queueBoard(ctx);
      // #219: one agent named by the author holds the post as a rotated lane would.
      const named = ok(await peers.be!.call("board_post", { board: "work", body: "@sim take this" }));
      expect(named.notified).toEqual(["sim"]);
      expect(await queueClaims(ctx, "be")).toMatchObject([{ key: `queue:work:${named.post_id}`, holder: "sim" }]);
      await tick(Date.now());
      // fe was never woken, so it goes first; then sim, woken before fe was. By name alone it would be fe twice.
      const second = ok(await peers.be!.call("board_post", { board: "work", body: "next" }));
      expect(second.notified).toEqual(["fe"]);
      await tick(Date.now());
      const third = ok(await peers.be!.call("board_post", { board: "work", body: "and next" }));
      expect(third.notified).toEqual(["sim"]);
      expect((await queueClaims(ctx, "be")).map((c) => [c.key, c.holder]).sort()).toEqual([
        [`queue:work:${named.post_id}`, "sim"],
        [`queue:work:${second.post_id}`, "fe"],
        [`queue:work:${third.post_id}`, "sim"],
      ].sort());
    },
  },
  {
    name: "the holder's reply acks its queue claim, and later posts still rotate",
    peers: ["be", "fe", "sim"],
    async run(ctx) {
      const { ok, peers } = ctx;
      await queueBoard(ctx);
      const first = ok(await peers.be!.call("board_post", { board: "work", body: "job" }));
      expect(first.notified).toEqual(["fe"]);
      // A reply follows thread semantics: it reaches the post's author, not the other lanes.
      expect(ok(await peers.fe!.call("board_post", { board: "work", body: "done", parent_id: first.post_id })).notified).toEqual(["be"]);
      expect(await queueClaims(ctx, "be")).toEqual([]);
      await tick(Date.now());
      expect(ok(await peers.be!.call("board_post", { board: "work", body: "job 2" })).notified).toEqual(["sim"]);
    },
  },
]);
