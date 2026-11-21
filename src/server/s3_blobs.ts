// The server's S3 BlobStore (#1509): attachment bytes as objects <prefix><first two hex digits>/<sha256> in one
// bucket, signed with keys from a CredentialSource (aws_credentials.ts: the pod's IAM role, or static keys).
//
// Every S3Client option is passed explicitly: Bun fills an omitted one from S3_*/AWS_* env vars, and nothing here may
// come from ambient env except through the credential source. One client per credentials generation.
//
// Bun's S3 calls take no signal, and a hung put would hold core's per-sha256 chain (withBlob) and its request forever,
// so each operation races a deadline. The deadline releases withBlob's chain but not the request, which may still land
// later. A delete landing after a newer upload's put would take bytes the new row names, so a put or delete abandoned
// at its deadline stays recorded per sha256 (`abandoned`) until it settles, and the next operation on that sha256
// waits for it, under a deadline of its own, and fails rather than race it if it's still pending.
//
// Shared-store rule (src/core/attachments.ts withBlob): "a store other processes share must also refuse to delete
// bytes an attachment row names". This store does not: uploads and sweeps are serialized only within this process.
// That holds for one replica (the pilot); Stage 4's multiple replicas (#808) need it first.
//
// open_repo.ts builds the store; app.ts never imports this module (open_repo.test.ts): adapters/opencode-v2 typechecks
// app.ts under its own, older @types/bun.
import type { BlobStore } from "../core/attachments.ts";
import { BlobMissing } from "../core/errors.ts";
import type { AwsCredentials, CredentialSource } from "./aws_credentials.ts";

const SHA256 = /^[0-9a-f]{64}$/;
export const S3_TIMEOUT_MS = 30_000;
// The key the startup check reads, under the prefix so the role's policy covers it; never a sha256.
export const CHECK_KEY = "grayboard-startup-check";

export type S3BlobOptions = {
  bucket: string;
  region: string;
  // "" or ending in "/" (config.ts normalizes it).
  prefix: string;
  // An S3-compatible endpoint (tests, other providers); absent, AWS's for the region.
  endpoint?: string;
  credentials: CredentialSource;
  timeoutMs?: number;
};

// Bun throws an Error named S3Error with S3's code; NoSuchKey is the only answer that means the bytes are gone. A 403
// is not: without s3:ListBucket, S3 answers AccessDenied for a missing key, and that is a permissions fault.
const s3Code = (e: unknown): string | undefined => (e instanceof Error && e.name === "S3Error" ? (e as { code?: string }).code : undefined);

export class S3Blobs implements BlobStore {
  private client: { creds: AwsCredentials; s3: Bun.S3Client } | undefined;
  private readonly timeoutMs: number;
  // Puts and deletes that outlived their deadline, by sha256, until they settle.
  private readonly abandoned = new Map<string, Promise<unknown>>();

  constructor(private readonly opts: S3BlobOptions) {
    this.timeoutMs = opts.timeoutMs ?? S3_TIMEOUT_MS;
  }

  // Where the bytes are, for the startup line and errors.
  describe(): string {
    return `s3://${this.opts.bucket}/${this.opts.prefix}`;
  }

  key(sha256: string): string {
    // Anything but a hex digest is a bug upstream.
    if (!SHA256.test(sha256)) throw new Error(`not a sha256: ${JSON.stringify(sha256.slice(0, 80))}`);
    return `${this.opts.prefix}${sha256.slice(0, 2)}/${sha256}`;
  }

  private async s3(): Promise<Bun.S3Client> {
    const creds = await this.opts.credentials.get();
    if (this.client?.creds !== creds) {
      const { bucket, region, endpoint } = this.opts;
      this.client = {
        creds,
        s3: new Bun.S3Client({
          accessKeyId: creds.accessKeyId,
          secretAccessKey: creds.secretAccessKey,
          // Bun falls back to S3_SESSION_TOKEN, then AWS_SESSION_TOKEN, for an empty token exactly as for an absent
          // one, and reads them as the process started. The guard is elsewhere: every credential source passes its
          // token here explicitly (static keys carry AWS_SESSION_TOKEN's), and config refuses S3_SESSION_TOKEN.
          sessionToken: creds.sessionToken ?? "",
          region,
          // AWS: the virtual-hosted endpoint, its recommended style; a dotted bucket breaks that certificate, so path style.
          ...(endpoint ? { endpoint, bucket } : bucket.includes(".")
            ? { endpoint: `https://s3.${region}.amazonaws.com`, bucket }
            : { endpoint: `https://${bucket}.s3.${region}.amazonaws.com`, virtualHostedStyle: true, bucket }),
          type: "application/octet-stream",
        }),
      };
    }
    return this.client.s3;
  }

