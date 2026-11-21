// A child for src/server/s3_blobs.test.ts (#1509): S3Blobs with static keys and no session token, run under whatever
// environment the parent gives it, so a hostile S3_*/AWS_* env can be shown not to reach the requests. Prints one JSON
// line: the outcome of a put, get, missing get and delete. argv: endpoint, bucket.
import { S3Blobs } from "../../src/server/s3_blobs.ts";
import { credentialSource } from "../../src/server/aws_credentials.ts";
import { BlobMissing } from "../../src/core/errors.ts";
import { sha256Hex } from "../../src/shared/hash.ts";

const [endpoint, bucket] = process.argv.slice(2);
const blobs = new S3Blobs({ bucket: bucket!, region: "us-east-1", prefix: "p/", endpoint, credentials: credentialSource({ kind: "static", accessKeyId: "AKIASTATIC", secretAccessKey: "static-secret" }), timeoutMs: 5000 });
const data = new TextEncoder().encode("child bytes");
const sha = sha256Hex(data);
const out: Record<string, unknown> = {};
try {
  await blobs.put(sha, data);
  out.get = new TextDecoder().decode(await blobs.get(sha));
  await blobs.delete(sha);
  out.missing = await blobs.get(sha).then(() => "present", (e) => (e instanceof BlobMissing ? "BlobMissing" : String(e)));
} catch (e) {
  out.error = (e as Error).message;
}
console.log(JSON.stringify(out));
