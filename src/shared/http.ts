// Deadlines for outbound HTTP (the grayboard server's API, Slack's), so a
// stalled peer fails a call instead of hanging it, and what waits behind it.

// An API call: a small request and answer.
export const HTTP_TIMEOUT_MS = 30_000;

// Moving `bytes` of a file: the call's allowance plus the time at 128 KB/s, a
// slow link's floor. 25 MB gets about four minutes.
export function transferTimeoutMs(bytes: number): number {
  return HTTP_TIMEOUT_MS + Math.ceil(bytes / 128);
}

// Why a fetch or the read of its body failed. AbortSignal.timeout's rejection
// becomes the deadline it missed; anything else passes through.
export function describeFetchError(e: unknown, ms: number): string {
  return e instanceof Error && e.name === "TimeoutError" ? `no answer within ${Math.round(ms / 1000)}s` : (e as Error).message;
}
