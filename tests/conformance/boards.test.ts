// Conformance: boards (#926), in every mode. No board exists by default (local's built-in #announce aside, which
// the list reads filter out), so each scenario creates its own.
import { expect } from "bun:test";
import { conformance, type Context } from "./scenario.ts";

const create = async ({ ok, peers }: Context, who = "be", name = "e2e") =>
  ok(await peers[who]!.call("board_create", { name, purpose: "tests" }));
const boards = async ({ ok, peers }: Context, who: string) =>
  (ok(await peers[who]!.call("board_list")) as any[]).filter(b => b.name !== "announce");

conformance("boards", [
  {
    name: "board_create makes a board every session lists, with its creator and purpose",
    peers: ["be", "fe"],
    async run(ctx) {
      expect(await create(ctx)).toMatchObject({ name: "e2e", purpose: "tests", created_by: "be", kind: "broadcast" });
      expect(await boards(ctx, "fe")).toMatchObject([{ name: "e2e", purpose: "tests", created_by: "be", posts: 0 }]);
    },
  },
  {
    name: "board_create of an existing name or an invalid name creates nothing",
    peers: ["be"],
    async run(ctx) {
      const { refused, peers } = ctx;
      await create(ctx);
      refused(await peers.be!.call("board_create", { name: "e2e", purpose: "again" }), "bad_request");
      refused(await peers.be!.call("board_create", { name: "Bad Name", purpose: "x" }), "bad_request");
      expect(await boards(ctx, "be")).toMatchObject([{ name: "e2e", purpose: "tests" }]);
    },
  },
  {
    name: "a post to a board that doesn't exist is refused",
    peers: ["be"],
    async run(ctx) {
      const { refused, peers } = ctx;
      refused(await peers.be!.call("board_post", { board: "e2e", body: "nope" }), "bad_request");
      expect(await boards(ctx, "be")).toEqual([]);
    },
  },
  {
    name: "board_post notifies the mentioned peer, a reply notifies the author, and both read back in order",
    peers: ["be", "fe"],
    async run(ctx) {
      const { ok, peers } = ctx;
      await create(ctx);
      const top = ok(await peers.be!.call("board_post", { board: "e2e", body: "hello @fe" }));
      expect(top).toMatchObject({ board: "e2e", notified: ["fe"] });
      // "#e2e" and "e2e" name the same board.
      const reply = ok(await peers.fe!.call("board_post", { board: "#e2e", body: "reply", parent_id: top.post_id }));
      expect(reply).toMatchObject({ board: "e2e", notified: ["be"] });
      const read = ok(await peers.fe!.call("board_read", { board: "e2e" }));
      expect(read.posts).toMatchObject([
        { id: top.post_id, author: "be", body: "hello @fe", parent_id: null },
        { id: reply.post_id, author: "fe", body: "reply", parent_id: top.post_id },
      ]);
      expect(await boards(ctx, "be")).toMatchObject([{ name: "e2e", posts: 2 }]);
    },
  },
  {
    name: "a reply to a post that isn't on the board is refused and adds nothing",
    peers: ["be"],
    async run(ctx) {
      const { ok, refused, peers } = ctx;
      await create(ctx);
      refused(await peers.be!.call("board_post", { board: "e2e", body: "orphan", parent_id: 999 }), "bad_request");
      expect(ok(await peers.be!.call("board_read", { board: "e2e" })).posts).toEqual([]);
    },
  },
  {
    name: "board_read with thread expands the whole thread from any post in it",
    peers: ["be", "fe"],
    async run(ctx) {
      const { ok, peers } = ctx;
      await create(ctx);
      const top = ok(await peers.be!.call("board_post", { board: "e2e", body: "root" }));
      ok(await peers.be!.call("board_post", { board: "e2e", body: "other" }));
      const reply = ok(await peers.fe!.call("board_post", { board: "e2e", body: "reply", parent_id: top.post_id }));
      const thread = ok(await peers.be!.call("board_read", { board: "e2e", thread: reply.post_id }));
      expect(thread.posts.map((p: any) => p.body)).toEqual(["root", "reply"]);
    },
  },
  {
    name: "board_subscribe sets the caller's mode on the board, and leaves the creator's push subscription alone",
    peers: ["be", "fe"],
    async run(ctx) {
      const { ok, peers } = ctx;
      await create(ctx);
      ok(await peers.fe!.call("board_subscribe", { board: "e2e", mode: "quiet" }));
      expect(await boards(ctx, "fe")).toMatchObject([{ name: "e2e", mode: "quiet" }]);
      expect(await boards(ctx, "be")).toMatchObject([{ name: "e2e", mode: "push" }]);
    },
  },
  {
    name: "only the board's creator archives it; the creator's archive drops it from the list",
    peers: ["be", "fe"],
    async run(ctx) {
      const { ok, refused, peers } = ctx;
      await create(ctx);
      refused(await peers.fe!.call("board_archive", { board: "e2e" }), "bad_request");
      expect(await boards(ctx, "fe")).toMatchObject([{ name: "e2e" }]);
      ok(await peers.be!.call("board_archive", { board: "e2e" }));
      expect(await boards(ctx, "fe")).toEqual([]);
    },
  },
]);
