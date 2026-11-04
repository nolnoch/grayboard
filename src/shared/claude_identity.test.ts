import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCurrent, runHook, sessionDir, takeRecord } from "./claude_agents.ts";
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
  expect(readCurrent(h.base, process.pid, start)).toBeNull();
  h.hook("session-start", { session_id: "B", source: "clear" });
  const b = readCurrent(h.base, process.pid, start)!;
  expect(b.session).toBe("B");
  expect(b.token).not.toBe(a.token);
  expect(takeRecord(h.base, process.pid, start, "toolu_first")).toEqual({ agent: null, session: "A" });
  h.hook("pre-tool-use", { session_id: "B", tool_use_id: "toolu_second" });
  expect(takeRecord(h.base, process.pid, start, "toolu_second")).toEqual({ agent: null, session: "B" });
  expect(readCurrent(h.base, process.pid, "another process start")).toBeNull();
});

test("a local clear cannot silently retain a current record it failed to revoke", () => {
  const h = harness();
  h.hook("session-start", { session_id: "A" });
  const current = join(sessionDir(h.base, process.pid), "current");
  rmSync(current);
  mkdirSync(current);
  expect(() => h.hook("session-end", { reason: "clear" })).toThrow();
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
  expect(await syncIdentity("session-start", JSON.stringify({ session_id: "B" }), h.base, h.env)).toEqual(["selected B"]);
  expect(seen).toEqual(["pause", "B"]);
});

test("publication before a child registers is read at registration and a live failed ack is visible", async () => {
  const h = harness();
  h.hook("session-start", { session_id: "B" });
  expect(await syncIdentity("session-start", JSON.stringify({ session_id: "B" }), h.base, h.env)).toEqual([]);
  cleanup.push(await listenIdentity(h.base, process.pid, async () => ({ error: "rotation refused" })));
  expect(readCurrent(h.base, process.pid, procStart(process.pid) ?? null)?.session).toBe("B");
  await expect(syncIdentity("pre-tool-use", JSON.stringify({ session_id: "B" }), h.base, h.env)).rejects.toThrow("rotation refused");
});

test("a failed SessionStart publication stays visible and cannot resume paused A", async () => {
  const h = harness();
  h.hook("session-start", { session_id: "A" });
  const seen: string[] = [];
  cleanup.push(await listenIdentity(h.base, process.pid, async request => {
    seen.push(request.action === "pause" ? "pause" : request.current!.session);
    return {};
  }));
  await syncIdentity("session-end", JSON.stringify({ reason: "clear" }), h.base, h.env);
  mkdirSync(join(sessionDir(h.base, process.pid), `current.tmp.${process.pid}`));
  let publicationError: unknown;
  try { h.hook("session-start", { session_id: "B", source: "clear" }); } catch (error) { publicationError = error; }
  let barrierError: unknown;
  try { await syncIdentity("session-start", JSON.stringify({ session_id: "B" }), h.base, h.env); } catch (error) { barrierError = error; }
  expect(readCurrent(h.base, process.pid, procStart(process.pid) ?? null)).toBeNull();
  await expect(syncIdentity("pre-tool-use", JSON.stringify({ session_id: "A" }), h.base, h.env)).rejects.toThrow("current conversation publication");
  expect(seen).toEqual(["pause"]);
  expect(publicationError).toBeInstanceOf(Error);
  expect(barrierError).toBeInstanceOf(Error);
});

