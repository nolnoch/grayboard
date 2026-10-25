// The address a request comes from, for the auth-failure limit (#240) and
// the audit trail: the peer, or behind trusted proxies the first untrusted
// X-Forwarded-For entry from the right.
import { BlockList, isIP } from "node:net";

// Unset GRAYBOARD_TRUSTED_PROXIES: a proxy on the same host (Caddy).
export const DEFAULT_TRUSTED_PROXIES = ["127.0.0.0/8", "::1/128"];

/** A validated, normalised `a.b.c.d/n` or `x::y/n`, or throws naming `raw`. */
export function parseCidr(raw: string): string {
  const [addr = "", prefix, extra] = raw.trim().split("/");
  const ip = normalizeIp(addr);
  const max = ip && isIP(ip) === 4 ? 32 : 128;
  if (!ip || extra !== undefined || (prefix !== undefined && !(/^[0-9]{1,3}$/.test(prefix) && Number(prefix) <= max))) {
    throw new Error(`"${raw}" is not an IP address or CIDR`);
  }
  return `${ip}/${prefix ?? max}`;
}

export class TrustedProxies {
  private readonly list = new BlockList();

  constructor(cidrs: string[]) {
    for (const c of cidrs) {
      const [ip, prefix] = parseCidr(c).split("/") as [string, string];
      this.list.addSubnet(ip, Number(prefix), isIP(ip) === 4 ? "ipv4" : "ipv6");
    }
  }

  has(ip: string): boolean {
    return this.list.check(ip, isIP(ip) === 4 ? "ipv4" : "ipv6");
  }
}

/** An address as the limiter and the audit trail key it: IPv4-mapped IPv6
 *  (how Bun reports an IPv4 peer) as IPv4, lowercase, no zone. Null when
 *  it isn't an address. */
export function normalizeIp(raw: string): string | null {
  let ip = raw.trim().toLowerCase();
  const zone = ip.indexOf("%");
  if (zone >= 0) ip = ip.slice(0, zone);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped) ip = mapped[1]!;
  return isIP(ip) ? ip : null;
}

/** The client's address: the peer unless it's a trusted proxy, then the
 *  first untrusted X-Forwarded-For entry walking from the right. A trusted
 *  peer whose walk ends without one (no header, every entry trusted, or an
 *  entry that doesn't parse) is keyed by the last address the walk trusted. */
export function clientAddress(peer: string | null | undefined, xff: string | null, trusted: TrustedProxies): string | null {
  let addr = peer ? normalizeIp(peer) : null;
  if (!addr || !trusted.has(addr)) return addr;
  const hops = xff ? xff.split(",") : [];
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = normalizeIp(hops[i]!);
    if (!hop) return addr;
    addr = hop;
    if (!trusted.has(hop)) return hop;
  }
  return addr;
}

/** The limiter's key for an address: IPv4 as is, IPv6 by its /64, so one
 *  host can't rotate through its prefix. */
export function rateKey(ip: string): string {
  if (isIP(ip) === 4) return ip;
  return `${expandV6(ip).slice(0, 4).map((g) => g.toString(16)).join(":")}::/64`;
}

// An IPv6 address's eight groups.
function expandV6(ip: string): number[] {
  const groups = (part: string): number[] => {
    if (!part) return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (g.includes(".")) {
        const [a, b, c, d] = g.split(".").map(Number) as [number, number, number, number];
        out.push((a << 8) | b, (c << 8) | d);
      } else {
        out.push(parseInt(g, 16));
      }
    }
    return out;
  };
  const [head = "", tail] = ip.split("::");
  const h = groups(head);
  if (tail === undefined) return h;
  const t = groups(tail);
  return [...h, ...Array(8 - h.length - t.length).fill(0), ...t];
}
