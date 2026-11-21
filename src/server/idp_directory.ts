// What every directory status check (#930 A2, docs/server-offboarding.md §3) shares: a service credential's access
// token, cached and minted one request at a time; a caller's wait that its own abort ends; and an IdP's refusal text,
// logged at most once per window per text.

// An access token is reused until this long before its expiry, so a call never carries one about to lapse.
const TOKEN_MARGIN_MS = 60_000;
// The token request is shared by every check waiting on it, so it runs on its own clock, never one caller's: a caller
// that gives up stops waiting, and the mint goes on for the others.
export const MINT_TIMEOUT_MS = 10_000;
// The audit row carries only an error's class; the IdP's text is what tells an operator what to fix.
const LOG_EVERY_MS = 10 * 60_000;

// mint(signal) returns the token and its lifetime in seconds; signal is the mint's own MINT_TIMEOUT_MS.
export function tokenCache(mint: (signal: AbortSignal) => Promise<{ token: string; expiresIn: number }>, now: () => number) {
  let cached: { token: string; until: number } | undefined;
  let minting: Promise<string> | undefined;
  return {
    get(signal: AbortSignal): Promise<string> {
      if (cached && cached.until > now()) return Promise.resolve(cached.token);
      minting ??= mint(AbortSignal.timeout(MINT_TIMEOUT_MS)).then(({ token, expiresIn }) => {
        cached = { token, until: now() + expiresIn * 1000 - TOKEN_MARGIN_MS };
        return token;
      }).finally(() => { minting = undefined; });
      return abortable(minting, signal);
    },
    // A 401 from the API: the token was revoked or the key rotated, so the next call mints again.
    drop() { cached = undefined; },
  };
}

// Logs `${prefix}: ${error.name}: ${error.message}`, each distinct message at most once per LOG_EVERY_MS; returns error.
export function throttledWarn(prefix: string, now: () => number) {
  const logged = new Map<string, number>();
  return <E extends Error>(error: E): E => {
    const last = logged.get(error.message);
    if (last === undefined || now() - last >= LOG_EVERY_MS) {
      logged.set(error.message, now());
      console.warn(`[grayboard] ${prefix}: ${error.name}: ${error.message}`);
    }
    return error;
  };
}

// p, given up on (with the signal's reason) when the signal aborts first; p itself runs on.
export function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    p.then(v => { signal.removeEventListener("abort", stop); resolve(v); }, e => { signal.removeEventListener("abort", stop); reject(e); });
  });
}
