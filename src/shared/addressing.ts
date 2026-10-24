const DIRECT_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\/[a-z0-9_-]{1,32}$/;
const TEAM_RE   = /^team:[a-z0-9_-]{1,32}$/;
const NAME_RE   = /^[a-z0-9_-]{1,32}$/;

export type DirectAddress = { kind: "user"; full: string; email: string; name: string };
export type TeamAddress   = { kind: "team"; full: string; name: string };
export type Address = DirectAddress | TeamAddress;

export function parseAddress(input: string): Address {
  const s = input.toLowerCase();
  if (TEAM_RE.test(s)) {
    return { kind: "team", full: s, name: s.slice(5) };
  }
  if (DIRECT_RE.test(s)) {
    const slash = s.indexOf("/");
    return { kind: "user", full: s, email: s.slice(0, slash), name: s.slice(slash + 1) };
  }
  throw new Error(
    `invalid address "${input}": expected "user@example.com/name" or "team:name"`,
  );
}

export function formatDirectAddress(email: string, name: string): string {
  const full = `${email.toLowerCase()}/${name.toLowerCase()}`;
  if (!DIRECT_RE.test(full)) throw new Error(`invalid direct address: "${full}"`);
  return full;
}

export function formatTeamAddress(name: string): string {
  const full = `team:${name.toLowerCase()}`;
  if (!TEAM_RE.test(full)) throw new Error(`invalid team address: "${full}"`);
  return full;
}

// An email a direct address can carry: a user whose email isn't one could
// sign in but never be addressed (#72).
export function isValidEmail(email: string): boolean {
  return DIRECT_RE.test(`${email.toLowerCase()}/x`);
}

export function isValidIdentityName(name: string): boolean {
  return NAME_RE.test(name.toLowerCase());
}

export type NormalizedName = { ok: true; name: string } | { ok: false; error: string };

/**
 * An explicit identity (a BUS_IDENTITY or a pin) made to the server's one
 * naming rule (#181): lowercased, then [a-z0-9_-], 1-32 chars. The server
 * lowercased at hello, so local did too at the point the name is claimed —
 * otherwise one configuration yielded different handles per mode. Local
 * startup refuses a name that fails after lowercasing, with the reason;
 * #182's bind reuses this for its own names.
 */
export function normalizeIdentityName(raw: string): NormalizedName {
  const name = raw.toLowerCase();
  if (!NAME_RE.test(name)) {
    return { ok: false, error: `invalid identity name "${raw}": after lowercasing, must be 1-32 chars of a-z 0-9 _ -` };
  }
  return { ok: true, name };
}

// On a server, every user's human identity has this name, and only the
// server's Slack bridge can hold it: so "<email>/human" is that user's person,
// and a bare "human" means your own.
export const HUMAN_NAME = "human";

export const HUMAN_RESERVED =
  `"${HUMAN_NAME}" is reserved for your Slack link (grayboard slack link); give this session another name`;
