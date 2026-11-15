// Conformance: names and presence (#926): bind, unbind, whoami, peer_list, in every mode.
import { expect } from "bun:test";
import { conformance, type Context } from "./scenario.ts";

// The names a session holds. Local `whoami` says `aliases` where hosted says `held` (#489); the scenarios assert
// the set, not the field name, until that converges.
const held = async ({ ok, peers }: Context, who: string): Promise<string[]> => {
  const v = ok(await peers[who]!.call("whoami"));
  return v.aliases ?? v.held;
};
const handles = async ({ ok, peers }: Context, who: string) =>
  (ok(await peers[who]!.call("peer_list")).peers as any[]).map(p => p.handle).sort();

conformance("identity", [
  {
    name: "whoami names the session's bound name as its primary",
    peers: ["be"],
    async run(ctx) {
      const v = ctx.ok(await ctx.peers.be!.call("whoami"));
      expect(v).toMatchObject({ primary: "be" });
      expect(v.id).toMatch(/^id:/);
      expect(await held(ctx, "be")).toEqual(["be"]);
    },
  },
  {
    name: "peer_list shows every live session, with the caller marked self",
    peers: ["be", "fe"],
    async run(ctx) {
      const v = ctx.ok(await ctx.peers.be!.call("peer_list"));
      expect(v.you).toBe("be");
      expect(v.peers.find((p: any) => p.handle === "be")).toMatchObject({ online: true, self: true });
      expect(v.peers.find((p: any) => p.handle === "fe")).toMatchObject({ online: true });
      expect(v.peers.find((p: any) => p.handle === "fe").self).toBeFalsy();
    },
  },
  {
    name: "bind of a never-used name needs create; without it nothing is bound",
    peers: ["be"],
    async run(ctx) {
      ctx.refused(await ctx.peers.be!.call("bind", { name: "be-alt" }), "identity_unknown");
      expect(await held(ctx, "be")).toEqual(["be"]);
    },
  },
  {
    name: "bind with create adds a name: the session holds both and still sends as the first",
    peers: ["be"],
    async run(ctx) {
      ctx.ok(await ctx.peers.be!.call("bind", { name: "be-alt", create: true }));
      expect(await held(ctx, "be")).toEqual(["be", "be-alt"]);
      expect(ctx.ok(await ctx.peers.be!.call("whoami")).primary).toBe("be");
    },
  },
  {
    name: "after a bind, other sessions see both of the binder's names online",
    peers: ["be", "fe"],
    async run(ctx) {
      ctx.ok(await ctx.peers.be!.call("bind", { name: "be-alt", create: true }));
      expect(await handles(ctx, "fe")).toEqual(["be", "be-alt", "fe"]);
    },
  },
  {
    name: "a name another live session holds can't be bound",
    peers: ["be", "fe"],
    async run(ctx) {
      ctx.ok(await ctx.peers.be!.call("bind", { name: "be-alt", create: true }));
      ctx.refused(await ctx.peers.fe!.call("bind", { name: "be-alt" }), "alias_held");
      expect(await held(ctx, "fe")).toEqual(["fe"]);
      expect(await held(ctx, "be")).toEqual(["be", "be-alt"]);
    },
  },
  {
    name: "unbind releases a name for another session to bind",
    peers: ["be", "fe"],
    async run(ctx) {
      ctx.ok(await ctx.peers.be!.call("bind", { name: "be-alt", create: true }));
      ctx.ok(await ctx.peers.be!.call("unbind", { name: "be-alt" }));
      expect(await held(ctx, "be")).toEqual(["be"]);
      ctx.ok(await ctx.peers.fe!.call("bind", { name: "be-alt" }));
      expect(await held(ctx, "fe")).toEqual(["fe", "be-alt"]);
    },
  },
  {
    name: "unbind of a name the session doesn't hold changes nothing",
    peers: ["be"],
    async run(ctx) {
      ctx.ok(await ctx.peers.be!.call("unbind", { name: "be-alt" }));
      expect(await held(ctx, "be")).toEqual(["be"]);
    },
  },
  {
    name: "unbinding the only name leaves the session unbound, holding nothing",
    peers: ["be"],
    async run(ctx) {
      ctx.ok(await ctx.peers.be!.call("unbind", { name: "be" }));
      // Past this the modes differ on purpose (handles.md: local acts as its ID with the full surface; hosted MCP
      // reads only, primary null), so only the held set is common.
      expect(await held(ctx, "be")).toEqual([]);
    },
  },
]);
