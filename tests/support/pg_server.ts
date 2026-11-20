// In-process servers on Postgres (#807 P3 C11a): TestServers over pg_repo.ts makePgRepo on one shared fresh test
// database, through startServer's injected Repo. One server on Postgres is TestServer.open under
// GRAYBOARD_TEST_BACKEND=pg; a test that needs pods sharing a database, or Postgres whatever the backend, opens them here.
//
// Two servers on one database are two pods: each its own pool, write queue and auth LISTEN. Their pools are labelled
// gb-test-a and gb-test-b, as pg_race.ts's pair is, so blockedOrSettled finds the B side's lock wait. One server can't
// race itself (one write queue): a race through the server pairs it with a pg_race.ts store, or with a second server.
// Disposal stops every server (which awaits its Repo's close), then drops the database.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StartOptions } from "../../src/server/app.ts";
import type { Config } from "../../src/server/config.ts";
import { makePgRepo } from "../../src/server/pg_repo.ts";
import { pgDatabase, type PgDatabase } from "./pg.ts";
import { TestServer } from "./server.ts";

export type PgServers = { db: PgDatabase; servers: TestServer[]; [Symbol.asyncDispose](): Promise<void> };

// `n` servers on one fresh database, each with its own blob directory, returned once each has started (its startup
// writes committed, its Slack bridge up or given up). `overrides`: every server's config, or each one's by index (two
// pods' fake Slacks). `sides`: the pools' labels, gb-test-<side>; "b" alone puts one server on the side
// blockedOrSettled watches, for a race whose A side is a pg_race.ts store. `now`: every Repo's clock and the servers'.
export async function pgServers(n = 1, { overrides = {}, start = {}, now, sides = ["a", "b", "c", "d"] }: {
  overrides?: Partial<Config> | ((i: number) => Partial<Config>); start?: StartOptions; now?: () => number; sides?: string[];
} = {}): Promise<PgServers> {
  if (n > sides.length) throw new Error(`pgServers: ${n} servers, ${sides.length} sides`);
  const db = await pgDatabase({ max: 2 });
  const servers: TestServer[] = [];
  const blobs: string[] = [];
  const dispose = async () => {
    const stopped = await Promise.allSettled(servers.map(s => s.stop()));
    for (const dir of blobs) rmSync(dir, { recursive: true, force: true });
    await db[Symbol.asyncDispose]();
    const failed = stopped.find(r => r.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  };
  try {
    for (let i = 0; i < n; i++) {
      const o = typeof overrides === "function" ? overrides(i) : overrides;
      const blobDir = mkdtempSync(join(tmpdir(), "gb-pg-blobs-"));
      blobs.push(blobDir);
      const repo = await makePgRepo(db.url, { blobDir, applicationName: `gb-test-${sides[i]}`, max: 4, humanReach: o.humanReach,
        attachmentLimits: o.attachmentLimits, attachmentUserQuota: o.attachmentUserQuota, ...(now ? { now } : {}) });
      let server: TestServer;
      try {
        server = await TestServer.open({ ...o, blobDir }, { ...start, ...(now ? { now } : {}), repo });
      } catch (error) {
        await repo.close();
        throw error;
      }
      servers.push(server);
      await server.app.ready;
      await server.app.slackReady;
    }
  } catch (error) {
    await dispose().catch(() => {});
    throw error;
  }
  return { db, servers, [Symbol.asyncDispose]: dispose };
}
