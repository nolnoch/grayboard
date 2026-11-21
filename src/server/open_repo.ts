// The server's store, opened from config (#807 P3 C11b). Apart from app.ts on purpose: app.ts must not reach the
// Postgres modules, because adapters/opencode-v2's fixtures import it and typecheck it under that package's own
// @types/bun, which lacks Bun.SQL's listen/notify (open_repo.test.ts guards the split).
import { openDatabase, type Repo } from "./db.ts";
import { sessionEndPort } from "./session_end.ts";
import { makePgRepo } from "./pg_repo.ts";
import { DEFAULT_CONNECT_SECONDS, waitForPg } from "./store/pg/connect.ts";
import type { Config } from "./config.ts";
import { credentialSource } from "./aws_credentials.ts";
import { S3Blobs } from "./s3_blobs.ts";
import type { BlobStore } from "../core/attachments.ts";

// An S3 attachment store (#1509), checked before the database opens: bad credentials or a bad bucket fail the
// startup rather than the first upload. `blobDir` when there's none.
export async function openBlobs(config: Pick<Config, "blobDir" | "blobS3">, opts: { timeoutMs?: number } = {}): Promise<{ blobDir?: string; blobs?: BlobStore }> {
  const s3 = config.blobS3;
  if (!s3) return { blobDir: config.blobDir };
  const blobs = new S3Blobs({ bucket: s3.bucket, region: s3.region, prefix: s3.prefix, ...(s3.endpoint ? { endpoint: s3.endpoint } : {}), credentials: credentialSource(s3.credentials), ...opts });
  try {
    await blobs.check();
  } catch (e) {
    throw new Error(`attachment store ${blobs.describe()}: ${(e as Error).message}`);
  }
  return { blobs };
}

// The server's store, opened from config (#807 P3 C11b): SQLite at once; Postgres waits for the database, migrates and starts its auth LISTEN
// first (pg_repo.ts), so a migration failure fails the open and so the startup. `pool` labels and sizes a Postgres
// Repo's connections (tests run many servers on one cluster).
export async function openRepo(config: Config, opts: { now?: () => number; pool?: { applicationName?: string; max?: number } } = {}): Promise<Repo> {
  const humanReach = config.humanReach ?? "team";
  const blobs = await openBlobs(config);
  const limits = { attachmentLimits: config.attachmentLimits, attachmentUserQuota: config.attachmentUserQuota, ...(opts.now ? { now: opts.now } : {}) };
  if (config.store.kind === "sqlite") return openDatabase(config.store.path, { ...blobs, sessionEnd: sessionEndPort(humanReach), ...limits }).repo;
  // A managed database may still be resuming or failing over (#1418): wait for it before migrating.
  await waitForPg(config.store.url, { seconds: config.databaseConnectSeconds ?? DEFAULT_CONNECT_SECONDS });
  return makePgRepo(config.store.url, { ...blobs, humanReach, ...limits, ...opts.pool });
}
