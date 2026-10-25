// Keyed token buckets with streak hooks, for work the server does before it
// knows a request is worth it: hellos per user (#210), where a read-only or
// create: false hello costs database work before anything is bound, and
// authentication failures per client address (#240), where each bad token
// costs a lookup.

export type RateLimit = { burst: number; perSec: number };

export const DEFAULT_HELLO_LIMIT: RateLimit = { burst: 60, perSec: 1 };
export const DEFAULT_AUTH_FAIL_LIMIT: RateLimit = { burst: 60, perSec: 1 };

// What the tripping request asked for, carried to the streak's start so the
// audit row says what set it off.
export type StreakContext = Record<string, unknown>;

// A run of refusals for one key: from the first refusal until the bucket is
// full again, seen by a check or by the sweep. Ending it at any accepted
// request would let a loop just faster than the refill alternate accept and
// refuse, starting a new streak (and an audit row) at every refusal.
export type StreakHooks<K> = {
  start(key: K, label: string, ctx: StreakContext, retryAfterMs: number): void;
  end(key: K, label: string, refused: number): void;
  // The limiter is at its key cap and let a new key through uncharged;
  // called at most once a minute.
  full?(size: number): void;
};

type Bucket = { tokens: number; at: number; label: string; refused: number };

export type Take = { ok: true } | { ok: false; retryAfterMs: number };

const FULL_NOTICE_MS = 60_000;

export class RateLimiter<K> {
  private buckets = new Map<K, Bucket>();
  private fullNoticeAt = -Infinity;

  constructor(
    private readonly limit: RateLimit,
    private readonly hooks: StreakHooks<K>,
    private readonly now: () => number = Date.now,
    // Past this many buckets a new key is neither charged nor refused: a
    // flood spread across keys belongs at the network edge, not in memory.
    private readonly maxKeys = Infinity,
  ) {}

  /** Spend one token for `key`, or say how long until one is back. */
  take(key: K, label: string, ctx: StreakContext = {}): Take {
    const t = this.check(key, label, ctx);
    if (t.ok) this.spend(key, label);
    return t;
  }

  /** Whether `key` may go ahead, without spending. A key with no bucket
   *  costs no allocation, so this can run on every request. */
  check(key: K, label: string, ctx: StreakContext = {}): Take {
    const b = this.buckets.get(key);
    if (!b) return { ok: true };
    this.refill(b, label);
    if (b.tokens >= this.limit.burst) this.endStreak(key, b);
    if (b.tokens >= 1) return { ok: true };
    const retryAfterMs = Math.ceil(((1 - b.tokens) / this.limit.perSec) * 1000);
    if (b.refused++ === 0) this.hooks.start(key, b.label, ctx, retryAfterMs);
    return { ok: false, retryAfterMs };
  }

  /** Spend one token for `key`; never below empty, so requests that passed
   *  the check together don't push the wait past one token's refill. */
  spend(key: K, label: string): void {
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) return this.noticeFull();
      b = { tokens: this.limit.burst, at: this.now(), label, refused: 0 };
      this.buckets.set(key, b);
    }
    this.refill(b, label);
    b.tokens = Math.max(0, b.tokens - 1);
  }

  /** Drop the buckets that have refilled, ending their streaks first. */
  sweep(): void {
    for (const [key, b] of this.buckets) {
      this.refill(b);
      if (b.tokens < this.limit.burst) continue;
      this.endStreak(key, b);
      this.buckets.delete(key);
    }
  }

  /** How many keys have a bucket, for tests. */
  get size(): number {
    return this.buckets.size;
  }

  private refill(b: Bucket, label?: string): void {
    const now = this.now();
    b.tokens = Math.min(this.limit.burst, b.tokens + ((now - b.at) / 1000) * this.limit.perSec);
    b.at = now;
    if (label !== undefined) b.label = label;
  }

  private endStreak(key: K, b: Bucket): void {
    if (b.refused === 0) return;
    this.hooks.end(key, b.label, b.refused);
    b.refused = 0;
  }

  private noticeFull(): void {
    const now = this.now();
    if (now - this.fullNoticeAt < FULL_NOTICE_MS) return;
    this.fullNoticeAt = now;
    this.hooks.full?.(this.buckets.size);
  }
}
