// The server's store, opened from config (#807 P3 C11b). Apart from app.ts on purpose: app.ts must not reach the
// Postgres modules, because adapters/opencode-v2's fixtures import it and typecheck it under that package's own
// @types/bun, which lacks Bun.SQL's listen/notify (open_repo.test.ts guards the split).
import { openDatabase, type Repo } from "./db.ts";
import { sessionEndPort } from "./session_end.ts";
import { makePgRepo } from "./pg_repo.ts";
import { DEFAULT_CONNECT_SECONDS, waitForPg } from "./store/pg/connect.ts";
import { DEFAULT_DATABASE_WRITERS, type Config } from "./config.ts";

// The server's store, opened from config (#807 P3 C11b): SQLite at once; Postgres waits for the database, migrates and starts its auth LISTEN
// first (pg_repo.ts), so a migration failure fails the open and so the startup. `pool` labels and sizes a Postgres
// Repo's connections (tests run many servers on one cluster).
export async function openRepo(config: Config, opts: { now?: () => number; pool?: { applicationName?: string; max?: number } } = {}): Promise<Repo> {
  const humanReach = config.humanReach ?? "team";
  const limits = { attachmentLimits: config.attachmentLimits, attachmentUserQuota: config.attachmentUserQuota, ...(opts.now ? { now: opts.now } : {}) };
  if (config.store.kind === "sqlite") return openDatabase(config.store.path, { blobDir: config.blobDir, sessionEnd: sessionEndPort(humanReach), ...limits }).repo;
  // A managed database may still be resuming or failing over (#1418): wait for it before migrating.
  await waitForPg(config.store.url, { seconds: config.databaseConnectSeconds ?? DEFAULT_CONNECT_SECONDS });
  return makePgRepo(config.store.url, { blobDir: config.blobDir, humanReach, writers: config.databaseWriters ?? DEFAULT_DATABASE_WRITERS, ...limits, ...opts.pool });
}
