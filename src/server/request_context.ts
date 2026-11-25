import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The HTTP request a piece of work runs for (security audit F-19): the client
 * address (trusted-proxy resolved, `client_addr.ts`), user agent and, once a
 * hosted MCP request's token resolves, its OAuth client (#847) that every
 * audit row written while handling it carries. It follows the request through
 * awaits and the timers it schedules; a timer that outlives the request and
 * does other callers' work is armed through `detached` instead. Work with no
 * request (boot, retention, the timer-driven hosted sweeps, the Slack bridge's relay) writes null.
 */
export type RequestOrigin = { ip: string | null; ua: string | null; client_id?: string | null };

const origin = new AsyncLocalStorage<RequestOrigin>();

/** Runs `fn` as work for the request `o` describes. */
export function inRequest<T>(o: RequestOrigin, fn: () => T): T {
  return origin.run(o, fn);
}

/** The request the current work runs for, if any. */
export function requestOrigin(): RequestOrigin | undefined {
  return origin.getStore();
}

/** Names the OAuth client the current request authenticated as, for the rows written from here on in it. */
export function setRequestClient(clientId: string): void {
  const o = origin.getStore();
  if (o) o.client_id = clientId;
}

/** Runs `fn` outside any request: for arming a timer whose firing serves every caller. */
export function detached<T>(fn: () => T): T {
  return origin.exit(fn);
}
