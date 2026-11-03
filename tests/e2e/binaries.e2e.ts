// A release's compiled binaries, before they're published: release.yml runs
// this per target against the build job's artifacts. GRAYBOARD_E2E_BIN_DIR
// holds grayboard-<target> and grayboard-server-<target> for this machine;
// GRAYBOARD_E2E_TAG is the tag being released. Not part of `bun test`'s
// default run (the .e2e.ts suffix); run it with
//   bun test ./tests/e2e/binaries.e2e.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/server/db.ts";
import { direct } from "../support/events.ts";
import { HOSTED_CLIENT, HOSTED_SCOPES, HostedSession } from "../support/hosted_session.ts";
import { closeSessions } from "../support/mcp.ts";
import { issueOAuth } from "../helpers/oauth.ts";
import { piScenario } from "../support/pi.ts";
import { keep } from "../support/run_dir.ts";
import { ServerProcess } from "../support/server.ts";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required (see the header of ${import.meta.file})`);
  return v;
}

const BIN_DIR = required("GRAYBOARD_E2E_BIN_DIR");
const TAG = required("GRAYBOARD_E2E_TAG");
const TARGET = `${process.platform}-${process.arch}`;
const CLI = join(BIN_DIR, `grayboard-${TARGET}`);
const SERVER = join(BIN_DIR, `grayboard-server-${TARGET}`);

let dir: string;
let label: string;
let server: ServerProcess | undefined;
let hosted: HostedSession[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grayboard-binaries-"));
});

// Under scripts/e2e.sh each test keeps its temp dir (sessions' HOMEs, the
// server's env file and database) and the server's log.
afterEach(async () => {
  try {
    await closeSessions();
    await Promise.all(hosted.splice(0).map((h) => h.close()));
  } finally {
    const s = server;
    server = undefined;
    if (s) {
      await s.stop();
      writeFileSync(join(dir, "server.log"), s.log());
    }
    keep(label, dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

// KEY=VALUE lines, as systemd's EnvironmentFile reads /etc/grayboard/env.
function readEnvFile(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) env[m[1]!] = m[2]!;
  }
  return env;
}

test("both binaries report the tag", () => {
  label = "version";
  for (const bin of [CLI, SERVER]) {
    const r = Bun.spawnSync([bin, "--version"], { timeout: 10_000, killSignal: "SIGKILL" });
    expect(r.exitedDueToTimeout ?? false, `${bin} --version: no answer in 10 s`).toBe(false);
    expect(r.exitCode, `${bin}: ${r.stderr}`).toBe(0);
    expect(r.stdout.toString().trim()).toBe(TAG.replace(/^v/, ""));
  }
});

test("pi: the compiled CLI and the adapter it carries wake a pi session", () => {
  label = "pi";
  return piScenario(dir, CLI);
}, 90_000);

// The compiled server as install.sh sets it up: /etc/grayboard/env's shape,
// with dev auth in place of the Google client secret, read as systemd's
// EnvironmentFile reads it. Its public URL is http://localhost, so its
// OAuth resource is http://localhost/mcp.
async function serverFromEnvFile(): Promise<{ server: ServerProcess; dbPath: string }> {
  const envFile = join(dir, "env");
  writeFileSync(envFile, [
    "# grayboard server",
    `GRAYBOARD_DB_PATH=${join(dir, "grayboard.db")}`,
    "GRAYBOARD_PUBLIC_URL=http://localhost",
    "GRAYBOARD_ORG_DOMAIN=example.com",
    "GOOGLE_OAUTH_CLIENT_ID=e2e",
    "GRAYBOARD_DEV_AUTH=1",
    "GRAYBOARD_HTTP_PORT=0",
    // Inbox polling spends hosted requests.
    "GRAYBOARD_HOSTED_REQUEST_BURST=10000",
    "GRAYBOARD_HOSTED_REQUEST_PER_SEC=10000",
    "",
  ].join("\n"));
  const { GRAYBOARD_DB_PATH: dbPath, ...env } = readEnvFile(envFile);
  return { server: await ServerProcess.start(SERVER, dbPath!, env), dbPath: dbPath! };
}

test("server: the compiled server, started from an env file, relays a DM and its reply between hosted MCP sessions", async () => {
  label = "server-hosted";
  const started = await serverFromEnvFile();
  server = started.server;
  // A grant the server issued, as a finished hosted login leaves one: written
  // through the server's own database beside the running process (WAL), since
  // the compiled server's upstream Google sign-in can't be stubbed.
  const store = openDatabase(started.dbPath, { blobDir: join(dir, "blobs") });
  const token = (email: string) => issueOAuth(store.repo, "http://localhost/mcp", email, HOSTED_SCOPES, Date.now(), HOSTED_CLIENT).token;
  const session = async (email: string, identity: string) => {
    const h = new HostedSession(`${server!.base}/mcp`, token(email), identity);
    hosted.push(h);
    await h.connect();
    return h;
  };
  let be: HostedSession, fe: HostedSession;
  try {
    be = await session("alice@example.com", "be");
    fe = await session("bob@example.com", "fe");
  } finally {
    store.db.close();
  }

  const q = await fe.call<{ message_id: number; delivered_now: boolean }>("dm_send", { to: "alice@example.com/be", body: "ping" });
  expect(q.delivered_now).toBe(true);
  const got = (await be.next(direct((m) => m.body === "ping"), 10_000)).event.message;
  expect(got.sender).toBe("bob@example.com/fe");
  await be.call("dm_send", { to: "bob@example.com/fe", body: "pong", parent_id: got.id });
  const reply = (await fe.next(direct((m) => m.body === "pong"), 10_000)).event.message;
  expect(reply.parent_id).toBe(q.message_id);
}, 60_000);
