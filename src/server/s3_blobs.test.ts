import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
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
import { CHECK_KEY, S3Blobs, S3StoreError } from "./s3_blobs.ts";
import { errorDiagnostic } from "./diagnostics.ts";
import { startFakeS3, type FakeS3 } from "../../tests/support/fake_s3.ts";
import { startFakeSts, type FakeSts } from "../../tests/support/fake_sts.ts";
import { scratchDbPath } from "../../tests/support/scratch_db.ts";
import { until } from "../../tests/support/until.ts";

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);
// With a session token of its own, so Bun never falls back to an ambient AWS_SESSION_TOKEN/S3_SESSION_TOKEN (it does
// for an absent or empty one): these tests don't depend on the runner's env. Keys without a token, under a scrubbed and
// hostile env, are the subprocess test's.
const STATIC: AwsCredentialSpec = { kind: "static", accessKeyId: "AKIASTATIC", secretAccessKey: "static-secret", sessionToken: "static-session" };

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
  s3.allow("AKIASTATIC", "static-session");
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
  // #1608: the code is data, for the hosted diagnostic line.
  expect(err).toBeInstanceOf(S3StoreError);
  expect((err as S3StoreError).code).toBe("AccessDenied");
  s3.fail({ method: "GET", status: 500, code: "InternalError" });
  const internal = await blobs.get(sha).then(() => null, (e: unknown) => e);
  expect(internal).not.toBeInstanceOf(BlobMissing);
  expect(errorDiagnostic(internal)).toEqual({ class: "S3StoreError", code: "InternalError" });
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

// Audit M1: a delete abandoned at its deadline may still land; it must not take a newer upload's bytes.
test("a put after a delete that timed out refuses while the delete is pending, and waits for it once it settles", async () => {
  const blobs = store({ timeoutMs: 200 });
  const sha = sha256Hex(bytes("again"));
  const key = blobs.key(sha);
  await blobs.put(sha, bytes("again"));
  const release = s3.hang("DELETE");
  await expect(blobs.delete(sha)).rejects.toThrow("no answer in 200 ms");
  // The delete is still in flight: a re-upload fails rather than race it (and so drops its row).
  await expect(blobs.put(sha, bytes("again"))).rejects.toThrow(`an earlier request for ${sha} is still pending`);
  await expect(blobs.get(sha)).rejects.toThrow("still pending");
  expect(s3.requests.filter(r => r.method === "PUT")).toHaveLength(1);
  release();
  expect(blobs.abandonedCount).toBe(1);
  await until(() => !s3.objects.has(key), 5000, "the abandoned delete lands");
  await until(() => blobs.abandonedCount === 0, 5000, "the settled delete's entry goes");
  // Settled: the next put goes ahead, and nothing deletes its bytes afterwards.
  await blobs.put(sha, bytes("again"));
  expect(text(s3.objects.get(key)!)).toBe("again");

  // A delete that times out and settles while the next put waits: the put goes after it.
  const release2 = s3.hang("DELETE");
  await expect(blobs.delete(sha)).rejects.toThrow("no answer in 200 ms");
  const put = blobs.put(sha, bytes("again"));
  release2();
  await put;
  expect(text(s3.objects.get(key)!)).toBe("again");
  expect(blobs.abandonedCount).toBe(0);
  expect(s3.requests.slice(-2).map(r => r.method)).toEqual(["DELETE", "PUT"]);
});

test("the deadline's timer is cleared when the operation settles", async () => {
  const blobs = store();
  const set = spyOn(globalThis, "setTimeout");
  const cleared = spyOn(globalThis, "clearTimeout");
  try {
    const sha = sha256Hex(bytes("timers"));
    await blobs.put(sha, bytes("timers"));
    await blobs.get(sha);
    await blobs.delete(sha);
    const timers = set.mock.results.map(r => r.value);
    expect(timers.length).toBeGreaterThanOrEqual(3);
    const clearedTimers = new Set(cleared.mock.calls.map(c => c[0]));
    expect(timers.filter(t => !clearedTimers.has(t as ReturnType<typeof setTimeout>))).toEqual([]);
  } finally {
    set.mockRestore();
    cleared.mockRestore();
  }
});

test("the wait on an abandoned request clears its timer once the request settles", async () => {
  // A wide deadline: the released delete must come back inside settled()'s wait, even on a loaded runner.
  const blobs = store({ timeoutMs: 1000 });
  const sha = sha256Hex(bytes("settled"));
  await blobs.put(sha, bytes("settled"));
  const release = s3.hang("DELETE");
  await expect(blobs.delete(sha)).rejects.toThrow("no answer in 1000 ms");
  const set = spyOn(globalThis, "setTimeout");
  const cleared = spyOn(globalThis, "clearTimeout");
  try {
    // The put waits in settled() on the abandoned delete, which settles inside that wait.
    const put = blobs.put(sha, bytes("settled"));
    release();
    await put;
    // The store's own timers (settled()'s wait and the put's deadline) are the ones armed for timeoutMs.
    const timers = set.mock.calls.flatMap((c, i) => c[1] === 1000 ? [set.mock.results[i]!.value] : []);
    expect(timers.length).toBe(2);
    const clearedTimers = new Set(cleared.mock.calls.map(c => c[0]));
    expect(timers.filter(t => !clearedTimers.has(t as ReturnType<typeof setTimeout>))).toEqual([]);
  } finally {
    set.mockRestore();
    cleared.mockRestore();
  }
});

// Bun fills an omitted S3Client option from S3_*/AWS_* env, read as the process starts: so a child, with a hostile env.
test("explicit options beat a hostile S3_*/AWS_* environment", async () => {
  s3.allow("AKIASTATIC", null);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(AWS|S3)_/.test(k)) env[k] = v;
  Object.assign(env, {
    S3_ENDPOINT: "http://127.0.0.1:9", AWS_ENDPOINT: "http://127.0.0.1:9", S3_BUCKET: "evil-bucket", AWS_BUCKET: "evil-bucket",
    S3_ACCESS_KEY_ID: "AKIAEVIL", S3_SECRET_ACCESS_KEY: "evil", AWS_ACCESS_KEY_ID: "AKIAEVIL2", AWS_SECRET_ACCESS_KEY: "evil2",
    S3_REGION: "eu-west-9", AWS_REGION: "eu-west-9",
  });
  const child = Bun.spawn(["bun", join(import.meta.dir, "../../tests/support/s3_static_child.ts"), s3.endpoint, s3.bucket], { env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 30_000);
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, err }).toEqual({ code: 0, err: "" });
    expect(JSON.parse(out)).toEqual({ get: "child bytes", missing: "BlobMissing" });
  } finally {
    clearTimeout(timer);
  }
  expect(s3.requests.length).toBe(4);
  expect(s3.requests.every(r => r.accessKeyId === "AKIASTATIC" && r.sessionToken === null && r.key.startsWith("p/"))).toBe(true);
});
