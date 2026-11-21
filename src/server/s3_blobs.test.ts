import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BlobMissing } from "../core/errors.ts";
import { sha256Hex } from "../shared/hash.ts";
import { credentialSource, type AwsCredentialSpec } from "./aws_credentials.ts";
import { releaseStored, storeUpload } from "./attachments.ts";
import type { Config } from "./config.ts";
import { openDatabase } from "./db.ts";
import { startServer } from "./app.ts";
import { openBlobs, openRepo } from "./open_repo.ts";
import { CHECK_KEY, S3Blobs } from "./s3_blobs.ts";
import { startFakeS3, type FakeS3 } from "../../tests/support/fake_s3.ts";
import { startFakeSts, type FakeSts } from "../../tests/support/fake_sts.ts";
import { scratchDbPath } from "../../tests/support/scratch_db.ts";

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const STATIC: AwsCredentialSpec = { kind: "static", accessKeyId: "AKIASTATIC", secretAccessKey: "static-secret" };

let s3: FakeS3;
let sts: FakeSts;
let dir: string;
let clock: number;
beforeEach(() => {
  s3 = startFakeS3();
  sts = startFakeSts();
  dir = mkdtempSync(join(tmpdir(), "gb-s3-"));
  writeFileSync(join(dir, "token"), "web-identity-token");
  clock = 1_800_000_000_000;
  sts.now = () => clock;
  s3.allow("AKIASTATIC");
});
afterEach(() => {
  s3.stop();
  sts.stop();
  rmSync(dir, { recursive: true, force: true });
});

const webIdentity = (): AwsCredentialSpec => ({ kind: "web-identity", roleArn: "arn:aws:iam::123456789012:role/grayboard", tokenFile: join(dir, "token"), stsEndpoint: sts.endpoint, sessionName: "gb-test" });
const store = (o: { spec?: AwsCredentialSpec; prefix?: string; timeoutMs?: number } = {}) => new S3Blobs({
  bucket: s3.bucket, region: "us-east-1", prefix: o.prefix ?? "", endpoint: s3.endpoint,
  credentials: credentialSource(o.spec ?? STATIC, { now: () => clock, log: () => {} }),
  ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
});

test("put, get and delete round trip under <prefix><two hex digits>/<sha256>, signed with STS's keys", async () => {
  for (let i = 1; i <= 2; i++) s3.allow(sts.issued(i).accessKeyId, sts.issued(i).sessionToken);
  const blobs = store({ spec: webIdentity(), prefix: "grayboard/blobs/" });
  const sha = sha256Hex(bytes("hello"));
  await blobs.put(sha, bytes("hello"));
  await blobs.put(sha, bytes("hello"));
  const key = `grayboard/blobs/${sha.slice(0, 2)}/${sha}`;
  expect([...s3.objects.keys()]).toEqual([key]);
  expect(text(await blobs.get(sha))).toBe("hello");
  expect(s3.requests.map(r => [r.method, r.key, r.accessKeyId, r.sessionToken])).toEqual([
    ["PUT", key, "AKID1", "TOKEN1"], ["PUT", key, "AKID1", "TOKEN1"], ["GET", key, "AKID1", "TOKEN1"],
  ]);
  // Refreshed keys sign the next request: a new client per credentials generation.
  clock += 3600_000;
  await blobs.delete(sha);
  expect(s3.requests.at(-1)).toEqual({ method: "DELETE", key, accessKeyId: "AKID2", sessionToken: "TOKEN2" });
  expect(s3.objects.size).toBe(0);
  await blobs.delete(sha);
  await expect(blobs.get(sha)).rejects.toBeInstanceOf(BlobMissing);
  expect(sts.requests).toHaveLength(2);
});

test("only NoSuchKey is BlobMissing: a 403 (a role without s3:ListBucket answers so for a missing key) is a fault", async () => {
  const blobs = store();
  const sha = sha256Hex(bytes("x"));
  await expect(blobs.get(sha)).rejects.toThrow(new BlobMissing(sha).message);
  s3.fail({ method: "GET", status: 403, code: "AccessDenied" });
  const err = await blobs.get(sha).then(() => null, (e: unknown) => e);
  expect(err).not.toBeInstanceOf(BlobMissing);
  expect((err as Error).message).toBe(`S3 get on s3://${s3.bucket}/: AccessDenied: Access Denied`);
  s3.fail({ method: "GET", status: 500, code: "InternalError" });
  expect(await blobs.get(sha).then(() => null, (e: unknown) => e)).not.toBeInstanceOf(BlobMissing);
});

test("keys the store didn't send never reach S3: the fake refuses them, and the error carries no secret", async () => {
  const blobs = new S3Blobs({ bucket: s3.bucket, region: "us-east-1", prefix: "", endpoint: s3.endpoint, credentials: credentialSource({ kind: "static", accessKeyId: "AKIAOTHER", secretAccessKey: "other-secret" }) });
  const err = await blobs.put(sha256Hex(bytes("x")), bytes("x")).then(() => null, (e: Error) => e);
  expect(err!.message).toBe(`S3 put on s3://${s3.bucket}/: AccessDenied: Access Denied`);
  expect(err!.message).not.toContain("other-secret");
  expect(s3.objects.size).toBe(0);
});

