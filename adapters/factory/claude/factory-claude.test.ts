// The Claude translator through the module entry, over a real local bus
// (#264): a delegation addressed to a launcher running FACTORY_HARNESS=claude
// gets a spawn directive when the persona is in the fixture roster, a decline
// when it isn't — and the skeleton receipt when no harness is configured.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestServer } from "../../../tests/support/server.ts";
import { call, closeSessions } from "../../../tests/support/mcp.ts";
import { until } from "../../../tests/support/until.ts";

let dir: string;
let agentsDir: string;
let srv: TestServer;
let token: string;

const AGENT_MD = "---\nname: researcher\ndescription: does research\n---\n\nbody.\n";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grayboard-factory-claude-"));
  agentsDir = join(dir, "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, "researcher.md"), AGENT_MD);
  srv = new TestServer();
});

afterEach(async () => {
  await closeSessions();
  await srv.stop();
  rmSync(dir, { recursive: true, force: true });
});

// The module entry as its own process, translator configured: the same shape
// the enable path runs.
function factoryProc(): Bun.Subprocess {
  return Bun.spawn([process.execPath, join("adapters", "factory", "main.ts")], {
    env: {
      ...process.env,
      GRAYBOARD_SERVER: srv.base,
      GRAYBOARD_TOKEN: token,
      BUS_IDENTITY: "factory",
      GRAYBOARD_CREDENTIALS: "",
      FACTORY_HARNESS: "claude",
      FACTORY_AGENTS_DIR: agentsDir,
    },
    cwd: join(import.meta.dir, "..", "..", ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function waitOnline(sim: { c: Parameters<typeof call>[0] }): Promise<void> {
  await until(async () => {
    const peers = (await call(sim.c, "peer_list")) as { peers: { handle: string; online?: boolean; launcher?: true }[] };
    const f = peers.peers.find((p) => p.handle === "you@example.com/factory");
    return f?.online === true && f.launcher === true;
  }, 10_000, "the factory launcher to appear online");
}

describe("the claude translator through the module entry", () => {
  test("a delegation for a roster persona is answered with the Agent-tool directive", async () => {
    token = await srv.login("you@example.com");
    const sim = await srv.session(token, "sim");
    const proc = factoryProc();
    try {
      await waitOnline(sim);
      const r = (await call(sim.c, "delegate", { persona: "a researcher", task: "survey the repos", to: "factory" })) as {
        message_id: number;
        to: string;
      };
      expect(r.to).toBe("you@example.com/factory");
      await until(async () => {
        const thread = (await call(sim.c, "dm_thread", { thread: r.message_id })) as { body: string }[];
        return thread.some((m) => m.body.includes("spawn directive"));
      }, 10_000, "the spawn directive to arrive in-thread");
      const thread = (await call(sim.c, "dm_thread", { thread: r.message_id })) as { body: string }[];
      const reply = thread.find((m) => m.body.includes("spawn directive"))!.body;
      expect(reply).toContain('"subagent_type": "researcher"');
      expect(reply).toContain("researcher.md");
      // The brief rides as JSON data inside the fence, not as prose.
      expect(reply).toContain('"survey the repos"');
    } finally {
      proc.kill();
      await proc.exited;
    }
  });

  test("a persona outside the roster gets the decline, so the requester can branch", async () => {
    token = await srv.login("you@example.com");
    const sim = await srv.session(token, "sim");
    const proc = factoryProc();
    try {
      await waitOnline(sim);
      const r = (await call(sim.c, "delegate", { persona: "astronaut", task: "orbit", to: "factory" })) as {
        message_id: number;
      };
      await until(async () => {
        const thread = (await call(sim.c, "dm_thread", { thread: r.message_id })) as { body: string }[];
        return thread.some((m) => m.body.startsWith("[factory] decline"));
      }, 10_000, "the decline to arrive in-thread");
      const thread = (await call(sim.c, "dm_thread", { thread: r.message_id })) as { body: string }[];
      expect(thread.some((m) => m.body.includes("spawn directive"))).toBe(false);
    } finally {
      proc.kill();
      await proc.exited;
    }
  });

  test("no FACTORY_HARNESS keeps the skeleton receipt (no regression)", async () => {
    token = await srv.login("you@example.com");
    const sim = await srv.session(token, "sim");
    const proc = Bun.spawn([process.execPath, join("adapters", "factory", "main.ts")], {
      env: {
        ...process.env,
        GRAYBOARD_SERVER: srv.base,
        GRAYBOARD_TOKEN: token,
        BUS_IDENTITY: "factory",
        GRAYBOARD_CREDENTIALS: "",
        FACTORY_HARNESS: "",
        FACTORY_AGENTS_DIR: agentsDir,
      },
      cwd: join(import.meta.dir, "..", "..", ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      await waitOnline(sim);
      const r = (await call(sim.c, "delegate", { persona: "a researcher", task: "x", to: "factory" })) as {
        message_id: number;
      };
      await until(async () => {
        const thread = (await call(sim.c, "dm_thread", { thread: r.message_id })) as { body: string }[];
        return thread.some((m) => m.body.startsWith("[factory] received"));
      }, 10_000, "the skeleton receipt to arrive in-thread");
    } finally {
      proc.kill();
      await proc.exited;
    }
  });
});
