// #807 P3 C9b: the auth cache contract (auth_cache.contract.ts) on Postgres: store/auth_cache.ts over the Postgres
// generation (pg/auth_generation.ts: 0001's triggers, the write path's bump, the LISTEN), as C11 composes them. Each row
// gets its own database and pod (tests/support/pg_auth.ts). settle() and seen() wait for a marker NOTIFY on the
// listener's channel, which the pod's listener swallows, so a marker never moves the generation itself. The races
// only Postgres has are auth_generation.pg.test.ts's. Without GRAYBOARD_TEST_PG_URL it skips (tests/support/pg.ts).
import { authCacheContract, type AuthCacheBackend } from "../auth_cache.contract.ts";
import { describePg, pgDatabase } from "../../../../tests/support/pg.ts";
import { pgAuthPod } from "../../../../tests/support/pg_auth.ts";

const pgAuthCacheBackend: AuthCacheBackend = {
  kind: "postgres",
  commitGeneration: "none",
  async open() {
    const db = await pgDatabase({ max: 2 });
    const pod = await pgAuthPod(db).catch(async error => { await db[Symbol.asyncDispose](); throw error; });
    let seen: ((what: string) => Promise<void>) | undefined;
    let advanced = 0;
    return {
      auth: pod.auth, oauth: pod.oauth, users: pod.identity.users,
      write: fn => pod.tx.write(fn),
      read: pod.tx.read,
      now: () => Date.now(),
      touchOther: tx => pod.cursors.advance(tx, "a@example.com/fe", "direct", "a@example.com/fe", ++advanced),
      async outsideDisable(userId) {
        await db.sql`UPDATE users SET disabled_at = ${Date.now()} WHERE id = ${userId}`;
        seen = await pod.listener.marker(db.sql);
      },
      settle: () => pod.settle(),
      async seen() {
        if (!seen) throw new Error("seen() without an outsideDisable");
        const s = seen;
        seen = undefined;
        await s("the outside disable's notification");
      },
      reads() {
        const base = { ...pod.counts };
        return { users: () => pod.counts.users - base.users, accesses: () => pod.counts.accesses - base.accesses, restore() {} };
      },
      async close() { await pod.close(); await db[Symbol.asyncDispose](); },
    };
  },
};

describePg("auth cache contract (Postgres)", () => authCacheContract(pgAuthCacheBackend));
