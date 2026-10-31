// The omp scenarios (#280): the real omp coding agent (the pinned
// devDependency, a Bun program) in RPC mode against a scripted fake model,
// with the hosted extension exactly as the binary embeds it
// (adapterBundle("omp")), set up as `grayboard setup --server` leaves it:
// <agentDir>/extensions/grayboard.js, <agentDir>/grayboard/config.json {url}
// and no grayboard MCP entry. omp speaks pi's RPC protocol, so the Pi class
// and the hosted helpers come from tests/support/pi.ts.
import { expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { deliveryPath } from "../../adapters/hosted-core/src/storage.ts";
import { adapterBundle } from "../../src/cli/adapters.ts" with { type: "macro" };
import { cleanEnv } from "./env.ts";
import { startFakeModel, type FakeModel, type Rule } from "./fake_model.ts";
import { hostedServer, seedGrant, type HostedServer } from "./hosted_oauth.ts";
import { answerPeer, hostedPeer, Pi, statusOf, stopAll, type Peer } from "./pi.ts";
import { grayboardDescendants } from "./procs.ts";
import { ROOT } from "./paths.ts";
import { until } from "./until.ts";

type OmpPackage = { version: string; bin: { omp: string } };
const OMP_PKG = join(ROOT, "node_modules/@oh-my-pi/pi-coding-agent/package.json");
const OMP: OmpPackage = JSON.parse(readFileSync(OMP_PKG, "utf8"));
const OMP_CLI = join(dirname(OMP_PKG), OMP.bin.omp);
const OMP_ARGS = ["--mode", "rpc", "--provider", "fake", "--model", "fake-1", "--no-lsp", "--no-skills", "--no-rules", "--no-context-files", "--no-title"];

const BUNDLE = adapterBundle("omp");
const OMP_CLIENT = "grayboard-omp";
export const PREFIX = "mcp__grayboard_";
const LOGIN_NOTICE = "grayboard: Signed out of grayboard in omp; run /grayboard login";

const agentDirOf = (dir: string) => join(dir, "omp-agent");
const stateDirOf = (dir: string) => join(agentDirOf(dir), "grayboard");

// Written once per scenario, before any omp starts. models.yml takes JSON (YAML's superset).
function installHosted(dir: string, srv: HostedServer, modelPort: number): void {
  const agentDir = agentDirOf(dir), bin = join(dir, "bin");
  for (const d of [join(agentDir, "extensions"), stateDirOf(dir), bin, join(dir, "home")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(agentDir, "extensions", "grayboard.js"), BUNDLE);
  writeFileSync(join(stateDirOf(dir), "config.json"), JSON.stringify({ url: srv.resource }));
  writeFileSync(join(agentDir, "models.yml"), JSON.stringify({
    providers: { fake: { baseUrl: `http://localhost:${modelPort}/v1`, api: "openai-completions", apiKey: "x", models: [{ id: "fake-1" }] } },
  }));
  for (const opener of ["open", "xdg-open"]) writeFileSync(join(bin, opener), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}

function startHostedOmp(dir: string, procs: ChildProcess[], { persist = false, session }: { persist?: boolean; session?: string } = {}): Pi {
  const proc = spawn(process.execPath, [OMP_CLI, ...OMP_ARGS, ...(persist ? [] : ["--no-session"]), ...(session ? ["--resume", session] : [])], {
    cwd: dir,
    env: cleanEnv({
      HOME: join(dir, "home"), GRAYBOARD_ATTACHMENTS_DIR: join(dir, "saved"), PATH: `${join(dir, "bin")}${delimiter}${process.env.PATH}`,
      PI_CODING_AGENT_DIR: agentDirOf(dir),
    }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  procs.push(proc);
  return new Pi(proc);
}

type HostedRow = { name: string | null; lease_deadline: number | null; ownership_id: number };
const ompRow = (srv: HostedServer, raw: string): HostedRow | undefined => srv.app.db.query<HostedRow, [string, string]>(
  "SELECT name, lease_deadline, ownership_id FROM hosted_sessions WHERE client_id = ? AND source_session_id = ?").get(OMP_CLIENT, raw) ?? undefined;

type Hosted = { srv: HostedServer; model: FakeModel; peer: Peer; start(o?: { persist?: boolean; session?: string }): Pi };

// A failure names omp's version.
async function named(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (e) {
    if (e instanceof Error) e.message = `omp ${OMP.version}: ${e.message}`;
    throw e;
  }
}

function withHosted(dir: string, rules: Rule[], run: (h: Hosted) => Promise<void>): Promise<void> {
  return named(async () => {
    const procs: ChildProcess[] = [];
    const srv = hostedServer();
    const model = startFakeModel([answerPeer(PREFIX), ...rules]);
    let peer: Peer | undefined;
    try {
      peer = await hostedPeer(srv, dir);
      installHosted(dir, srv, model.port);
      await run({ srv, model, peer, start: (o) => startHostedOmp(dir, procs, o) });
      expect(model.unhandled).toEqual([]);
      expect(peer.reports).toEqual([]);
    } finally {
      await stopAll(procs);
      await peer?.close();
      model.stop();
      await srv.stop();
    }
  });
}

// The spec's load smoke for omp: the bundle the CLI's macro emits, loaded by
// the pinned omp under Bun with an isolated HOME and a seeded grant. Its
// value import of @oh-my-pi/pi-coding-agent resolved to the host (getAgentDir
// named the isolated agentDir: the grant was read there, no login notice).
// The status's session line carries omp's own id (session_start ran); the
// root's unbound Controller line needs the MCP client's whoami round trip;
// the delivery lock file exists (node:sqlite under Bun took it). No grayboard
// process runs, and quitting leaves nothing leased.
export function ompHostedLoadSmoke(dir: string): Promise<void> {
  return withHosted(dir, [], async ({ srv, start }) => {
    await seedGrant(srv, stateDirOf(dir), OMP_CLIENT);
    const omp = start();
    const { sessionId } = await omp.command({ type: "get_state" }, 30_000);
    const controller = `\n  ${sessionId}: unbound, Root approved, unbound; bind(name) to take one`;
    const status = await until(async () => {
      const s = await statusOf(omp);
      return s.includes(controller) ? s : undefined;
    }, 20_000, "the root's Controller line");
    expect(status).toContain(`\nsign-in: signed in\nsession: ${sessionId} (root)\n`);
    expect(status).not.toContain("\ndelivery: ");
    expect(omp.stderr).not.toContain("Failed to load extension");
    expect(omp.events.filter((e) => e.type === "extension_error")).toEqual([]);
    expect(omp.notices()).not.toContain(LOGIN_NOTICE);
    expect(existsSync(deliveryPath(stateDirOf(dir), srv.resource, OMP_CLIENT, sessionId))).toBe(true);
    expect(ompRow(srv, sessionId)?.name).toBeNull();
    expect(grayboardDescendants(omp.pid)).toEqual([]);
    await omp.quit();
    await until(() => srv.app.mcp.activeLeases === 0, 10_000, "nothing leased after quit");
  });
}
