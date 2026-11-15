// The server's rate limits: the core limiter (src/core/rate_limit.ts) with a
// sweep failure reported through the hosted diagnostics, and the defaults.
import { RateLimiter as CoreRateLimiter, type RateLimit, type StreakHooks } from "../core/rate_limit.ts";
import { hostedFailure } from "./hosted-diagnostics.ts";

export { retrySecs, type RateLimit, type StreakContext, type StreakHooks, type Take } from "../core/rate_limit.ts";

export const DEFAULT_HELLO_LIMIT: RateLimit = { burst: 60, perSec: 1 };
export const DEFAULT_HOSTED_REQUEST_LIMIT: RateLimit = { burst: 120, perSec: 20 };
// Delivery upkeep (role=subscriber: renews, inbox reads, receipts) has its own per-user bucket, so one
// user's fan-out can't throttle that user's tool calls (#845). Sized for the default 32 leases per user:
// burst = 32 leases x 5 requests (a delivery's read, renews and receipt) x 1.5; rate = 32 x (0.2 idle +
// 0.25 deliveries/s x 4 requests), rounded up. docs/guide/server.md §Sizing the caps has the formula.
export const DEFAULT_HOSTED_SUBSCRIBER_LIMIT: RateLimit = { burst: 240, perSec: 40 };
export const DEFAULT_AUTH_FAIL_LIMIT: RateLimit = { burst: 60, perSec: 1 };

export class RateLimiter extends CoreRateLimiter {
  constructor(limit: RateLimit, hooks: StreakHooks, now?: () => number, maxKeys?: number) {
    super(limit, { sweepFailed: (e) => hostedFailure("rate_limit.end", e), ...hooks }, now, maxKeys);
  }
}
