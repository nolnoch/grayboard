// The server's rate limits: the core limiter (src/core/rate_limit.ts) with a
// sweep failure reported through the hosted diagnostics, and the defaults.
import { RateLimiter as CoreRateLimiter, type RateLimit, type StreakHooks } from "../core/rate_limit.ts";
import { hostedFailure } from "./hosted-diagnostics.ts";

export { retrySecs, type RateLimit, type StreakContext, type StreakHooks, type Take } from "../core/rate_limit.ts";

export const DEFAULT_HELLO_LIMIT: RateLimit = { burst: 60, perSec: 1 };
export const DEFAULT_HOSTED_REQUEST_LIMIT: RateLimit = { burst: 120, perSec: 20 };
export const DEFAULT_AUTH_FAIL_LIMIT: RateLimit = { burst: 60, perSec: 1 };

export class RateLimiter extends CoreRateLimiter {
  constructor(limit: RateLimit, hooks: StreakHooks, now?: () => number, maxKeys?: number) {
    super(limit, { sweepFailed: (e) => hostedFailure("rate_limit.end", e), ...hooks }, now, maxKeys);
  }
}
