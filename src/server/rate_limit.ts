// Keyed token buckets with streak hooks, for work the server does before it
// knows a request is worth it: hellos per user (#210), where a read-only or
// create: false hello costs database work before anything is bound, and
// authentication failures per client address (#240), where each bad token
// costs a lookup.

export type RateLimit = { burst: number; perSec: number };

export const DEFAULT_HELLO_LIMIT: RateLimit = { burst: 60, perSec: 1 };
export const DEFAULT_HOSTED_REQUEST_LIMIT: RateLimit = { burst: 120, perSec: 20 };
export const DEFAULT_AUTH_FAIL_LIMIT: RateLimit = { burst: 60, perSec: 1 };

// What a request asked for: the tripping request's, carried to the streak's
// start so the audit row says what set it off, and the latest spend's, so it
// says what drained the bucket.
export type StreakContext = Record<string, unknown>;

// A run of refusals for one key: from the first refusal until the bucket is
// full again, seen by a check or by the sweep. Ending it at any accepted
// request would let a loop just faster than the refill alternate accept and
// refuse, starting a new streak (and an audit row) at every refusal.
export type StreakHooks = {
  start(key: string, ctx: StreakContext, retryAfterMs: number, lastSpend: StreakContext | null): void;
  end(key: string, refused: number): void;
  // The limiter is at its key cap and let new keys through uncharged:
  // `uncharged` spends since the last call, which comes at most once a minute.
  full?(size: number, uncharged: number): void;
};

type Bucket = { tokens: number; at: number; refused: number; last: StreakContext | null };

export type Take = { ok: true } | { ok: false; retryAfterMs: number };

const FULL_NOTICE_MS = 60_000;

/** The whole seconds a client is told to wait, never 0. */
export function retrySecs(retryAfterMs: number): number {
  return Math.max(1, Math.ceil(retryAfterMs / 1000));
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private fullNoticeAt = -Infinity;
  private uncharged = 0;

  constructor(
    private readonly limit: RateLimit,
    private readonly hooks: StreakHooks,
    private readonly now: () => number = Date.now,
    // Past this many buckets a new key is neither charged nor refused: a
    // flood spread across keys belongs at the network edge, not in memory.
    private readonly maxKeys = Infinity,
  ) {}

  /** Spend one token for `key`, or say how long until one is back. */
  take(key: string, ctx: StreakContext = {}): Take {
    const t = this.check(key, ctx);
    if (t.ok) this.spend(key, ctx);
    return t;
  }

  /** Whether `key` may go ahead, without spending. A key with no bucket
   *  costs no allocation, so this can run on every request. */
  check(key: string, ctx: StreakContext = {}): Take {
    const b = this.buckets.get(key);
    if (!b) return { ok: true };
    this.refill(b);
    if (b.tokens >= this.limit.burst) this.endStreak(key, b);
    if (b.tokens >= 1) return { ok: true };
    const retryAfterMs = Math.ceil(((1 - b.tokens) / this.limit.perSec) * 1000);
    // Counted only once the start is recorded: a hook that throws leaves the
    // next refusal to start the streak, not a streak with no record.
    if (b.refused === 0) this.hooks.start(key, ctx, retryAfterMs, b.last);
    b.refused++;
    return { ok: false, retryAfterMs };
  }

  /** Spend one token for `key`; never below empty, so requests that passed
   *  the check together don't push the wait past one token's refill. */
  spend(key: string, ctx: StreakContext = {}): void {
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) return this.noticeFull();
      b = { tokens: this.limit.burst, at: this.now(), refused: 0, last: null };
      this.buckets.set(key, b);
    }
    this.refill(b);
    b.tokens = Math.max(0, b.tokens - 1);
    b.last = ctx;
  }

  /** Drop the buckets that have refilled, ending their streaks first. A
   *  bucket whose end hook throws stays, so the next sweep retries it, and
   *  the rest are still swept. */
  sweep(): void {
    for (const [key, b] of this.buckets) {
      this.refill(b);
      if (b.tokens < this.limit.burst) continue;
      try {
        this.endStreak(key, b);
      } catch (e) {
        hostedFailure("rate_limit.end", e);
        continue;
      }
      this.buckets.delete(key);
    }
  }

  /** How many keys have a bucket, for tests. */
  get size(): number {
    return this.buckets.size;
  }

  private refill(b: Bucket): void {
    const now = this.now();
    b.tokens = Math.min(this.limit.burst, b.tokens + ((now - b.at) / 1000) * this.limit.perSec);
    b.at = now;
  }

  private endStreak(key: string, b: Bucket): void {
    if (b.refused === 0) return;
    this.hooks.end(key, b.refused);
    b.refused = 0;
  }

  private noticeFull(): void {
    this.uncharged++;
    const now = this.now();
    if (now - this.fullNoticeAt < FULL_NOTICE_MS) return;
    this.fullNoticeAt = now;
    const n = this.uncharged;
    this.uncharged = 0;
    this.hooks.full?.(this.buckets.size, n);
  }
}
import { hostedFailure } from "./hosted-diagnostics.ts";
