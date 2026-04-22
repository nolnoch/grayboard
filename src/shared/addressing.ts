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

export function isValidIdentityName(name: string): boolean {
  return NAME_RE.test(name.toLowerCase());
}
