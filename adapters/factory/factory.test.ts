// The FactoryBus skeleton against a real server (#293): the module-run
// launcher receives a delegation request and answers it in-thread; the bus
// ops round-trip; the idempotency keys hold. A behavior that fails when its
// implementation is removed is the pin; the reviewer reverts and reruns.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientBus } from "./bus.ts";
import { TestServer } from "../../tests/support/server.ts";
import { call, closeSessions } from "../../tests/support/mcp.ts";
import { until } from "../../tests/support/until.ts";

// The isolation allowlist stops at src/plugin/client.ts and
// src/shared/protocol.ts; tests may use tests/support (the check script's
// documented exception), which is how these reach a real server.
let dir: string;
let srv: TestServer;
let token: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grayboard-factory-"));
  srv = new TestServer();
});

afterEach(async () => {
  await closeSessions();
  await srv.stop();
  rmSync(dir, { recursive: true, force: true });
});

// A bus connected in-process, as the module's run loop holds one.
const bus = (identity: string): ClientBus =>
  new ClientBus(srv.base, () => token, identity, { capabilities: { dimension: "test" } });

const factoryEnv = (): Record<string, string> => ({
  GRAYBOARD_SERVER: srv.base,
  GRAYBOARD_TOKEN: token,
  BUS_IDENTITY: "factory",
});

