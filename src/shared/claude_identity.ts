// Local Claude hooks rendezvous with retained MCP children through the existing
// PID record directory. SessionEnd(clear) pauses before the host changes IDs;
// SessionStart publishes current, rotates every child, then returns its guidance.
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { join, resolve } from "node:path";
import { isAlive, procStart } from "./proc.ts";
import { dropIdentitySocket, isOwnedIdentitySocket, readCurrent, readIdentityConnection, sessionDir, type CurrentConversation } from "./claude_agents.ts";
import { validSourceId } from "./session_meta.ts";

export type IdentityRequest = { action: "pause" | "current"; current?: CurrentConversation };
export type IdentityReply = { instructions?: string[]; error?: string };
const TIMEOUT_MS = 8_000;

/** Register first, then read current: a hook cannot fall between discovery and publication. */
export async function listenIdentity(base: string, pid: number, handle: (request: IdentityRequest) => Promise<IdentityReply>): Promise<() => void> {
  const dir = join(sessionDir(base, pid), "connections");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(resolve(base), `.c${process.pid}.${Math.random().toString(36).slice(2, 8)}`);
  const record = join(dir, String(process.pid));
  const server = createServer(socket => {
    let buffer = "";
    socket.setTimeout(TIMEOUT_MS, () => socket.destroy());
    socket.on("error", () => {});
    socket.on("data", chunk => {
      buffer += chunk.toString();
      if (buffer.length > 8192) { socket.destroy(); return; }
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      socket.pause();
      void (async () => {
        try { socket.end(JSON.stringify(await handle(JSON.parse(buffer.slice(0, end)))) + "\n"); }
        catch (error) { socket.end(JSON.stringify({ error: (error as Error).message }) + "\n"); }
      })();
    });
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(path, () => { server.off("error", listening.reject); listening.resolve(); });
  await listening.promise;
  try {
    const temp = `${record}.tmp.${process.pid}`;
    writeFileSync(temp, JSON.stringify({ socket: path, start: procStart(process.pid) ?? null }), { mode: 0o600 });
    renameSync(temp, record);
  } catch (error) { server.close(); dropIdentitySocket(path); throw error; }
  return () => { rmSync(record, { force: true }); server.close(); dropIdentitySocket(path); };
}

function exchange(path: string, request: IdentityRequest): Promise<IdentityReply> {
  if (!isOwnedIdentitySocket(path)) throw new Error("Claude identity endpoint is not an owned regular socket");
  const { promise, resolve, reject } = Promise.withResolvers<IdentityReply>();
  const socket = connect(path);
  let buffer = "";
  let answered = false;
  socket.setTimeout(TIMEOUT_MS, () => socket.destroy(new Error("Claude identity acknowledgement timed out")));
  socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
  socket.on("error", reject);
  socket.on("data", chunk => {
    buffer += chunk.toString();
    if (buffer.length > 128 * 1024) { socket.destroy(new Error("Claude identity acknowledgement too large")); return; }
    const end = buffer.indexOf("\n");
    if (end < 0) return;
    try {
      const result = JSON.parse(buffer.slice(0, end)) as IdentityReply;
      answered = true;
      if (result.error) reject(new Error(result.error)); else resolve(result);
    } catch (error) { reject(error); }
    socket.end();
  });
  socket.on("close", () => { if (!answered) reject(new Error("Claude identity connection closed without acknowledgement")); });
  return promise;
}

/** A live child's failed ack is visible; a dead endpoint is pruned, never silently accepted. */
export async function syncIdentity(event: string, stdin: string, base: string, env = process.env): Promise<string[]> {
  const pid = Number(env.CLAUDE_PID);
  if (!Number.isSafeInteger(pid) || pid <= 1) return [];
  const input = JSON.parse(stdin) as { reason?: string; agent_id?: string; session_id?: unknown };
  const pause = event === "session-end" && input.reason === "clear";
  if (!pause && event !== "session-start" && !(event === "pre-tool-use" && input.agent_id === undefined)) return [];
  // Only this event's conversation can release the pause. Missing/failed B
  // publication must not turn the still-readable A record into permission.
  if (!pause && !validSourceId(input.session_id)) return [];
  const current = pause ? null : readCurrent(base, pid, procStart(pid) ?? null);
  if (!pause && (!current || current.session !== input.session_id)) throw new Error("Claude authoritative current conversation publication is missing or stale");
  const dir = join(sessionDir(base, pid), "connections");
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const replies = await Promise.all(names.filter(name => /^[1-9][0-9]*$/.test(name)).map(async name => {
    const file = join(dir, name);
    const record = readIdentityConnection(base, file, Number(name));
    if (!isAlive(Number(name), record.start)) {
      dropIdentitySocket(record.socket);
      rmSync(file, { force: true });
      return [];
    }
    const reply = await exchange(record.socket, pause ? { action: "pause" } : { action: "current", current: current! });
    return reply.instructions ?? [];
  }));
  return [...new Set(replies.flat())];
}
