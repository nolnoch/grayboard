// Real pi/omp consumers: excluded roots still serve tools without ordinary
// conversation association, including after a selected-conversation change.
import { expect } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { z } from "zod";
import { mintSessionKey } from "../../src/core/bindings.ts";
import { runCli } from "./cli.ts";
import { localEnv } from "./env.ts";
import { startFakeModel } from "./fake_model.ts";
import { localSession } from "./mcp.ts";
import { type Pi, resultText, scripted, stopAll, toolResultNamed } from "./pi.ts";
import type { ChildProcess } from "node:child_process";
import { until } from "./until.ts";

type Start = (port: number, procs: ChildProcess[], identity: string | null, env: Record<string, string>) => Pi;
const WhoSchema = z.object({ id: z.string(), primary: z.string(), child: z.boolean().optional(), root: z.string().optional() }).passthrough();
export async function localAdapterExcludedScenario(dir: string, kind: "keyed" | "human" | "runner", prefix: string, start: Start): Promise<void> {
  const procs: ChildProcess[] = [];
  const model = startFakeModel([scripted("who", [{ tool: prefix + "whoami", args: {} }])]);
  let db: Database | undefined;
  try {
    let parent: string | undefined;
    const env: Record<string, string> = {};
    if (kind === "keyed") env.BUS_SESSION_KEY = mintSessionKey();
    else if (kind === "human") {
      expect((await runCli(["human", "adapter-human"], { cwd: dir, env: localEnv(dir) })).code).toBe(0);
      env.BUS_HUMAN = "1";
    } else {
      const root = await localSession(dir, "adapter-parent", { extra: {
        BUS_HARNESS_SESSION: "excluded-parent", BUS_SESSION_KEY: mintSessionKey(), BUS_HARNESS_PID: String(process.pid),
      } });
      parent = (await root.call("whoami")).id;
      env.BUS_PARENT_SESSION = "excluded-parent";
    }
    const runtime = start(model.port, procs, kind === "human" ? "adapter-human" : null, env);
    const original = await runtime.command({ type: "get_state" }, 30_000);
    for (let attempt = 0; attempt < 2; attempt++) {
      const nth = (await runtime.messages()).filter(m => m.role === "toolResult" && m.toolName === prefix + "whoami").length;
      await runtime.command({ type: "prompt", message: "who" });
      const result = await toolResultNamed(runtime, prefix + "whoami", nth);
      expect(result.isError).toBeFalsy();
      const who = WhoSchema.parse(JSON.parse(resultText(result)));
      db ??= new Database(join(dir, "bus.db"), { readonly: true });
      expect(db.query("SELECT local_resume, keyed, root_id FROM ids WHERE id = ?").get(who.id)).toEqual({
        local_resume: 0, keyed: kind === "keyed" ? 1 : 0, root_id: parent ?? null,
      });
      if (parent) expect(who).toMatchObject({ child: true, root: parent, primary: "adapter-parent" });
      if (kind === "human") expect(who.primary).toBe("adapter-human");
      await until(async () => {
        const state = await runtime.command({ type: "get_state" });
        return state.isSettled === true || (state.isStreaming === false && state.pendingMessageCount === 0);
      }, 30_000, "excluded adapter settled");
      if (attempt === 0) {
        await runtime.command({ type: "new_session" });
        expect((await runtime.command({ type: "get_state" })).sessionId).not.toBe(original.sessionId);
      }
    }
    expect(runtime.events.filter(e => e.type === "extension_error")).toEqual([]);
    expect(model.unhandled).toEqual([]);
    await runtime.quit();
  } finally {
    await stopAll(procs);
    db?.close();
    model.stop();
  }
}
