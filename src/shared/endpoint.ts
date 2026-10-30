// The one rule for an HTTP endpoint a client sends a bearer or a refresh
// token to (#430): HTTPS, or HTTP only on loopback; no credentials, query or
// fragment, and nothing a parser could read two ways (controls, spaces, a
// backslash, percent-encoding). Callers add their own path rules. Runs under
// Node too: the pi and omp bundles import it through hosted-core.
const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);

export function canonicalEndpoint(raw: string): URL | undefined {
  if (typeof raw !== "string" || raw.length > 2048 || /[\x00-\x20\x7f\\%?#]/.test(raw)) return undefined;
  let u: URL;
  try { u = new URL(raw); } catch { return undefined; }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.has(u.hostname))) return undefined;
  if (u.username || u.password || u.search || u.hash) return undefined;
  return u;
}
