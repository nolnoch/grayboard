// stop() waits out a request already in flight before it closes the store (#218): an /api route paused between two
// reads (testPause "http:team-members:between") resumes on an open store and answers, rather than throwing "Database
// has closed" into the error handler. A request that never settles is bounded by the drain deadline, whose error
// names it.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestServer } from "../support/server.ts";
import { until } from "../support/until.ts";

const A = "alice@example.com";
const POINT = "http:team-members:between";

let dir: string;
let release: string;
let logs: string[];
let log: ReturnType<typeof spyOn>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gb-stop-quiesce-"));
  release = join(dir, "release");
  logs = [];
  log = spyOn(console, "error").mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")); });
});
afterEach(() => {
  writeFileSync(release, "release");
  delete process.env.BUS_TEST_PAUSE; delete process.env.BUS_TEST_PAUSE_FILE;
  log.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

// Opens a server with a team, then starts a roster read held at POINT. Returns the server, the read, and a flag that
// turns true once the store's close is called.
async function heldRead(opts: { stopDrainMs?: number } = {}) {
  const srv = await TestServer.open({}, opts);
  const token = await srv.login(A);
  expect((await srv.api(token, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
  const closed = { at: 0 };
  const close = srv.app.repo.close.bind(srv.app.repo);
  spyOn(srv.app.repo, "close").mockImplementation(() => { closed.at ||= performance.now(); return close(); });
  process.env.BUS_TEST_PAUSE = POINT; process.env.BUS_TEST_PAUSE_FILE = release;
  const read = srv.api(token, "GET", "/api/teams/eng/members").then(res => ({ res, at: performance.now() }), (error: unknown) => ({ error, at: performance.now() }));
  await until(() => logs.includes(`[grayboard] test pause hit: ${POINT}`), 5000, "the roster read reached its pause");
  return { srv, read, closed };
}

test("stop() waits for a request in flight before it closes the store", async () => {
  const { srv, read, closed } = await heldRead();
  let stoppedAt = 0;
  const stopping = srv.app.stop().then(() => { stoppedAt = performance.now(); });
  void stopping.catch(() => {});
  // Either stop says it waits for the request, or (without the drain) it has gone on to close the store.
  await until(() => closed.at || logs.some(l => l.startsWith("[grayboard] stopping: waiting for 1 request")), 5000, "stop waits or closes the store");
  expect(closed.at).toBe(0);
  expect(logs.find(l => l.startsWith("[grayboard] stopping: waiting for 1 request"))).toContain("GET /api/teams/eng/members");
  writeFileSync(release, "release");
  await stopping;
  // The connection was closed under it, so the client may see no answer; the server must not have failed it.
  await read;
  expect(closed.at).toBeGreaterThan(0);
  expect(closed.at).toBeLessThanOrEqual(stoppedAt);
  expect(logs.filter(l => l.includes("request failed") || /closed/i.test(l) && !l.includes("stopping"))).toEqual([]);
  await srv.stop();
});

test("stop()'s drain deadline names the request that never finished, and the store still closes", async () => {
  const { srv, closed } = await heldRead({ stopDrainMs: 50 });
  await expect(srv.app.stop()).rejects.toThrow(/stop: 1 request never finished within 50 ms: GET \/api\/teams\/eng\/members/);
  // main.ts redacts a failed stop's error, so the drain says what it waited for on its own.
  expect(logs).toContain("[grayboard] stop: 1 request never finished within 50 ms: GET /api/teams/eng/members");
  expect(closed.at).toBeGreaterThan(0);
  writeFileSync(release, "release");
  await srv.stop().catch(() => {});
});
