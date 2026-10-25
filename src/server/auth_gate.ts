// The per-address limit on authentication failures (#240). Every 401 the
// server answers, and every call to a sign-in route, costs the client's
// address a token; while its bucket is empty, every request from it gets 429
// before anything reads the database. Valid authenticated traffic costs
// nothing, so a stale-token client behind a shared address only blocks its
// neighbours after it has failed the whole burst.
import type { Repo } from "./db.ts";
import { writeAudit } from "./audit.ts";
import { clientAddress, rateKey, TrustedProxies } from "./client_addr.ts";
import { DEFAULT_AUTH_FAIL_LIMIT, RateLimiter, type RateLimit } from "./rate_limit.ts";

// The most addresses the limiter tracks at once; past it a new address goes
// unlimited, with one log line a minute.
export const AUTH_FAIL_MAX_KEYS = 10_000;

export type AuthGateOptions = {
  limit?: RateLimit;
  trustedProxies: string[];
  now?: () => number;
  maxKeys?: number;
};

// A request the gate has placed: the client's address, for the audit trail,
// and the limiter's key for it (null when the peer is unknown).
export type Caller = { ip: string | null; key: string | null };

export class AuthGate {
  private readonly limiter: RateLimiter<string>;
  private readonly trusted: TrustedProxies;

  constructor(repo: Repo, opts: AuthGateOptions) {
    this.trusted = new TrustedProxies(opts.trustedProxies);
    // Logged and audited once per run of refusals, so a flood floods neither.
    this.limiter = new RateLimiter<string>(opts.limit ?? DEFAULT_AUTH_FAIL_LIMIT, {
      start: (key, _label, ctx, retryAfterMs) => {
        console.error(`[grayboard] rate-limiting ${key} after repeated authentication failures`);
        writeAudit(repo, "auth.rate_limited", null, key, { ...ctx, retry_after_ms: retryAfterMs });
      },
      end: (key, _label, refused) => {
        console.error(`[grayboard] ${key} no longer rate-limited; ${refused} refused`);
        writeAudit(repo, "auth.rate_limit_ended", null, key, { refused });
      },
      full: (size) => console.error(`[grayboard] auth-failure limiter is tracking ${size} addresses, its cap; new addresses go unlimited`),
    }, opts.now, opts.maxKeys ?? AUTH_FAIL_MAX_KEYS);
  }

  /** Where `req` comes from, given the peer Bun reports. */
  caller(req: Request, peer: string | null | undefined): Caller {
    const ip = clientAddress(peer, req.headers.get("x-forwarded-for"), this.trusted);
    return { ip, key: ip ? rateKey(ip) : null };
  }

  /** The 429 for a limited caller, or null to go ahead. */
  refuse(c: Caller, path: string): Response | null {
    if (!c.key) return null;
    const t = this.limiter.check(c.key, c.key, { path });
    if (t.ok) return null;
    const secs = Math.max(1, Math.ceil(t.retryAfterMs / 1000));
    return Response.json(
      { code: "rate_limited", message: `too many authentication failures from this address; retry in ${secs}s`, retry_after_ms: t.retryAfterMs },
      { status: 429, headers: { "Retry-After": String(secs) } },
    );
  }

  /** Charge the caller one authentication failure. */
  charge(c: Caller): void {
    if (c.key) this.limiter.spend(c.key, c.key);
  }

  /** Charge the caller if `res` is a 401; passes `res` through. */
  chargeIf401(c: Caller, res: Response): Response {
    if (res.status === 401) this.charge(c);
    return res;
  }

  /** Drop refilled buckets, ending their runs: the 30s heartbeat. */
  sweep(): void {
    this.limiter.sweep();
  }

  /** How many addresses have a bucket, for tests. */
  get size(): number {
    return this.limiter.size;
  }
}
