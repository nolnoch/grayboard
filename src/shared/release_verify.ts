// A release's signed checksums (#162): SHA256SUMS lists every asset's sha256
// under a `# grayboard <tag>` line, and SHA256SUMS.sig is one line,
// `<key id> <base64 DER ECDSA P-256 signature>`, made by `openssl dgst
// -sha256 -sign`. install.sh checks the same files with the openssl CLI; this
// is `grayboard update`'s side, on WebCrypto, against the compiled-in keys.
import { RELEASE_KEYS } from "./release_keys.ts";

export const SUMS = "SHA256SUMS";
export const SIG = "SHA256SUMS.sig";

/** A verified SHA256SUMS: the tag it's for, the key that signed it, and asset name → hex sha256. */
export type SignedSums = { tag: string; keyId: string; digests: Map<string, string> };

/** An SPKI PEM's DER bytes. */
export function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const m = /^-----BEGIN PUBLIC KEY-----\n([A-Za-z0-9+/=\n]+)-----END PUBLIC KEY-----\n?$/.exec(pem);
  if (!m) throw new Error("not a PEM public key");
  return Uint8Array.from(Buffer.from(m[1]!.replace(/\n/g, ""), "base64"));
}

/** A key's id: the first 16 hex characters of sha256 over its SPKI DER. */
export function keyId(pem: string): string {
  return new Bun.CryptoHasher("sha256").update(pemToDer(pem)).digest("hex").slice(0, 16);
}

/** One DER INTEGER at `at` as a 32-byte big-endian value; returns it and the offset after it. */
function derInt(der: Uint8Array, at: number): [Uint8Array, number] {
  if (der[at] !== 0x02) throw new Error("expected an INTEGER");
  const len = der[at + 1] ?? 0;
  const start = at + 2;
  if (len < 1 || len > 33 || start + len > der.length) throw new Error("bad INTEGER length");
  let v = der.subarray(start, start + len);
  if (v[0]! & 0x80) throw new Error("negative INTEGER");
  if (v[0] === 0 && len > 1) {
    // A leading zero is only there to clear the sign bit of the next byte.
    if (!(v[1]! & 0x80)) throw new Error("non-minimal INTEGER");
    v = v.subarray(1);
  }
  if (v.length > 32) throw new Error("INTEGER longer than 32 bytes");
  const out = new Uint8Array(32);
  out.set(v, 32 - v.length);
  return [out, start + len];
}

/** A DER ECDSA-Sig-Value (SEQUENCE { r INTEGER, s INTEGER }) as P1363 r||s, which WebCrypto takes. */
export function derToP1363(der: Uint8Array): Uint8Array<ArrayBuffer> {
  // P-256's longest signature is 72 bytes, so the length is always short-form.
  if (der[0] !== 0x30 || der[1] === undefined || der[1] & 0x80 || der[1] + 2 !== der.length) {
    throw new Error("not a DER SEQUENCE of the signature's length");
  }
  const [r, next] = derInt(der, 2);
  const [s, end] = derInt(der, next);
  if (end !== der.length) throw new Error("trailing bytes after the signature");
  const out = new Uint8Array(64);
  out.set(r, 0);
  out.set(s, 32);
  return out;
}

/** SHA256SUMS's lines: the tag line, then `<hex>  <name>` per asset; anything else refuses. */
export function parseSums(text: string): { tag: string; digests: Map<string, string> } {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const head = /^# grayboard (\S+)$/.exec(lines[0] ?? "");
  if (!head) throw new Error(`${SUMS} doesn't start with a "# grayboard <tag>" line`);
  const digests = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const m = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
    if (!m) throw new Error(`${SUMS} has a malformed line: ${JSON.stringify(line.slice(0, 120))}`);
    if (digests.has(m[2]!)) throw new Error(`${SUMS} lists ${m[2]} twice`);
    digests.set(m[2]!, m[1]!);
  }
  return { tag: head[1]!, digests };
}

/**
 * Verify `sums` (SHA256SUMS's bytes) against `sig` (SHA256SUMS.sig's text)
 * with a key from `keys`, and that it's the checksums of release `tag`.
 * Each refusal names the check that failed.
 */
export async function verifySums(
  tag: string,
  sums: Uint8Array<ArrayBuffer>,
  sig: string,
  keys: Record<string, string> = RELEASE_KEYS,
): Promise<SignedSums> {
  const m = /^([0-9a-f]{16}) ([A-Za-z0-9+/]+={0,2})\n?$/.exec(sig);
  if (!m) throw new Error(`${SIG} isn't "<key id> <base64 signature>"`);
  const [, id, b64] = m;
  const pem = keys[id!];
  if (!pem) throw new Error(`${SIG}: unknown key id ${id}`);
  let p1363: Uint8Array<ArrayBuffer>;
  try {
    p1363 = derToP1363(Uint8Array.from(Buffer.from(b64!, "base64")));
  } catch (e) {
    throw new Error(`${SIG}: malformed signature (${(e as Error).message})`);
  }
  const key = await crypto.subtle.importKey("spki", pemToDer(pem), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  if (!(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, p1363, sums))) {
    throw new Error(`${SIG}: the signature doesn't verify against ${SUMS} with key ${id}`);
  }
  const parsed = parseSums(new TextDecoder("utf-8", { fatal: true }).decode(sums));
  if (parsed.tag !== tag) throw new Error(`${SUMS} is signed for ${parsed.tag}, not ${tag}`);
  return { tag, keyId: id!, digests: parsed.digests };
}
