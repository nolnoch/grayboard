// A per-user token bucket on hellos (#210). A read-only or create: false
// hello costs database work before anything is bound, so one signed-in
// client looping on connect could load the server and grow binding_events.

export type HelloLimit = { burst: number; perSec: number };

export const DEFAULT_HELLO_LIMIT: HelloLimit = { burst: 60, perSec: 1 };

// What the tripping hello asked for, carried to the streak's start so the
// audit row says which session, name and place set it off.
export type HelloContext = Record<string, unknown>;

// A run of refusals for one user: from the first refusal until the bucket is
// full again, seen by a take or by the sweep. Ending it at any accepted hello
// would let a loop just faster than the refill alternate accept and refuse,
// starting a new streak (and an audit row) at every refusal.
export type StreakHooks = {
  start(userId: number, email: string, ctx: HelloContext, retryAfterMs: number): void;
  end(userId: number, email: string, refused: number): void;
};

type Bucket = { tokens: number; at: number; email: string; refused: number };

export type Take = { ok: true } | { ok: false; retryAfterMs: number };

export class HelloLimiter {
  private buckets = new Map<number, Bucket>();

  constructor(
    private readonly limit: HelloLimit,
    private readonly hooks: StreakHooks,
    private readonly now: () => number = Date.now,
  ) {}

  /** Spend one hello for `userId`, or say how long until one is back. */
  take(userId: number, email: string, ctx: HelloContext = {}): Take {
    const b = this.refill(userId, email);
    if (b.tokens >= this.limit.burst) this.endStreak(userId, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true };
    }
    const retryAfterMs = Math.ceil(((1 - b.tokens) / this.limit.perSec) * 1000);
    if (b.refused++ === 0) this.hooks.start(userId, email, ctx, retryAfterMs);
    return { ok: false, retryAfterMs };
  }

  /** Drop the buckets that have refilled, ending their streaks first. */
  sweep(): void {
    for (const [userId] of this.buckets) {
      const b = this.refill(userId);
      if (b.tokens < this.limit.burst) continue;
      this.endStreak(userId, b);
      this.buckets.delete(userId);
    }
  }

  /** How many users have a bucket, for tests. */
  get size(): number {
    return this.buckets.size;
  }

  private refill(userId: number, email?: string): Bucket {
    const now = this.now();
    let b = this.buckets.get(userId);
    if (!b) {
      b = { tokens: this.limit.burst, at: now, email: email ?? "", refused: 0 };
      this.buckets.set(userId, b);
    }
    b.tokens = Math.min(this.limit.burst, b.tokens + ((now - b.at) / 1000) * this.limit.perSec);
    b.at = now;
    if (email !== undefined) b.email = email;
    return b;
  }

  private endStreak(userId: number, b: Bucket): void {
    if (b.refused === 0) return;
    this.hooks.end(userId, b.email, b.refused);
    b.refused = 0;
  }
}