for (const kind of ["symlink", "fifo", "oversized"] as const) test(`a ${kind} connection record fails promptly without following, blocking or reading whole`, async () => {
  const h = harness();
  h.hook("session-start", { session_id: "A" });
  cleanup.push(await listenIdentity(h.base, process.pid, async () => ({})));
  const file = join(sessionDir(h.base, process.pid), "connections", String(process.pid));
  const content = readFileSync(file, "utf8");
  rmSync(file);
  if (kind === "symlink") {
    const target = join(h.base, "record-target");
    writeFileSync(target, content);
    symlinkSync(target, file);
  } else if (kind === "fifo") execFileSync("mkfifo", [file]);
  else writeFileSync(file, content + " ".repeat(16 * 1024));
  const child = Bun.spawn([process.execPath, "--eval", `import { syncIdentity } from ${JSON.stringify(join(import.meta.dir, "claude_identity.ts"))};
await syncIdentity("session-start", JSON.stringify({ session_id: "A" }), process.argv[1], { CLAUDE_PID: process.argv[2] });` , h.base, String(process.pid)], { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  // A real OS FIFO read needs a subprocess deadline; fake time cannot unblock its syscall.
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 2_000);
  try {
    const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(timedOut).toBe(false);
    expect(code).not.toBe(0);
    expect(error).toContain("connection record");
  } finally { clearTimeout(timer); child.kill(); }
});

test("connection records validate fields and only accept their generated socket under the owned base", async () => {
  const h = harness();
  h.hook("session-start", { session_id: "A" });
  cleanup.push(await listenIdentity(h.base, process.pid, async () => ({})));
  const file = join(sessionDir(h.base, process.pid), "connections", String(process.pid));
  const record = JSON.parse(readFileSync(file, "utf8"));
  const outside = mkdtempSync(join(tmpdir(), "gb-cc-outside-"));
  cleanup.push(() => rmSync(outside, { recursive: true, force: true }));
  const other = join(outside, `.c${process.pid}.abcdef`);
  writeFileSync(other, "unrelated");
  for (const value of [{ ...record, socket: other }, { ...record, socket: join(h.base, `.c${process.pid + 1}.abcdef`) }, { ...record, start: [] }, { ...record, start: "" }, null]) {
    writeFileSync(file, JSON.stringify(value));
    await expect(syncIdentity("session-start", JSON.stringify({ session_id: "A" }), h.base, h.env)).rejects.toThrow("connection record");
    expect(readFileSync(other, "utf8")).toBe("unrelated");
  }
  const link = join(h.base, `.c${process.pid}.linkxx`);
  symlinkSync(record.socket, link);
  writeFileSync(file, JSON.stringify({ ...record, socket: link }));
  await expect(syncIdentity("session-start", JSON.stringify({ session_id: "A" }), h.base, h.env)).rejects.toThrow("owned regular socket");
  expect(existsSync(record.socket)).toBe(true);
});

test("dead endpoints remove their owned sockets but never unrelated files or external paths", async () => {
  const h = harness();
  h.hook("session-start", { session_id: "A" });
  const dir = join(sessionDir(h.base, process.pid), "connections");
  mkdirSync(dir);
  const path = join(h.base, ".c999999.abcdef");
  const server = createServer();
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(path, listening.resolve);
  await listening.promise;
  cleanup.push(() => server.close());
  writeFileSync(join(dir, "999999"), JSON.stringify({ socket: path, start: null }));
  expect(await syncIdentity("session-start", JSON.stringify({ session_id: "A" }), h.base, h.env)).toEqual([]);
  expect(existsSync(path)).toBe(false);
  expect(existsSync(join(dir, "999999"))).toBe(false);
  const ordinary = join(h.base, ".c999999.filexx");
  writeFileSync(ordinary, "unrelated regular file");
  writeFileSync(join(dir, "999999"), JSON.stringify({ socket: ordinary, start: null }));
  expect(await syncIdentity("session-start", JSON.stringify({ session_id: "A" }), h.base, h.env)).toEqual([]);
  expect(readFileSync(ordinary, "utf8")).toBe("unrelated regular file");
});

test("pruning a dead harness directory also removes only validated generated endpoint sockets", async () => {
  const h = harness();
  const dead = sessionDir(h.base, 999999), dir = join(dead, "connections");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dead, "start"), "dead");
  const path = join(h.base, ".c999998.abcdef"), regular = join(h.base, ".c999997.abcdef"), foreign = join(h.base, "foreign");
  const server = createServer();
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(path, listening.resolve);
  await listening.promise;
  cleanup.push(() => server.close());
  const live = join(h.base, `.c${process.pid}.livezz`), liveServer = createServer();
  const liveListening = Promise.withResolvers<void>();
  liveServer.once("error", liveListening.reject);
  liveServer.listen(live, liveListening.resolve);
  await liveListening.promise;
  cleanup.push(() => liveServer.close());
  writeFileSync(join(dir, String(process.pid)), JSON.stringify({ socket: live, start: procStart(process.pid) ?? null }));
  writeFileSync(regular, "keep regular");
  writeFileSync(foreign, "keep foreign");
  writeFileSync(join(dir, "999998"), JSON.stringify({ socket: path, start: null }));
  writeFileSync(join(dir, "999997"), JSON.stringify({ socket: regular, start: null }));
  writeFileSync(join(dir, "999996"), JSON.stringify({ socket: foreign, start: null }));
  execFileSync("mkfifo", [join(dir, "999993")]);
  h.hook("session-start", { session_id: "new" });
  expect(existsSync(dead)).toBe(false);
  expect(existsSync(path)).toBe(false);
  expect(existsSync(live)).toBe(true);
  expect(readFileSync(regular, "utf8")).toBe("keep regular");
  expect(readFileSync(foreign, "utf8")).toBe("keep foreign");
});

test("hosted SessionStart keeps best-effort facts behavior and never changes local current identity", () => {
  const h = harness();
  h.hook("session-start", { session_id: "A" });
  mkdirSync(join(sessionDir(h.base, process.pid), `start.tmp.${process.pid}`));
  expect(() => runHook("session-start", JSON.stringify({ session_id: "hosted-B", model: "claude-opus-5-5" }), { base: h.base, env: h.env, hosted: true })).not.toThrow();
  expect(readCurrent(h.base, process.pid, procStart(process.pid) ?? null)?.session).toBe("A");
});
