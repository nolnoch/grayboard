// A session ID's shape (#284): `id:` and 13 Crockford base32 characters. A
// leaf module: boards.ts builds its mention pattern from it at load, and
// bindings.ts imports boards.ts.

// Crockford's base32, lowercased: no i, l, o or u, so an ID reads back
// unambiguously. IDs are only ever compared, never decoded.
const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

/** 16 hex characters (64 bits) as 13 Crockford base32 characters. */
export function crockford13(hex16: string): string {
  let n = BigInt(`0x${hex16}`);
  let out = "";
  for (let i = 0; i < 13; i++) {
    out = CROCKFORD[Number(n & 31n)]! + out;
    n >>= 5n;
  }
  return out;
}

/** A session ID's shape: `id:` and 13 Crockford characters, unanchored. */
export const SESSION_ID_PATTERN = `id:[${CROCKFORD}]{13}`;
/** A session ID's shape: `id:` and 13 Crockford characters. */
export const SESSION_ID = new RegExp(`^${SESSION_ID_PATTERN}$`);
