// Conformance: claims (#926), in every mode.
import { expect } from "bun:test";
import { conformance, type Context } from "./scenario.ts";
import { until } from "../support/until.ts";

const KEY = "ticket:ENG-142";
const listed = async ({ ok, peers }: Context, who: string) => {
  const v = ok(await peers[who]!.call("claim_list"));
  return ((Array.isArray(v) ? v : v.claims) as any[]).filter(c => c.key.startsWith("ticket:"));
};

// The bodies of a board's posts, oldest first.
const bodies = async ({ ok, peers }: Context, who: string, board: string, thread?: number) =>
  (ok(await peers[who]!.call("board_read", { board, ...(thread === undefined ? {} : { thread }) })).posts as any[]).map(p => p.body as string);
// `be` makes board `work`; `fe` joins it.
async function workBoard({ ok, peers }: Context, kind?: "queue"): Promise<void> {
  ok(await peers.be!.call("board_create", { name: "work", purpose: "tests", ...(kind ? { kind } : {}) }));
  ok(await peers.fe!.call("board_subscribe", { board: "work", mode: "push" }));
}

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
  {
    name: "a renew with a new note announces [update] and cc's the watchers; the same note posts nothing",
    peers: ["be", "fe"],
    async run(ctx) {
      const { ok, peers } = ctx;
      await workBoard(ctx);
      ok(await peers.be!.call("claim_take", { key: KEY, board: "work", note: "step 1" }));
      ok(await peers.fe!.call("claim_watch", { key: KEY }));
      expect(ok(await peers.be!.call("claim_take", { key: KEY, note: "step 2" }))).toMatchObject({ ok: true, renewed: true, claim: { note: "step 2", board: "work" } });
      ok(await peers.be!.call("claim_take", { key: KEY, note: "step 2" }));
      expect(await bodies(ctx, "be", "work")).toEqual([`[claim] ${KEY} — step 1`, `[update] ${KEY} — step 2 cc @fe`]);
    },
  },
  {
    name: "a release cc's the watchers once: the watch ends with the claim",
    peers: ["be", "fe", "sim"],
    async run(ctx) {
      const { ok, peers } = ctx;
      await workBoard(ctx);
      ok(await peers.be!.call("claim_take", { key: KEY, board: "work" }));
      ok(await peers.fe!.call("claim_watch", { key: KEY }));
      ok(await peers.be!.call("claim_release", { key: KEY, note: "done" }));
      ok(await peers.sim!.call("claim_take", { key: KEY, board: "work" }));
      ok(await peers.sim!.call("claim_release", { key: KEY }));
      expect(await bodies(ctx, "be", "work")).toEqual([`[claim] ${KEY}`, `[release] ${KEY} — done cc @fe`, `[claim] ${KEY}`, `[release] ${KEY}`]);
    },
  },
  {
    name: "a declined queue post goes to the next lane, and with none left stays [unclaimed]",
    peers: ["be", "fe", "sim"],
    async run(ctx) {
      const { ok, peers } = ctx;
      await workBoard(ctx, "queue");
      ok(await peers.sim!.call("board_subscribe", { board: "work", mode: "push" }));
      const job = ok(await peers.be!.call("board_post", { board: "work", body: "job" }));
      const key = `queue:work:${job.post_id}`;
      const holder = async () => ((ok(await peers.be!.call("claim_list")) as any[]).find(c => c.key === key))?.holder ?? null;
      expect(await holder()).toBe("fe");
      ok(await peers.fe!.call("claim_release", { key, note: "busy" }));
      expect(await holder()).toBe("sim");
      // A repeat whose first answer was lost succeeds: the release's redelivery is all that followed it (#254).
      expect(ok(await peers.fe!.call("claim_release", { key }))).toStartWith("already released by you");
      ok(await peers.sim!.call("claim_release", { key }));
      expect(await holder()).toBeNull();
      expect(await bodies(ctx, "be", "work", job.post_id)).toEqual([
        "job", `[unclaimed] ${key}: all 2 lanes passed on it, and no other lane is left; it stays here unclaimed`,
      ]);
    },
  },
  {
    name: "a lapsed claim is announced once, as [expired]",
    peers: ["be", "fe"],
    async run(ctx) {
      const { ok, peers } = ctx;
      await workBoard(ctx);
      const taken = ok(await peers.be!.call("claim_take", { key: KEY, board: "work", ttl_minutes: 0.001 }));
      await until(() => Date.now() > taken.claim.expires_at, 2000, "the claim's expiry");
      // A take sweeps first; the expiry timer may have swept already. Either way the lapse posts once.
      ok(await peers.fe!.call("claim_take", { key: "ticket:other" }));
      const expired = `[expired] ${KEY}: not released by be; check with them before relying on it`;
      await until(async () => (await bodies(ctx, "be", "work")).includes(expired), 5000, "the [expired] post");
      expect(await bodies(ctx, "be", "work")).toEqual([`[claim] ${KEY}`, expired]);
      expect((await listed(ctx, "be")).map(c => c.key)).toEqual(["ticket:other"]);
    },
  },
  {
    name: "claim_watch refuses a free key, your own claim and a claim without a board, and watches nothing",
    peers: ["be", "fe"],
    async run(ctx) {
      const { ok, refused, peers } = ctx;
      await workBoard(ctx);
      refused(await peers.fe!.call("claim_watch", { key: KEY }), "bad_request");
      ok(await peers.be!.call("claim_take", { key: KEY }));
      refused(await peers.be!.call("claim_watch", { key: KEY }), "bad_request");
      refused(await peers.fe!.call("claim_watch", { key: KEY }), "bad_request");
      // The refused watches left nothing: a release once the claim is on a board cc's nobody.
      ok(await peers.be!.call("claim_take", { key: KEY, board: "work" }));
      ok(await peers.be!.call("claim_release", { key: KEY }));
      expect(await bodies(ctx, "be", "work")).toEqual([`[release] ${KEY}`]);
    },
  },
]);
