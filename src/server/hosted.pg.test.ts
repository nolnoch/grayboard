// #1479: hosted delivery's bind-generation fence across two server instances on one Postgres database. Each instance is
// its own pod as far as the fence goes: its own Repo (pool, write queue, auth LISTEN), Application, hosted sessions and
// delivery, so one instance's commit reaches the other's in-memory holders and leases only through that instance's own
// reads (its backstop reconcile, every RECONCILE_EVERY ticks), never through the committing instance's notices.
// hosted.test.ts's #1473 test pins the same refusal when the unbind runs on the lease's own instance. Without
// GRAYBOARD_TEST_PG_URL it skips.
import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppSession } from "../../tests/support/app_session.ts";
import { describePg, pgDatabase } from "../../tests/support/pg.ts";
import { seed } from "../../tests/support/seed.ts";
import { createApplication } from "./application.ts";
import { createDelivery } from "./delivery.ts";
import { createHostedSessions, sessionContext } from "./hosted.ts";
import { OPENCODE_CLIENT, OPENCODE_SESSION_META } from "./oauth-config.ts";
import type { OAuthPrincipal } from "./oauth.ts";
import { makePgRepo } from "./pg_repo.ts";

// Above the pool's 5 s lock_timeout (pg/tx.ts), so a broken lock fails on its own error, not on Bun's timeout.
setDefaultTimeout(30_000);

const ME = "you@example.com";

// One instance on `url`: the hosted MCP layer's composition (mcp.ts createHostedMcp) without its HTTP surface.
async function instance(url: string, side: string) {
  const blobDir = mkdtempSync(join(tmpdir(), "gb-pg-blobs-"));
  const repo = await makePgRepo(url, { blobDir, applicationName: `gb-test-${side}`, max: 4 });
  const application = createApplication(repo);
  const hosted = createHostedSessions(application, { isAuthorized: () => true });
  await hosted.ready;
  const delivery = createDelivery(hosted, { isAuthorized: () => true });
  return {
    repo, application, hosted, delivery,
    async [Symbol.asyncDispose]() {
      try { delivery.close(); await hosted.close(); application.stopExpiry(); await repo.close(); }
      finally { rmSync(blobDir, { recursive: true, force: true }); }
    },
  };
}

describePg("hosted delivery across two instances (Postgres)", () => {
  // Instance A holds the lease and pulled the item; B commits the unbind (alias_holds and the bind_gen bump). A's next
  // pull and its receipt read the row B committed, so both are refused before A has heard of the unbind: its holder
  // still carries the old generation and the lease is still open, so the refusal is the fence's, not a finished lease's.
  // Mutations: delivery.ts `matches` without its bind_gen comparison (A's pull answers the item again); that and
  // receipt's `r.bind_gen !== row.bind_gen` both dropped (the receipt credits fe's cursor); no unbind (the bind_gen precondition fails).
  test("an unbind another instance committed refuses this instance's lease's pull and its receipt of the pulled item; the cursor stays (#1479)", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using a = await instance(db.url, "a");
    await using b = await instance(db.url, "b");
    const user = await seed(a.repo, tx => a.repo.users.upsertByEmail(tx, ME, null));
    await db.sql`INSERT INTO oauth_grants (id, user_id, expires_at, data) VALUES ('G1', ${user.id}, ${Number.MAX_SAFE_INTEGER}, '{}'::jsonb)`;
    const principal: OAuthPrincipal = { authed: { user_id: user.id, user_email: user.email, kind: "user", session_id: 0 }, clientId: OPENCODE_CLIENT, sourceKey: OPENCODE_SESSION_META, grantId: "G1", accessHash: "test", accessExpiry: Number.MAX_SAFE_INTEGER, scopes: ["tools", "delivery"] };
    const root = sessionContext(principal, { [OPENCODE_SESSION_META]: "root" });
    const rootId = (root as { id: string }).id;

    // fe and be, so the root keeps a hold (and its holder session) after fe goes.
    await a.hosted.bind(principal, root, { name: "fe", create: true });
    await a.hosted.bind(principal, root, { name: "be", create: true });
    const lease = await a.delivery.open(principal, root);
    const sender = new AppSession(a.application, a.repo, principal.authed, "sender", { push: false });
    await sender.connect();
    try {
      await sender.send(`${ME}/fe`, "to fe");
      const issued = await a.delivery.pending(principal, root, lease.capability);
      expect(issued).toHaveLength(1);
      const before = a.hosted.holder(rootId)!;
      expect(before.generation).toBe(lease.bind_gen);

      await b.hosted.unbind(principal, root, { name: "fe" });
      const after = (await b.repo.hosted.get(b.repo.read, rootId))!;
      expect(after.bind_gen).toBeGreaterThan(lease.bind_gen);
      expect((await db.sql`SELECT address FROM alias_holds ORDER BY address`).map((r: { address: string }) => r.address)).toEqual([`${ME}/be`]);

      await expect(a.delivery.pending(principal, root, lease.capability)).rejects.toHaveProperty("code", "not_found");
      await expect(a.delivery.receipt(principal, root, lease.capability, issued.map(item => item.id))).rejects.toHaveProperty("code", "not_found");
      expect(await a.repo.cursors.directFor(a.repo.read, `${ME}/fe`)).toBe(0);
      // A hasn't heard of the unbind: its holder is the old generation's and the lease is still open.
      expect(a.hosted.holder(rootId)).toEqual(before);
      expect(a.delivery.activeLeaseCount).toBe(1);
    } finally { sender.close(); }
  });
});