test("an operation S3 never answers fails at the deadline", async () => {
  const blobs = store({ timeoutMs: 100 });
  const release = s3.hang("PUT");
  try {
    await expect(blobs.put(sha256Hex(bytes("x")), bytes("x"))).rejects.toThrow(`S3 put on s3://${s3.bucket}/: no answer in 100 ms`);
  } finally {
    release();
  }
});

test("a key that isn't a sha256 never reaches S3", async () => {
  const blobs = store();
  for (const bad of ["../../etc/passwd", "ab", "A".repeat(64), `${"a".repeat(64)}/x`]) {
    await expect(blobs.put(bad, bytes("x"))).rejects.toThrow("not a sha256");
    await expect(blobs.get(bad)).rejects.toThrow("not a sha256");
    await expect(blobs.delete(bad)).rejects.toThrow("not a sha256");
  }
  expect(s3.requests).toEqual([]);
});

test("the startup check passes on a bucket without the sentinel and refuses keys S3 denies", async () => {
  await store({ prefix: "p/" }).check();
  expect(s3.requests.map(r => [r.method, r.key])).toEqual([["GET", `p/${CHECK_KEY}`]]);
  const denied = new S3Blobs({ bucket: s3.bucket, region: "us-east-1", prefix: "p/", endpoint: s3.endpoint, credentials: credentialSource({ kind: "static", accessKeyId: "AKIAWRONG", secretAccessKey: "wrong-secret" }) });
  await expect(denied.check()).rejects.toThrow(`S3 startup check on s3://${s3.bucket}/p/: AccessDenied`);
  // A refused STS exchange fails the check too.
  sts.refuse({ status: 403, code: "AccessDenied", message: "Not authorized" });
  await expect(store({ spec: webIdentity() }).check()).rejects.toThrow("HTTP 403 AccessDenied: Not authorized");
});

const s3Config = (spec: AwsCredentialSpec = STATIC) => ({ blobS3: { bucket: s3.bucket, region: "us-east-1", prefix: "gb/", endpoint: s3.endpoint, credentials: spec } });

test("openBlobs checks the store before the database opens, naming it on refusal", async () => {
  expect(await openBlobs({ blobDir: "/srv/blobs" })).toEqual({ blobDir: "/srv/blobs" });
  expect((await openBlobs(s3Config())).blobs).toBeInstanceOf(S3Blobs);
  await expect(openBlobs(s3Config({ kind: "static", accessKeyId: "AKIAWRONG", secretAccessKey: "wrong-secret" })))
    .rejects.toThrow(`attachment store s3://${s3.bucket}/gb/: S3 startup check on s3://${s3.bucket}/gb/: AccessDenied: Access Denied`);
});

// The server's own attachment flows (src/server/attachments.ts) on an S3 store: upload, read, release and sweep.
test("a server's uploads live in S3: stored, read back, released and swept", async () => {
  const repo = await openRepo({ store: { kind: "sqlite", path: scratchDbPath() }, ...s3Config() } as Config);
  try {
    expect(repo.blobs).toBeInstanceOf(S3Blobs);
    const row = await storeUpload(repo, "alice@example.com", "be", { filename: "notes.txt", type: "text/plain", data: bytes("s3 bytes") });
    const key = `gb/${row.sha256.slice(0, 2)}/${row.sha256}`;
    expect(text(s3.objects.get(key)!)).toBe("s3 bytes");
    expect(text(await repo.blobs.get(row.sha256))).toBe("s3 bytes");
    expect(await releaseStored(repo, "alice@example.com", "be", row.id)).toMatchObject({ id: row.id });
    expect(s3.objects.has(key)).toBe(false);
    await expect(repo.blobs.get(row.sha256)).rejects.toBeInstanceOf(BlobMissing);
  } finally {
    await repo.close();
  }
});

test("a failed S3 put drops the upload's row", async () => {
  const { repo } = openDatabase(scratchDbPath(), { blobs: store() });
  try {
    s3.fail({ method: "PUT", status: 403, code: "AccessDenied" });
    await expect(storeUpload(repo, "alice@example.com", "be", { filename: "f.txt", type: "text/plain", data: bytes("no") })).rejects.toThrow("AccessDenied");
    expect(await repo.attachments.unnamedBlobs(repo.read)).toEqual([]);
  } finally {
    await repo.close();
  }
});

test("startServer refuses an S3 config without an opened repo: the store and its check come from openRepo", () => {
  expect(() => startServer({ store: { kind: "sqlite", path: scratchDbPath() }, ...s3Config() } as Config))
    .toThrow("startServer: an S3 attachment store is opened with openRepo, then passed as `repo`");
});
