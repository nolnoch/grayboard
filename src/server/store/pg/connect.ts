// Waiting for the database at startup (#1418). A managed Postgres can be briefly unreachable when the server starts:
// a paused serverless cluster takes ~15 s to resume, a failover drops connections, a fresh cluster is still booting.
// The server waits for one successful round trip, up to a deadline, before it migrates. Only a failure that a wait can
// cure is retried; a wrong password or a missing database fails the start at once.
import { SQL } from "bun";
import { openPg } from "./sql.ts";

export const DEFAULT_CONNECT_SECONDS = 60;
// The first retry's wait, doubling to the cap.
const FIRST_DELAY_MS = 500;
const MAX_DELAY_MS = 5_000;
// One probe's connection timeout, so a black-holed address can't spend the whole deadline on one attempt.
const PROBE_TIMEOUT_SECONDS = 10;

// Bun's connection-level codes (refused, which includes a name that doesn't resolve; timed out; closed), and the
// SQLSTATEs of a server not taking connections yet: 57P03 cannot_connect_now (starting up, resuming), 53300
// too_many_connections, class 08 connection exceptions.
export function transientConnectFailure(e: unknown): boolean {
  if (!(e instanceof SQL.PostgresError)) return false;
  if (e.code.startsWith("ERR_POSTGRES_CONNECTION_")) return true;
  const state = e.errno ?? "";
  return state === "57P03" || state === "53300" || state.startsWith("08");
}

export type ConnectWait = {
  // How long to keep retrying; 0 tries once.
  seconds: number;
  log?: (line: string) => void;
  // For tests: the clock, the wait, and the round trip.
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  probe?: (timeoutSeconds: number) => Promise<void>;
};

const describeFailure = (e: unknown) =>
  e instanceof SQL.PostgresError ? `${e.code}${e.errno ? ` ${e.errno}` : ""}: ${e.message}` : String(e);

// Resolves once a connection answers `select 1`. Throws the failure itself when it isn't transient, or an error naming
// the deadline (the last failure as its cause) when the deadline passes.
export async function waitForPg(url: string, opts: ConnectWait): Promise<void> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const log = opts.log ?? ((line: string) => console.error(line));
  const probe = opts.probe ?? (async (timeoutSeconds: number) => {
    const sql = openPg(url, { max: 1, connectionTimeout: timeoutSeconds, applicationName: "grayboard-connect" });
    try { await sql`select 1`; } finally { await sql.close().catch(() => {}); }
  });
  const deadline = now() + opts.seconds * 1000;
  let delay = FIRST_DELAY_MS;
  for (;;) {
    const left = Math.ceil((deadline - now()) / 1000);
    try {
      await probe(Math.max(1, Math.min(PROBE_TIMEOUT_SECONDS, left)));
      return;
    } catch (e) {
      if (!transientConnectFailure(e)) throw e;
      const remaining = deadline - now();
      if (remaining <= 0) {
        throw new Error(`the database did not answer within ${opts.seconds} s (GRAYBOARD_DATABASE_CONNECT_SECONDS): ${describeFailure(e)}`, { cause: e });
      }
      log(`grayboard server: database not reachable (${describeFailure(e)}); retrying for ${Math.ceil(remaining / 1000)} s more`);
      await sleep(Math.min(delay, remaining));
      delay = Math.min(delay * 2, MAX_DELAY_MS);
    }
  }
}
