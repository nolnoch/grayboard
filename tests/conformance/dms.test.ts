// Conformance: direct messages (#926), in every mode.
import { expect } from "bun:test";
import { conformance, type Context } from "./scenario.ts";

const unanswered = async ({ ok, peers }: Context, who: string) => (ok(await peers[who]!.call("dm_inbox")).unanswered ?? []) as any[];
// A known name nobody holds: `qa` creates and releases it, so a DM to it queues undelivered. `qa` does the
// juggling, not a scenario's main peers (#953: a hosted bind or unbind drops the binder's presence).
const spare = async ({ ok, peers }: Context) => {
  ok(await peers.qa!.call("bind", { name: "spare", create: true }));
  ok(await peers.qa!.call("unbind", { name: "spare" }));
};

conformance("dms", [
  {
    name: "a sent DM is listed in the recipient's inbox as unanswered",
    peers: ["be", "fe"],
    async run(ctx) {
      const { ok, peers } = ctx;
      const sent = ok(await peers.be!.call("dm_send", { to: "fe", body: "schema is ready" }));
      expect(sent.message_id).toBeNumber();
      expect(await unanswered(ctx, "fe")).toMatchObject([{ id: sent.message_id, from: "be", body: "schema is ready" }]);
      expect(await unanswered(ctx, "be")).toEqual([]);
    },
  },
  {
    name: "dm_ack drops a DM from the recipient's inbox",
    peers: ["be", "fe"],
    async run(ctx) {
      const { ok, peers } = ctx;
      const sent = ok(await peers.be!.call("dm_send", { to: "fe", body: "fyi" }));
      ok(await peers.fe!.call("dm_ack", { message_id: sent.message_id }));
      expect(await unanswered(ctx, "fe")).toEqual([]);
    },
  },
  {
    name: "a reply in the thread answers the DM",
    peers: ["be", "fe"],
    async run(ctx) {
      const { ok, peers } = ctx;
      const sent = ok(await peers.be!.call("dm_send", { to: "fe", body: "can you review?" }));
      const reply = ok(await peers.fe!.call("dm_send", { to: "be", body: "on it", parent_id: sent.message_id }));
      expect(await unanswered(ctx, "fe")).toEqual([]);
      expect(await unanswered(ctx, "be")).toMatchObject([{ id: reply.message_id, from: "fe", body: "on it" }]);
    },
  },
  {
    name: "dm_thread returns the whole thread in id order",
    peers: ["be", "fe"],
    async run(ctx) {
      const { ok, peers } = ctx;
      const first = ok(await peers.be!.call("dm_send", { to: "fe", body: "one" }));
      const second = ok(await peers.fe!.call("dm_send", { to: "be", body: "two", parent_id: first.message_id }));
      for (const who of ["be", "fe"]) {
        const thread = ok(await peers[who]!.call("dm_thread", { thread: second.message_id }));
        expect(thread).toMatchObject([
          { id: first.message_id, sender: "be", recipient: "fe", body: "one", parent_id: null },
          { id: second.message_id, sender: "fe", recipient: "be", body: "two", parent_id: first.message_id },
        ]);
      }
    },
  },
  {
    name: "dm_ack of a message that isn't yours is refused not_found and acks nothing",
    peers: ["be", "fe"],
    async run(ctx) {
      const { ok, refused, peers } = ctx;
      const sent = ok(await peers.be!.call("dm_send", { to: "fe", body: "keep me" }));
      refused(await peers.fe!.call("dm_ack", { message_id: sent.message_id + 1000 }), "not_found");
      // be sent it, so be can't ack it away from fe.
      refused(await peers.be!.call("dm_ack", { message_id: sent.message_id }), "not_found");
      expect(await unanswered(ctx, "fe")).toMatchObject([{ id: sent.message_id }]);
    },
  },
  {
    name: "a DM to an unknown handle is refused and delivers nothing",
    peers: ["be", "fe"],
    async run(ctx) {
      const { refused, peers } = ctx;
      refused(await peers.be!.call("dm_send", { to: "nobody-here", body: "lost" }), "not_found");
      expect(await unanswered(ctx, "fe")).toEqual([]);
    },
  },
  {
    name: "a pending DM is listed as the sender's promise until the sender writes again in the thread",
    peers: ["be", "fe"],
    async run(ctx) {
      const { ok, peers } = ctx;
      const sent = ok(await peers.be!.call("dm_send", { to: "fe", body: "will report back", pending: true }));
      const promised = () => peers.be!.call("dm_inbox").then(o => (ok(o).promised ?? []) as any[]);
      expect(await promised()).toMatchObject([{ id: sent.message_id }]);
      ok(await peers.be!.call("dm_send", { to: "fe", body: "done", parent_id: sent.message_id }));
      expect(await promised()).toEqual([]);
    },
  },
  {
    name: "dm_retract withdraws an undelivered DM: its next holder never sees it, and a second retract is ok",
    peers: ["be", "qa"],
    async run(ctx) {
      const { ok, peers } = ctx;
      await spare(ctx);
      const sent = ok(await peers.be!.call("dm_send", { to: "spare", body: "never mind" }));
      expect(sent.delivered_now).toBe(false);
      // Success values differ by mode (local "ok", hosted {}); only success is common.
      ok(await peers.be!.call("dm_retract", { message_id: sent.message_id }));
      ok(await peers.be!.call("dm_retract", { message_id: sent.message_id }));
      ok(await peers.qa!.call("bind", { name: "spare" }));
      expect((await unanswered(ctx, "qa")).filter(m => m.id === sent.message_id)).toEqual([]);
    },
  },
  {
    name: "dm_retract of another sender's DM is refused not_found and withdraws nothing",
    peers: ["be", "fe", "qa"],
    async run(ctx) {
      const { ok, refused, peers } = ctx;
      await spare(ctx);
      const sent = ok(await peers.be!.call("dm_send", { to: "spare", body: "keep me" }));
      refused(await peers.fe!.call("dm_retract", { message_id: sent.message_id }), "not_found");
      ok(await peers.qa!.call("bind", { name: "spare" }));
      expect((await unanswered(ctx, "qa")).filter(m => m.id === sent.message_id)).toMatchObject([{ from: "be", body: "keep me" }]);
    },
  },
  {
    name: "dm_retract of a DM that already reached its recipient is refused, and the DM stays",
    peers: ["be", "fe"],
    async run(ctx) {
      const { ok, refused, peers } = ctx;
      const sent = ok(await peers.be!.call("dm_send", { to: "fe", body: "too late" }));
      refused(await peers.be!.call("dm_retract", { message_id: sent.message_id }), "bad_request");
      expect(await unanswered(ctx, "fe")).toMatchObject([{ id: sent.message_id }]);
    },
  },
]);
