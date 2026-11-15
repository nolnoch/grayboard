// Conformance: claims (#926), in every mode.
import { expect } from "bun:test";
import { conformance, type Context } from "./scenario.ts";

const KEY = "ticket:ENG-142";
const listed = async ({ ok, peers }: Context, who: string) => {
  const v = ok(await peers[who]!.call("claim_list"));
  return ((Array.isArray(v) ? v : v.claims) as any[]).filter(c => c.key.startsWith("ticket:"));
};

conformance("claims", [
  {
    name: "claim_take takes a free key, and the holder's second take renews it",
    peers: ["be"],
    async run(ctx) {
      const { ok, peers } = ctx;
      const first = ok(await peers.be!.call("claim_take", { key: KEY, note: "porting" }));
      expect(first).toMatchObject({ ok: true, renewed: false, claim: { key: KEY, holder: "be", note: "porting" } });
      const again = ok(await peers.be!.call("claim_take", { key: KEY }));
      expect(again).toMatchObject({ ok: true, renewed: true, claim: { key: KEY, holder: "be", acquired_at: first.claim.acquired_at } });
      expect(await listed(ctx, "be")).toMatchObject([{ key: KEY, holder: "be" }]);
    },
  },
  {
    name: "a key another session holds isn't taken: the answer names the holder",
    peers: ["be", "fe"],
    async run(ctx) {
      const { ok, peers } = ctx;
      ok(await peers.be!.call("claim_take", { key: KEY, note: "mine" }));
      // A held key is an answer, not an error, in every mode: the caller coordinates with the holder.
      expect(ok(await peers.fe!.call("claim_take", { key: KEY }))).toMatchObject({ ok: false, held_by: "be", note: "mine" });
      expect(await listed(ctx, "fe")).toMatchObject([{ key: KEY, holder: "be" }]);
    },
  },
  {
    name: "claim_release frees the key for another session",
    peers: ["be", "fe"],
    async run(ctx) {
      const { ok, peers } = ctx;
      ok(await peers.be!.call("claim_take", { key: KEY }));
      ok(await peers.be!.call("claim_release", { key: KEY }));
      expect(await listed(ctx, "be")).toEqual([]);
      expect(ok(await peers.fe!.call("claim_take", { key: KEY }))).toMatchObject({ ok: true, claim: { holder: "fe" } });
    },
  },
  {
    name: "claim_release of a key someone else holds releases nothing",
    peers: ["be", "fe"],
    async run(ctx) {
      const { ok, refused, peers } = ctx;
      ok(await peers.be!.call("claim_take", { key: KEY }));
      refused(await peers.fe!.call("claim_release", { key: KEY }), "bad_request");
      expect(await listed(ctx, "be")).toMatchObject([{ key: KEY, holder: "be" }]);
    },
  },
]);
