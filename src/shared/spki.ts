// Public-key helpers with no dependency on the generated key list, so
// scripts/release_keys.ts can regenerate src/shared/release_keys.ts even when
// that file is broken (#162).
import { sha256Hex } from "./hash.ts";

/** An SPKI PEM's DER bytes. */
export function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const m = /^-----BEGIN PUBLIC KEY-----\n([A-Za-z0-9+/=\n]+)-----END PUBLIC KEY-----\n?$/.exec(pem);
  if (!m) throw new Error("not a PEM public key");
  return Uint8Array.from(Buffer.from(m[1]!.replace(/\n/g, ""), "base64"));
}

/** A key's id: the first 16 hex characters of sha256 over its SPKI DER. */
export function keyId(pem: string): string {
  return sha256Hex(pemToDer(pem)).slice(0, 16);
}
