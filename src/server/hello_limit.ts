// A per-user token bucket on hellos (#210). A read-only or create: false
// hello costs database work before anything is bound, so one signed-in
// client looping on connect could load the server and grow binding_events.

export type HelloLimit = { burst: number; perSec: number };

export const DEFAULT_HELLO_LIMIT: HelloLimit = { burst: 60, perSec: 1 };

// A run of refusals for one user: from the first refusal to the next
// accepted hello, or to the sweep that finds the bucket refilled.
export type StreakHooks = {
  start(userId: number, email: string): void;
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
  take(userId: number, email: string): Take {
    const b = this.refill(userId, email);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      this.endStreak(userId, b);
      return { ok: true };
    }
    if (b.refused++ === 0) this.hooks.start(userId, email);
    return { ok: false, retryAfterMs: Math.ceil(((1 - b.tokens) / this.limit.perSec) * 1000) };
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
