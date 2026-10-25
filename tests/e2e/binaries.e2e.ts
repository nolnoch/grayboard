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
import { serverEnv } from "../support/env.ts";
import { closeSessions, mcpSession } from "../support/mcp.ts";
import { piScenario } from "../support/pi.ts";
import { keep } from "../support/run_dir.ts";
import { ServerProcess } from "../support/server.ts";
import { until } from "../support/until.ts";

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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grayboard-binaries-"));
});

// Under scripts/e2e.sh each test keeps its temp dir (sessions' HOMEs, the
// server's env file and database) and the server's log.
afterEach(async () => {
  try {
    await closeSessions();
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

test("server: the compiled server, started from an env file, relays a DM and its reply between compiled CLIs", async () => {
  label = "server";
  const envFile = join(dir, "env");
  // The shape of /etc/grayboard/env (install.sh's new-server steps), with dev
  // auth in place of the Google client secret.
  writeFileSync(envFile, [
    "# grayboard server",
    `GRAYBOARD_DB_PATH=${join(dir, "grayboard.db")}`,
    "GRAYBOARD_PUBLIC_URL=http://localhost",
    "GRAYBOARD_ORG_DOMAIN=example.com",
    "GOOGLE_OAUTH_CLIENT_ID=e2e",
    "GRAYBOARD_DEV_AUTH=1",
    "GRAYBOARD_HTTP_PORT=0",
    "",
  ].join("\n"));
  const { GRAYBOARD_DB_PATH: dbPath, ...env } = readEnvFile(envFile);
  server = await ServerProcess.start(SERVER, dbPath!, env);
  const session = async (email: string, identity: string) =>
    mcpSession({ bin: CLI, env: serverEnv(dir, server!.base, await server!.login(email), identity), cwd: dir, args: ["mcp", "--mode", "server"] });
  const be = await session("alice@example.com", "be");
  const fe = await session("bob@example.com", "fe");

  const q = await fe.call("dm_send", { to: "alice@example.com/be", body: "ping" });
  expect(q.delivered_now).toBe(true);
  const got = await until(() => be.pushes.find((p) => p.content === "ping"));
  expect(got.meta.from).toBe("bob@example.com/fe");
  await be.call("dm_send", { to: "bob@example.com/fe", body: "pong", parent_id: Number(got.meta.message_id) });
  const reply = await until(() => fe.pushes.find((p) => p.content === "pong"));
  expect(reply.meta.parent_id).toBe(String(q.message_id));
}, 60_000);
