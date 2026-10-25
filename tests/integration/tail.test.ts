// `grayboard tail` as a viewer session (#284 PR 2 S9), over real local-mode
// processes: it gets a board's posts, is never listed, notified or
// addressable, and a tail killed hard is ended by the next opener.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI } from "../support/paths.ts";
import { localEnv } from "../support/env.ts";
import { closeSessions, localSession, type Session } from "../support/mcp.ts";
import { until } from "../support/until.ts";

let dir: string;
const tails: Bun.Subprocess[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grayboard-tail-"));
});

afterEach(async () => {
  for (const p of tails.splice(0)) p.kill("SIGKILL");
  await closeSessions();
  rmSync(dir, { recursive: true, force: true });
});

function rows<T>(sql: string, ...args: (string | number)[]): T[] {
  const db = new Database(join(dir, "bus.db"), { readonly: true });
  try {
    return db.prepare(sql).all(...args) as T[];
  } finally {
    db.close();
  }
}

async function refusal(s: Session, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const r = await s.c.callTool({ name, arguments: args });
  const text = (r.content as { text: string }[])[0]!.text;
  if (!r.isError) throw new Error(`${name} succeeded: ${text}`);
  return text;
}

// A running `grayboard tail <board>`, its output read as it arrives, and its
// session ID once it has registered.
async function tail(board: string) {
  const before = new Set(rows<{ id: string }>(`SELECT id FROM ids WHERE viewer = 1`).map((r) => r.id));
  const p = Bun.spawn([process.execPath, CLI, "tail", board], { cwd: dir, env: localEnv(dir), stdout: "pipe", stderr: "pipe" });
  tails.push(p);
  let out = "";
  let err = "";
  (async () => {
    for await (const chunk of p.stdout) out += new TextDecoder().decode(chunk);
  })();
  (async () => {
    for await (const chunk of p.stderr) err += new TextDecoder().decode(chunk);
  })();
  await until(() => err.includes(`-- tailing #${board}`));
  const id = rows<{ id: string }>(`SELECT id FROM ids WHERE viewer = 1`).map((r) => r.id).find((i) => !before.has(i))!;
  return { p, id, out: () => out };
}

const endedAt = (id: string) => rows<{ ended_at: number | null }>(`SELECT ended_at FROM ids WHERE id = ?`, id)[0]!.ended_at;
const subscribed = (id: string) => rows(`SELECT board FROM subscriptions WHERE handle = ?`, id).length > 0;

test("a tail is a viewer session: it gets the board's posts, and isn't listed, notified, sent to or mentioned", async () => {
  const be = await localSession(dir, "be");
  await be.call("board_create", { name: "e2e", purpose: "fixtures" });
  await be.call("board_post", { board: "e2e", body: "before" });
  const t = await tail("e2e");
  expect(t.id).toMatch(/^id:[0-9a-z]{13}$/);
  expect(subscribed(t.id)).toBe(true);
  await until(() => t.out().includes("be: before"));

  const posted = await be.call("board_post", { board: "e2e", body: "live" });
  await until(() => t.out().includes("be: live"));
  expect(posted.notified).toEqual([]);
  const seen = await be.call("peer_list", { include_offline: true });
  expect(JSON.stringify(seen)).not.toContain(t.id);
  expect(await refusal(be, "dm_send", { to: t.id, body: "hi" })).toBe(`error: not_found: no session ${t.id}`);
  expect(await refusal(be, "board_post", { board: "e2e", body: `@${t.id} hi` })).toBe(`error: not_found: no session ${t.id}`);
}, 20_000);

test("a tail stopped by a signal ends its session; one killed hard is ended by the next process to open the bus", async () => {
  const be = await localSession(dir, "be");
  await be.call("board_create", { name: "e2e", purpose: "fixtures" });

  const stopped = await tail("e2e");
  stopped.p.kill("SIGINT");
  expect(await stopped.p.exited).toBe(0);
  expect(endedAt(stopped.id)).not.toBeNull();
  expect(subscribed(stopped.id)).toBe(false);

  const killed = await tail("e2e");
  killed.p.kill("SIGKILL");
  await killed.p.exited;
  expect(endedAt(killed.id)).toBeNull();
  await localSession(dir, "fe");
  expect(endedAt(killed.id)).not.toBeNull();
  expect(subscribed(killed.id)).toBe(false);
}, 20_000);
