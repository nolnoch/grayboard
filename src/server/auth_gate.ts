// The per-address limit on authentication failures (#240). A presented token
// the server refuses, and every call to a sign-in route, costs the client's
// address a token; while its bucket is empty, every request from it gets 429
// before anything reads the database. Valid authenticated traffic costs
// nothing, so a stale-token client behind a shared address only blocks its
// neighbours after it has failed the whole burst. A request with no token
// costs nothing either: a web page can make a browser send those cross-origin
// (an <img>, a WebSocket), but not an Authorization header without a CORS
// preflight, so charging them would let any page lock out an office.
import type { Repo } from "./db.ts";
import { extractBearer } from "./auth.ts";
import { userAgent, writeAudit } from "./audit.ts";
import { clientAddress, rateKey, TrustedProxies } from "./client_addr.ts";
import { RateLimiter, retrySecs, type RateLimit } from "./rate_limit.ts";

// The most addresses the limiter tracks at once; past it a new address goes
// unlimited, with one log line and audit row a minute.
export const AUTH_FAIL_MAX_KEYS = 10_000;

// The bucket of a request whose peer Bun can't report (one already closed):
// shared, so such requests are still limited rather than skipping the gate.
export const UNKNOWN_PEER_KEY = "unknown";

export type AuthGateOptions = {
  limit: RateLimit;
  trustedProxies: readonly string[];
  now?: () => number;
  maxKeys?: number;
};

// A request the gate has placed: the client's address, for the audit trail
// (null when the peer is unknown), and the limiter's key for it.
export type Caller = { ip: string | null; key: string };

// Why a request cost its address a token, kept for the audit row of the
// run of refusals it leads to.
export type FailureReason = "invalid token" | "refused token" | "sign-in";

export class AuthGate {
  private readonly limiter: RateLimiter;
  private readonly trusted: TrustedProxies;

  constructor(repo: Repo, opts: AuthGateOptions) {
    this.trusted = new TrustedProxies(opts.trustedProxies);
    // Logged and audited once per run of refusals, so a flood floods neither.
    // The start row says what tripped the limit (addr, path) and what drained
    // it (last_failure), so a stale-token fleet reads differently from a scan.
    this.limiter = new RateLimiter(opts.limit, {
      start: (key, ctx, retryAfterMs, lastFailure) => {
        console.error(`[grayboard] rate-limiting ${key} after repeated authentication failures`);
        writeAudit(repo, "auth.rate_limited", null, key, { ...ctx, retry_after_ms: retryAfterMs, last_failure: lastFailure });
      },
      end: (key, refused) => {
        console.error(`[grayboard] ${key} no longer rate-limited; ${refused} refused`);
        writeAudit(repo, "auth.rate_limit_ended", null, key, { refused });
      },
      full: (size, uncharged) => {
        console.error(`[grayboard] auth-failure limiter is tracking ${size} addresses, its cap; ${uncharged} failures from new addresses went uncharged`);
        writeAudit(repo, "auth.rate_limit_full", null, null, { tracked: size, uncharged });
      },
    }, opts.now, opts.maxKeys ?? AUTH_FAIL_MAX_KEYS);
  }

  /** Where `req` comes from, given the peer Bun reports. */
  caller(req: Request, peer: string | null | undefined): Caller {
    const ip = clientAddress(peer, req.headers.get("x-forwarded-for"), this.trusted);
    return { ip, key: ip ? rateKey(ip) : UNKNOWN_PEER_KEY };
  }

  /** The 429 for a limited caller, or null to go ahead. */
  refuse(c: Caller, path: string): Response | null {
    const t = this.limiter.check(c.key, { addr: c.ip, path });
    if (t.ok) return null;
    const secs = retrySecs(t.retryAfterMs);
    return Response.json(
      { code: "rate_limited", message: `too many authentication failures from this address; retry in ${secs}s`, retry_after_ms: t.retryAfterMs },
      { status: 429, headers: { "Retry-After": String(secs) } },
    );
  }

  /** Charge the caller one authentication failure. */
  charge(c: Caller, req: Request, path: string, reason: FailureReason): void {
    this.limiter.spend(c.key, { addr: c.ip, path, reason, ua: userAgent(req) });
  }

  /** Charge the caller if `res` refused a token `req` presented; passes `res` through. */
  chargeRefusedToken(c: Caller, req: Request, path: string, res: Response): Response {
    if (res.status === 401 && extractBearer(req)) this.charge(c, req, path, "refused token");
    return res;
  }

  /** Drop refilled buckets, ending their runs: every 30s, with the hello sweep (app.ts). */
  sweep(): void {
    this.limiter.sweep();
  }

  /** How many addresses have a bucket, for tests. */
  get size(): number {
    return this.limiter.size;
  }
}
