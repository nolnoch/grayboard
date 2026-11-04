import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCurrent, runHook, takeRecord } from "./claude_agents.ts";
import { listenIdentity, syncIdentity } from "./claude_identity.ts";
import { procStart } from "./proc.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function harness() {
  const base = mkdtempSync(join(tmpdir(), "gb-cc-id-"));
  cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  const env = { CLAUDE_PID: String(process.pid) };
  const hook = (event: string, input: object) => runHook(event, JSON.stringify(input), { base, env, hosted: false });
  return { base, env, hook };
}

test("SessionStart's current record and PreToolUse's identity follow /clear, not retained environment", () => {
  const h = harness(), start = procStart(process.pid) ?? null;
  h.hook("session-start", { session_id: "A", source: "startup" });
  const a = readCurrent(h.base, process.pid, start)!;
  h.hook("pre-tool-use", { session_id: "A", tool_use_id: "toolu_first" });
  h.hook("session-end", { reason: "clear" });
  h.hook("session-start", { session_id: "B", source: "clear" });
  const b = readCurrent(h.base, process.pid, start)!;
  expect(b.session).toBe("B");
  expect(b.token).not.toBe(a.token);
  expect(takeRecord(h.base, process.pid, start, "toolu_first")).toEqual({ agent: null, session: "A" });
  h.hook("pre-tool-use", { session_id: "B", tool_use_id: "toolu_second" });
  expect(takeRecord(h.base, process.pid, start, "toolu_second")).toEqual({ agent: null, session: "B" });
  expect(readCurrent(h.base, process.pid, "another process start")).toBeNull();
});

test("a hook waits for a retained child's pause/rotation acknowledgement and returns current guidance", async () => {
  const h = harness();
  h.hook("session-start", { session_id: "A" });
  const admitted = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const seen: string[] = [];
  const stop = await listenIdentity(h.base, process.pid, async request => {
    seen.push(request.action === "pause" ? "pause" : request.current!.session);
    admitted.resolve();
    await release.promise;
    return request.action === "pause" ? {} : { instructions: ["selected B"] };
  });
  cleanup.push(stop);
  let answered = false;
  const pausing = syncIdentity("session-end", JSON.stringify({ reason: "clear" }), h.base, h.env).then(result => { answered = true; return result; });
  await admitted.promise;
  expect(answered).toBe(false);
  release.resolve();
  expect(await pausing).toEqual([]);
  h.hook("session-start", { session_id: "B", source: "clear" });
  expect(await syncIdentity("session-start", "{}", h.base, h.env)).toEqual(["selected B"]);
  expect(seen).toEqual(["pause", "B"]);
});

test("publication before a child registers is read at registration and a live failed ack is visible", async () => {
  const h = harness();
  h.hook("session-start", { session_id: "B" });
  expect(await syncIdentity("session-start", "{}", h.base, h.env)).toEqual([]);
  cleanup.push(await listenIdentity(h.base, process.pid, async () => ({ error: "rotation refused" })));
  expect(readCurrent(h.base, process.pid, procStart(process.pid) ?? null)?.session).toBe("B");
  await expect(syncIdentity("pre-tool-use", "{}", h.base, h.env)).rejects.toThrow("rotation refused");
});