describe("factory bus", () => {
  test("a module-run launcher joins the bus: online, launcher-flagged, identity reported", async () => {
    token = await srv.login("you@example.com");
    const mod = await import("./main.ts");
    const b = await mod.run({ serverUrl: srv.base, token, identity: "factory", capabilities: { dimension: "test" } });
    try {
      const sim = await srv.session(token, "sim");
      const peers = (await until(() =>
        (call(sim.c, "peer_list") as Promise<{ peers: { handle: string; launcher?: true }[] }>).then(
          (r) => r.peers.find((p) => p.handle === "you@example.com/factory"),
        ),
      )).launcher;
      expect(peers).toBe(true);
      const id = await b.identity();
      expect(id.handle).toBe("factory");
      expect(id.capabilities.launcher).toBe(true);
      expect(id.capabilities.dimension).toBe("test");
    } finally {
      await b.close();
    }
  });

  test("the bus ops round-trip: DM, thread, settle, board, claim, idempotency", async () => {
    token = await srv.login("you@example.com");
    const sim = await srv.session(token, "sim");
    const b = bus("factory");
    try {
      // DM out, seen by the peer, thread readable, settled.
      const sent = await b.send({ to: "sim", body: "factory ping", idempotencyKey: "dm-1" });
      expect(sent.delivered).toBe(true);
      await until(async () => {
        const msgs = await b.thread(sent.messageId);
        return msgs.some((m) => m.body === "factory ping");
      }, 10_000, "the DM to appear in the thread");
      const again = await b.send({ to: "sim", body: "factory ping", idempotencyKey: "dm-1" });
      expect(again.messageId).toBe(sent.messageId);

      // Board post + read through the call frames.
      await call(sim.c, "board_create", { name: "factory-test", purpose: "the factory skeleton's round-trip board" });
      const posted = await b.post({ board: "factory-test", body: "from the module", idempotencyKey: "post-1" });
      expect(posted.board).toBe("factory-test");
      const items = await b.readBoard("factory-test");
      expect(items.posts.some((p) => p.body === "from the module")).toBe(true);

      // Claim round-trip.
      const taken = await b.claimTake({ key: "factory-test:work", idempotencyKey: "claim-1", board: "factory-test" });
      expect((taken.claim as { key: string }).key).toBe("factory-test:work");
      const claims = await b.claimList();
      expect(claims.some((c) => c.key === "factory-test:work")).toBe(true);
      await b.claimRelease("factory-test:work", "done");

      // Settling the thread (dm_ack) clears the pending promise.
      await b.settle(sent.messageId);
      await until(async () => {
        const inbox = await b.inbox();
        return inbox.promised === undefined || !inbox.promised.some((p) => p.id === sent.messageId);
      }, 10_000, "the settled promise to leave dm_inbox");
    } finally {
      await b.close();
    }
  });

  test("a delegation request is answered in-thread by the module entry", async () => {
    token = await srv.login("you@example.com");
    const sim = await srv.session(token, "sim");
    const proc = Bun.spawn([process.execPath, join("adapters", "factory", "main.ts")], {
      env: { ...process.env, ...factoryEnv(), GRAYBOARD_CREDENTIALS: "" },
      cwd: join(import.meta.dir, "..", ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      // The factory is live and launcher-flagged before the request goes out.
      await until(async () => {
        const peers = (await call(sim.c, "peer_list")) as { peers: { handle: string; online?: boolean; launcher?: true }[] };
        const f = peers.peers.find((p) => p.handle === "you@example.com/factory");
        return f?.online === true && f.launcher === true;
      }, 10_000, "the factory launcher to appear online");

      const r = (await call(sim.c, "delegate", {
        persona: "a researcher",
        task: "check the factory skeleton",
        to: "factory",
      })) as { message_id: number; to: string };
      expect(r.to).toBe("you@example.com/factory");

      // The skeleton's receipt: the requester's thread carries the reply,
      // and the promise shows in dm_inbox until the requester settles it.
      await until(async () => {
        const inbox = (await call(sim.c, "dm_inbox")) as { promised?: { id: number }[] };
        return inbox.promised?.some((p) => p.id === r.message_id) === true;
      }, 10_000, "the delegation promise to appear in dm_inbox");
      const thread = (await call(sim.c, "dm_thread", { thread: r.message_id })) as { body: string }[];
      expect(thread.some((m) => m.body.startsWith("[factory] received"))).toBe(true);
    } finally {
      proc.kill();
      await proc.exited;
    }
  });
});

// The OpenCode translator wired into the module run loop (#265): a persona
// resolving to a fixture agent renders the Task directive in the thread; an
// unknown persona declines in-thread so the rotation/human path is visible.
// No live OpenCode spawn happens here (no harness credentials in CI) — the
// directive is the deliverable; the spawn itself is the launcher harness's.
describe("opencode translator", () => {
  test("a resolvable persona renders the Task directive; an unknown one declines in-thread", async () => {
    token = await srv.login("you@example.com");
    const sim = await srv.session(token, "sim");
    // The fixture agents dir the module reads (OPENCODE_AGENTS_ROOT).
    const agentsDir = join(dir, "agents-root", ".opencode", "agents");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, "researcher.md"),
      "---\nname: researcher\ndescription: A researcher persona for deep dives\nmodel: anthropic/claude-sonnet-4\n---\n# researcher\n",
    );
    const proc = Bun.spawn([process.execPath, join("adapters", "factory", "main.ts")], {
      env: { ...process.env, ...factoryEnv(), GRAYBOARD_CREDENTIALS: "", OPENCODE_AGENTS_ROOT: join(dir, "agents-root") },
      cwd: join(import.meta.dir, "..", ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      await until(async () => {
        const peers = (await call(sim.c, "peer_list")) as { peers: { handle: string; online?: boolean; launcher?: true }[] };
        const f = peers.peers.find((p) => p.handle === "you@example.com/factory");
        return f?.online === true && f.launcher === true;
      }, 10_000, "the factory launcher to appear online");

      // Resolvable persona: the directive replaces the skeleton receipt.
      const r = (await call(sim.c, "delegate", { persona: "a researcher persona", task: "survey the factory", to: "factory" })) as { message_id: number };
      await until(async () => {
        const inbox = (await call(sim.c, "dm_inbox")) as { promised?: { id: number }[] };
        return inbox.promised?.some((p) => p.id === r.message_id) === true;
      }, 10_000, "the delegation promise to appear");
      const thread = (await call(sim.c, "dm_thread", { thread: r.message_id })) as { body: string }[];
      const reply = thread.find((m) => m.body.includes("@researcher"));
      expect(reply).toBeDefined();
      expect(reply?.body).toContain("survey the factory");
      expect(reply?.body).not.toContain("[factory] received");

      // Unknown persona: declined in-thread, naming the persona.
      const r2 = (await call(sim.c, "delegate", { persona: "philosopher", task: "ponder", to: "factory" })) as { message_id: number };
      await until(async () => {
        const inbox = (await call(sim.c, "dm_inbox")) as { promised?: { id: number }[] };
        return inbox.promised?.some((p) => p.id === r2.message_id) === true;
      }, 10_000, "the second delegation promise to appear");
      const thread2 = (await call(sim.c, "dm_thread", { thread: r2.message_id })) as { body: string }[];
      expect(thread2.some((m) => m.body.includes("philosopher") && m.body.startsWith("[factory]"))).toBe(true);
    } finally {
      proc.kill();
      await proc.exited;
    }
  });
});
