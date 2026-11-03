// A local `grayboard mcp` on a machine signed in to a server (#491): a bare
// entry is told, first in every render, that the team isn't on this bus; an
// entry that passes `--mode local` chose it and is only audited.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeSessions, localSession, type Session } from "../support/mcp.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grayboard-signedin-"));
});
afterEach(async () => {
  await closeSessions();
  rmSync(dir, { recursive: true, force: true });
});

const SERVER = "https://bus.example.com";
const signIn = (body = JSON.stringify({ session_token: "t", server: SERVER, user_email: "you@example.com" })) =>
  writeFileSync(join(dir, "credentials"), body);
const bare = (extra: Record<string, string> = {}) => localSession(dir, undefined, { args: ["mcp"], extra });
const pinned = () => localSession(dir, undefined, { args: ["mcp", "--mode", "local"] });

function audits(): { actor: string; target: string; detail: Record<string, unknown> }[] {
  const db = new Database(join(dir, "bus.db"), { readonly: true });
  try {
    return (db.prepare(`SELECT actor, target, detail FROM audit_log WHERE action = 'id.signed_in_local' ORDER BY rowid`).all() as { actor: string; target: string; detail: string }[])
      .map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
  } finally {
    db.close();
  }
}

const notice = (server: string) => `Warning: this machine is signed in to ${server}, but this grayboard MCP entry runs the local bus`;

async function bindInstructions(s: Session, name: string): Promise<string[]> {
  const r = await s.c.callTool({ name: "bind", arguments: { name, create: true } });
  expect(r.isError).toBeFalsy();
  return (r.structuredContent as { instructions: string[] }).instructions;
}

test("a bare entry on a signed-in machine leads every render with the notice, logs it and audits it", async () => {
  signIn();
  const s = await bare();
  expect(s.c.getInstructions()).toStartWith(notice(SERVER));
  expect(s.stderr()).toContain(`[grayboard] this machine is signed in to ${SERVER}, but this entry runs the local bus.`);
  const { id } = await s.call("whoami");
  const bound = await bindInstructions(s, "fe");
  expect(bound[0]).toStartWith(notice(SERVER));
  expect(bound.filter((l) => l.startsWith("Warning: this machine is signed in"))).toHaveLength(1);
  const unbound = await s.c.callTool({ name: "unbind", arguments: { name: "fe" } });
  expect((unbound.structuredContent as { instructions: string[] }).instructions[0]).toStartWith(notice(SERVER));
  const rows = audits();
  expect(rows).toHaveLength(1);
  expect(rows[0]!.detail).toEqual({ server: SERVER, mode_pinned: false });
  expect(rows[0]).toMatchObject({ actor: id, target: id });
});

test("an entry that passes --mode local is audited but not warned", async () => {
  signIn();
  const s = await pinned();
  expect(s.c.getInstructions()).not.toContain("is signed in to");
  expect(s.stderr()).not.toContain("is signed in to");
  expect((await bindInstructions(s, "fe")).some((l) => l.includes("is signed in to"))).toBe(false);
  expect(audits().map((r) => r.detail)).toEqual([{ server: SERVER, mode_pinned: true }]);
});

test("a machine with no sign-in gets no notice and no row", async () => {
  const s = await bare();
  expect(s.c.getInstructions()).not.toContain("is signed in to");
  expect(audits()).toEqual([]);
});

test("a signed-out (truncated) credentials file names no server; GRAYBOARD_SERVER names it when set", async () => {
  signIn("");
  const s = await bare();
  expect(s.c.getInstructions()).toStartWith(notice("a grayboard server"));
  expect(audits().map((r) => r.detail)).toEqual([{ server: null, mode_pinned: false }]);
  await closeSessions();
  const t = await bare({ GRAYBOARD_SERVER: "https://other.example.com" });
  expect(t.c.getInstructions()).toStartWith(notice("https://other.example.com"));
});

test("GRAYBOARD_TOKEN alone counts as signed in", async () => {
  const s = await bare({ GRAYBOARD_TOKEN: "t", GRAYBOARD_SERVER: SERVER });
  expect(s.c.getInstructions()).toStartWith(notice(SERVER));
});
