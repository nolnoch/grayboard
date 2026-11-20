// #1418: the startup wait for a Postgres store retries only what a wait can cure, and stops at its deadline.
import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { transientConnectFailure, waitForPg } from "./connect.ts";
import { describePg, PG_URL, pgUrl } from "../../../../tests/support/pg.ts";

const pgError = (code: string, errno?: string) => new SQL.PostgresError("x", { code, ...(errno ? { errno } : {}) } as never);

// The rejection a wait ends in; resolving is a test failure.
const failure = <E = Error>(p: Promise<void>) => p.then(() => { throw new Error("the wait resolved"); }, e => e as E);

// A fake clock the sleeps advance, and a probe that answers from a script.
function rig(script: (Error | undefined)[]) {
  let t = 0;
  const calls: number[] = [], sleeps: number[] = [], logs: string[] = [];
  return {
    calls, sleeps, logs,
    opts: (seconds: number) => ({
      seconds,
      now: () => t,
      sleep: async (ms: number) => { sleeps.push(ms); t += ms; },
      log: (line: string) => logs.push(line),
      probe: async (timeout: number) => {
        calls.push(timeout);
        const next = script.shift();
        if (next) throw next;
      },
    }),
  };
}

describe("waitForPg", () => {
  test("classifies a failure a wait can cure", () => {
    expect(transientConnectFailure(pgError("ERR_POSTGRES_CONNECTION_REFUSED"))).toBe(true);
    expect(transientConnectFailure(pgError("ERR_POSTGRES_CONNECTION_TIMEOUT"))).toBe(true);
    expect(transientConnectFailure(pgError("ERR_POSTGRES_CONNECTION_CLOSED"))).toBe(true);
    expect(transientConnectFailure(pgError("ERR_POSTGRES_SERVER_ERROR", "57P03"))).toBe(true);
    expect(transientConnectFailure(pgError("ERR_POSTGRES_SERVER_ERROR", "53300"))).toBe(true);
    expect(transientConnectFailure(pgError("ERR_POSTGRES_SERVER_ERROR", "08006"))).toBe(true);
    // A wrong password, a missing database and anything not from the driver fail the start at once.
    expect(transientConnectFailure(pgError("ERR_POSTGRES_SERVER_ERROR", "28P01"))).toBe(false);
    expect(transientConnectFailure(pgError("ERR_POSTGRES_SERVER_ERROR", "3D000"))).toBe(false);
    expect(transientConnectFailure(new Error("ECONNREFUSED"))).toBe(false);
  });

  test("retries transient failures with a doubling, capped wait", async () => {
    const refused = pgError("ERR_POSTGRES_CONNECTION_REFUSED");
    const r = rig([refused, pgError("ERR_POSTGRES_SERVER_ERROR", "57P03"), refused, refused, refused, undefined]);
    await waitForPg("unused", r.opts(60));
    expect(r.calls.length).toBe(6);
    expect(r.sleeps).toEqual([500, 1000, 2000, 4000, 5000]);
    expect(r.logs.length).toBe(5);
    expect(r.logs[1]).toContain("database not reachable (ERR_POSTGRES_SERVER_ERROR 57P03: x); retrying for 60 s more");
  });

  test("a permanent failure throws at once, itself", async () => {
    const auth = pgError("ERR_POSTGRES_SERVER_ERROR", "28P01");
    const r = rig([auth]);
    await expect(waitForPg("unused", r.opts(60))).rejects.toBe(auth);
    expect(r.calls.length).toBe(1);
    expect(r.sleeps).toEqual([]);
  });

  test("gives up at the deadline, naming it, with the last failure as the cause", async () => {
    const refused = pgError("ERR_POSTGRES_CONNECTION_REFUSED");
    const r = rig(Array(100).fill(refused));
    const err = await failure(waitForPg("unused", r.opts(3)));
    expect(err.message).toBe("the database did not answer within 3 s (GRAYBOARD_DATABASE_CONNECT_SECONDS): ERR_POSTGRES_CONNECTION_REFUSED: x");
    expect(err.cause).toBe(refused);
    // 500 + 1000 + 1500 (the last sleep clipped to the deadline) = 3000.
    expect(r.sleeps).toEqual([500, 1000, 1500]);
    // A probe never waits past the deadline either: 3 s left, then 3, 2, 1 (rounded up, at least 1).
    expect(r.calls).toEqual([3, 3, 2, 1]);
  });

  test("0 seconds tries once", async () => {
    const r = rig([pgError("ERR_POSTGRES_CONNECTION_REFUSED")]);
    await expect(waitForPg("unused", r.opts(0))).rejects.toThrow("did not answer within 0 s");
    expect(r.calls.length).toBe(1);
  });

  // The driver's real code for a closed port, so the classifier matches what Bun throws.
  test("a refused connection is transient against the real driver", async () => {
    const err = await failure(waitForPg("postgres://u:p@127.0.0.1:1/db", { seconds: 0, log: () => {} }));
    expect(err.message).toContain("did not answer within 0 s (GRAYBOARD_DATABASE_CONNECT_SECONDS): ERR_POSTGRES_CONNECTION_REFUSED");
  });
});

describePg("waitForPg against Postgres", () => {
  test("a reachable database answers; a missing one fails at once", async () => {
    await waitForPg(PG_URL!, { seconds: 5 });
    const logs: string[] = [];
    const t = Date.now();
    const err = await failure<SQL.PostgresError>(waitForPg(pgUrl("gb_no_such_database"), { seconds: 30, log: line => logs.push(line) }));
    expect(err.errno).toBe("3D000");
    expect(logs).toEqual([]);
    expect(Date.now() - t).toBeLessThan(5_000);
  });
});
