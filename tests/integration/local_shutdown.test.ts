// A local session's refusals while it shuts down (#966): a call that arrives
// once shutdown has begun is refused `id_ended`, and one already waiting at
// the bind gate when shutdown begins is refused `superseded` when it gets its
// turn, never run. Forced with a testPause in the gate, so no sleep decides it.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeSessions, localSession, refusalCoded } from "../support/mcp.ts";
import { pauseEnv, releasePause } from "../support/local_bus.ts";
import { processDescendants } from "../support/procs.ts";
import { until } from "../support/until.ts";

const POINT = "local:tool:in-gate";
let dir: string;

beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "gb-shutdown-"))); });
afterEach(async () => {
  releasePause(dir, POINT);
  await closeSessions();
  rmSync(dir, { recursive: true, force: true });
});

test("shutdown refuses a new call id_ended and a gate-queued call superseded", async () => {
  const s = await localSession(dir, "alpha", { extra: pauseEnv(dir, POINT) });
  // A bind holds the gate alone, paused inside it.
  const bind = s.c.callTool({ name: "bind", arguments: { name: "beta", create: true } });
  await until(() => s.stderr().includes(`test pause hit: ${POINT}`));
  // A call queued behind it. Requests are dispatched in order, and a call
  // reaches the gate without yielding, so the ping's answer says it waits there.
  const queued = refusalCoded(s, "whoami");
  await s.c.ping();
  // The socket whose removal below marks shutdown's start.
  expect(existsSync(join(dir, "sock.alpha"))).toBe(true);
  const [child] = processDescendants(s.harnessPid);
  process.kill(child!.pid, "SIGTERM");
  // Shutdown removes the name sockets right after it marks the session ending.
  await until(() => !existsSync(join(dir, "sock.alpha")));
  expect(await refusalCoded(s, "whoami")).toEqual({ text: "error: this session is ending", code: "id_ended" });
  // Shutdown waits for the calls in flight; the bind finishes, then the queued call gets its turn.
  releasePause(dir, POINT);
  expect((await bind).isError).toBeFalsy();
  expect(await queued).toEqual({ text: "error: conversation changed before this call ran", code: "superseded" });
}, 30_000);