  // `op` against a deadline; its timer is cleared once either settles, so nothing outlives the call. A put or delete
  // (`sha256` given) that times out is recorded in `abandoned` until it settles.
  private async deadline<T>(what: string, op: () => Promise<T>, sha256?: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const run = op();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { timedOut = true; reject(new Error(`S3 ${what} on ${this.describe()}: no answer in ${this.timeoutMs} ms`)); }, this.timeoutMs);
    });
    try {
      return await Promise.race([run, timeout]);
    } finally {
      clearTimeout(timer);
      // A late rejection of an abandoned call is nobody's to handle.
      run.catch(() => {});
      if (timedOut && sha256 !== undefined) this.abandon(sha256, run);
    }
  }

  private abandon(sha256: string, run: Promise<unknown>): void {
    const prev = this.abandoned.get(sha256);
    const pending: Promise<unknown> = (prev ? Promise.allSettled([prev, run]) : run.then(() => {}, () => {}))
      .then(() => { if (this.abandoned.get(sha256) === pending) this.abandoned.delete(sha256); });
    this.abandoned.set(sha256, pending);
  }

  // Abandoned requests not yet settled; an entry goes once its request settles, so the map doesn't grow (tests read it).
  get abandonedCount(): number {
    return this.abandoned.size;
  }

  // Waits, under the deadline, for a put or delete of `sha256` abandoned earlier; throws if it's still pending. A request
  // Bun never settles keeps its entry until the process restarts, so every later put, get or delete of that sha256 fails
  // at this deadline. That's deliberate: letting the operation through would reopen the race the entry exists to close
  // (e.g. a late delete taking a newer upload's bytes).
  private async settled(what: string, sha256: string): Promise<void> {
    const pending = this.abandoned.get(sha256);
    if (!pending) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => { timer = setTimeout(() => resolve("late"), this.timeoutMs); });
    try {
      if (await Promise.race([pending.then(() => "done" as const), late]) === "late") {
        throw new Error(`S3 ${what} on ${this.describe()}: an earlier request for ${sha256} is still pending`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private fail(what: string, e: unknown): Error {
    const code = s3Code(e);
    if (code === undefined) return e as Error;
    return new Error(`S3 ${what} on ${this.describe()}: ${code}: ${(e as Error).message}`);
  }

  async put(sha256: string, data: Uint8Array): Promise<void> {
    const key = this.key(sha256);
    try {
      await this.settled("put", sha256);
      await this.deadline("put", async () => { await (await this.s3()).write(key, data); }, sha256);
    } catch (e) {
      throw this.fail("put", e);
    }
  }

  async get(sha256: string): Promise<Uint8Array> {
    const key = this.key(sha256);
    try {
      await this.settled("get", sha256);
      return await this.deadline("get", async () => (await this.s3()).file(key).bytes());
    } catch (e) {
      if (s3Code(e) === "NoSuchKey") throw new BlobMissing(sha256);
      throw this.fail("get", e);
    }
  }

  // S3 answers a delete of a missing key with success.
  async delete(sha256: string): Promise<void> {
    const key = this.key(sha256);
    try {
      await this.settled("delete", sha256);
      await this.deadline("delete", async () => { await (await this.s3()).delete(key); }, sha256);
    } catch (e) {
      throw this.fail("delete", e);
    }
  }

  // The startup check: credentials, then a GET of a key under the prefix. NoSuchKey (or the object itself) means the
  // bucket answers and the role may read there. A GET rather than a HEAD: Bun reports a HEAD's 403 as UnknownError,
  // and the refusal should say AccessDenied (a missing s3:ListBucket shows up here too, as AccessDenied).
  async check(): Promise<void> {
    try {
      await this.deadline("startup check", async () => { await (await this.s3()).file(`${this.opts.prefix}${CHECK_KEY}`).bytes(); });
    } catch (e) {
      if (s3Code(e) === "NoSuchKey") return;
      throw this.fail("startup check", e);
    }
  }
}
