// The per-address limit on authentication failures (#240). A presented token
// the server refuses, and every call to a sign-in route, costs the client's
// address a token; while its bucket is empty, every request from it gets 429
// before anything reads the database. Valid authenticated traffic costs
// nothing, so a stale-token client behind a shared address only blocks its
// neighbours after it has failed the whole burst. A request with no token
// costs nothing either: a web page can make a browser send those cross-origin
// (an <img>, a WebSocket), but not an Authorization header without a CORS
// preflight, so charging them would let any page lock out an office.
//
// A refused token is remembered, with the 401 it got, so a client looping on
// a stale token is answered from memory, uncharged and without a lookup: it
// costs its address one token a minute per path, under any refill rate the
// config allows, instead of draining the bucket for everyone behind the
// address (#923). Many distinct bad tokens still drain it, as a scan should.
import type { Repo } from "./db.ts";
import { extractBearer, hashToken } from "./auth.ts";
import { userAgent, writeAudit } from "./audit.ts";
import { clientAddress, rateKey, TrustedProxies } from "./client_addr.ts";
import { RateLimiter, retrySecs, type RateLimit } from "./rate_limit.ts";

// The most addresses the limiter tracks at once; past it a new address goes
// unlimited, with one log line and audit row a minute.
export const AUTH_FAIL_MAX_KEYS = 10_000;

// The bucket of a request whose peer Bun can't report (one already closed):
// shared, so such requests are still limited rather than skipping the gate.
export const UNKNOWN_PEER_KEY = "unknown";

// How long a refused token is answered from memory. A refused token stays
// refused, except a disabled user's after an admin re-enables them: this
// bounds how long that user waits.
export const REFUSED_TOKEN_TTL_MS = 60_000;

// The most refused tokens remembered; past it the oldest is forgotten, and
// charged again if it comes back.
export const REFUSED_TOKEN_MAX = 10_000;

type Refused = { until: number; status: number; headers: [string, string][]; body: Promise<ArrayBuffer> };

export type AuthGateOptions = {
  limit: RateLimit;
  trustedProxies: readonly string[];
  now?: () => number;
  maxKeys?: number;
  refusedTtlMs?: number;
  refusedMax?: number;
};

// A request the gate has placed: the client's address, for the audit trail
// (null when the peer is unknown), and the limiter's key for it.
export type Caller = { ip: string | null; key: string };

// Why a request cost its address a token, kept for the audit row of the
// run of refusals it leads to.
export type FailureReason = "refused token" | "sign-in";

export class AuthGate {
  private readonly limiter: RateLimiter;
  private readonly trusted: TrustedProxies;
  private readonly now: () => number;
  // Insertion-ordered, so the first key is the oldest.
  private readonly refused = new Map<string, Refused>();
  private readonly refusedTtlMs: number;
  private readonly refusedMax: number;

  constructor(repo: Repo, opts: AuthGateOptions) {
    this.trusted = new TrustedProxies(opts.trustedProxies);
    this.now = opts.now ?? Date.now;
    this.refusedTtlMs = opts.refusedTtlMs ?? REFUSED_TOKEN_TTL_MS;
    this.refusedMax = opts.refusedMax ?? REFUSED_TOKEN_MAX;
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

  /**
   * The remembered 401 for this request's token on this path and query, or
   * null to go on. Charges nothing. `url` is the request's, already parsed.
   */
  replayRefused(req: Request, url: URL): Promise<Response> | null {
    if (this.refused.size === 0 || !extractBearer(req)) return null;
    const key = refusedKey(req, url);
    const r = this.live(key);
    return r ? r.body.then((body) => new Response(body, { status: r.status, headers: r.headers })) : null;
  }

  /**
   * Charge the caller if `res` refused a token `req` presented, and remember
   * the refusal; passes `res` through. A token already remembered isn't
   * charged again, so requests that were in flight together cost one.
   */
  chargeRefusedToken(c: Caller, req: Request, path: string, res: Response): Promise<Response> | Response {
    if (res.status !== 401 || !extractBearer(req)) return res;
    const key = refusedKey(req, new URL(req.url));
    const known = this.live(key);
    if (known) return res;
    this.charge(c, req, path, "refused token");
    // Remembered before the body is read, so a concurrent refusal sees it.
    if (this.refused.size >= this.refusedMax) this.refused.delete(this.refused.keys().next().value!);
    const headers = [...res.headers];
    const body = res.arrayBuffer();
    this.refused.set(key, { until: this.now() + this.refusedTtlMs, status: res.status, headers, body });
    return body.then((b) => new Response(b, { status: res.status, statusText: res.statusText, headers }));
  }

  // The live entry under `key`, dropping it if expired.
  private live(key: string): Refused | undefined {
    const r = this.refused.get(key);
    if (r && r.until <= this.now()) { this.refused.delete(key); return undefined; }
    return r;
  }

  /** Drop refilled buckets, ending their runs, and expired refusals: every 30s, with the hello sweep (app.ts). */
  sweep(): void {
    this.limiter.sweep();
    // Entries share one TTL and are inserted in time order, so the expired are a prefix.
    const t = this.now();
    for (const [key, r] of this.refused) {
      if (r.until > t) break;
      this.refused.delete(key);
    }
  }

  /** How many refused tokens are remembered, for tests. */
  get refusedSize(): number {
    return this.refused.size;
  }

  /** How many addresses have a bucket, for tests. */
  get size(): number {
    return this.limiter.size;
  }
}

// The path, query and Authorization header exactly as sent, hashed: a fixed
// size whatever the client sends, and a token presented in another shape (or
// beside an access_token query) is a different entry from the token itself.
const refusedKey = (req: Request, url: URL) => hashToken(`${url.pathname}${url.search}\n${req.headers.get("authorization")}`);
