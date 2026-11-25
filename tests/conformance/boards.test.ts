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
  {
    name: "a repeat of a create (#254) answers the board again; a different purpose is refused",
    peers: ["be"],
    async run(ctx) {
      const { ok, refused, peers } = ctx;
      const first = await create(ctx);
      const again = ok(await peers.be!.call("board_create", { name: "#E2E", purpose: " tests " }));
      expect(again).toMatchObject({ name: "e2e", created_by: "be" });
      expect(JSON.stringify(again)).toContain(String(first.created_at));
      refused(await peers.be!.call("board_create", { name: "e2e", purpose: "other" }), "bad_request");
      expect(await boards(ctx, "be")).toMatchObject([{ name: "e2e", purpose: "tests" }]);
    },
  },
  {
    name: "archiving twice answers the first archive; a reopen lists the board again, and a second reopen changes nothing",
    peers: ["be", "fe"],
    async run(ctx) {
      const { ok, peers } = ctx;
      await create(ctx);
      const archived = ok(await peers.be!.call("board_archive", { board: "e2e" }));
      expect(archived.archived_by).toBe("be");
      const repeat = ok(await peers.be!.call("board_archive", { board: "e2e" }));
      expect(repeat).toMatchObject({ archived_at: archived.archived_at, archived_by: "be" });
      expect(repeat.note).toBeString();
      expect(await boards(ctx, "fe")).toEqual([]);
      const reopened = ok(await peers.be!.call("board_archive", { board: "e2e", archived: false }));
      expect(reopened.archived_at ?? null).toBeNull();
      expect(await boards(ctx, "fe")).toMatchObject([{ name: "e2e" }]);
      const again = ok(await peers.be!.call("board_archive", { board: "e2e", archived: false }));
      expect(again.note).toBeString();
      expect(await boards(ctx, "fe")).toMatchObject([{ name: "e2e" }]);
    },
  },
  {
    name: "a muted thread's replies stop notifying the muter, an @mention still does, and unmuting restores them",
    peers: ["be", "fe"],
    async run(ctx) {
      const { ok, refused, peers } = ctx;
      await create(ctx);
      const root = ok(await peers.fe!.call("board_post", { board: "e2e", body: "root" }));
      const reply = (body: string) => peers.be!.call("board_post", { board: "e2e", body, parent_id: root.post_id });
      expect(ok(await reply("first"))).toMatchObject({ notified: ["fe"] });
      // Named by any post in the thread.
      const first = ok(await peers.be!.call("board_read", { board: "e2e", thread: root.post_id })).posts.at(-1).id;
      ok(await peers.fe!.call("board_subscribe", { board: "e2e", mode: "off", thread: first }));
      expect(ok(await reply("second")).notified).toEqual([]);
      expect(ok(await reply("third @fe")).notified).toEqual(["fe"]);
      // A thread mode other than off or push is refused and leaves the mute.
      refused(await peers.fe!.call("board_subscribe", { board: "e2e", mode: "digest", thread: root.post_id }), "bad_request");
      expect(ok(await reply("fourth")).notified).toEqual([]);
      ok(await peers.fe!.call("board_subscribe", { board: "#E2E", mode: "push", thread: root.post_id }));
      expect(ok(await reply("fifth")).notified).toEqual(["fe"]);
      // fe's board subscription is untouched by the thread's mute.
      expect(await boards(ctx, "fe")).toMatchObject([{ name: "e2e", mode: null }]);
    },
  },
  {
    name: "peer_status with a bad queue value is refused and sets no status",
    peers: ["be"],
    async run(ctx) {
      const { ok, refused, peers } = ctx;
      // Hosted refuses this at the input schema, local in the tool; both answer bad_request (#1220).
      refused(await peers.be!.call("peer_status", { text: "busy", queue: "maybe" }), "bad_request");
      const me = (ok(await peers.be!.call("peer_list")) as any).peers.find((p: any) => p.handle === "be");
      expect(me?.status ?? null).toBeNull();
      ok(await peers.be!.call("peer_status", { text: "busy" }));
      expect((ok(await peers.be!.call("peer_list")) as any).peers.find((p: any) => p.handle === "be")).toMatchObject({ status: "busy" });
    },
  },
  {
    name: "a post naming an @id: no session holds is refused and adds nothing",
    peers: ["be", "fe"],
    async run(ctx) {
      const { ok, refused, peers } = ctx;
      await create(ctx);
      refused(await peers.be!.call("board_post", { board: "e2e", body: "hi @id:0000000000000" }), "not_found");
      expect(ok(await peers.fe!.call("board_read", { board: "e2e" })).posts).toEqual([]);
    },
  },
]);
