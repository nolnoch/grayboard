import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actingIdentity, busHandle } from "./claim.ts";

let root: string;
const at = (...p: string[]) => join(root, ...p);

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "grayboard-claim-"));
  mkdirSync(at("repo", ".git", "worktrees"), { recursive: true });
  mkdirSync(at("repo", "src"), { recursive: true });
  mkdirSync(at("repo", ".wt", "stream", "src"), { recursive: true });
  writeFileSync(at("repo", ".wt", "stream", ".git"), `gitdir: ${at("repo", ".git", "worktrees", "stream")}\n`);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("actingIdentity: --as, an explicit BUS_IDENTITY, and server mode's derived rule", () => {
  test("--as is literal: no worktree suffix", () =>
    expect(actingIdentity("sim", {}, at("repo", ".wt", "stream"))).toEqual({ name: "sim", source: "--as" }));

  test("an explicit BUS_IDENTITY is literal, like a session's: no worktree suffix", () => {
    const pin = { mcpServers: { grayboard: { command: "grayboard", args: ["mcp"], env: { BUS_IDENTITY: "be" } } } };
    writeFileSync(at("repo", ".mcp.json"), JSON.stringify(pin));
    try {
      const r = actingIdentity(undefined, { BUS_IDENTITY: "sim" }, at("repo", ".wt", "stream"));
      expect(r).toEqual({ name: "sim", source: "BUS_IDENTITY" });
    } finally {
      rmSync(at("repo", ".mcp.json"));
    }
  });

  test("a BUS_IDENTITY that re-delivers the pin stays derived: the suffix composes", () => {
    // The shell takes claims as the handle its directory's session uses, so a
    // harness-delivered pin in a worktree must keep the same suffixed handle.
    const pin = { mcpServers: { grayboard: { command: "grayboard", args: ["mcp"], env: { BUS_IDENTITY: "be" } } } };
    writeFileSync(at("repo", ".mcp.json"), JSON.stringify(pin));
    try {
      const r = actingIdentity(undefined, { BUS_IDENTITY: "be" }, at("repo", ".wt", "stream"));
      expect(r.name).toBe("be-stream");
      expect(r.source).toContain("plus worktree");
    } finally {
      rmSync(at("repo", ".mcp.json"));
    }
  });

  test("no BUS_IDENTITY: the pin and its worktree suffix, or the directory name", () => {
    expect(actingIdentity(undefined, {}, at("repo", "src"))).toEqual({ name: "repo", source: "the directory name" });
    const pin = { mcpServers: { grayboard: { command: "grayboard", args: ["mcp"], env: { BUS_IDENTITY: "be" } } } };
    writeFileSync(at("repo", ".mcp.json"), JSON.stringify(pin));
    try {
      expect(actingIdentity(undefined, {}, at("repo", "src"))).toEqual({ name: "be", source: "the repo's .mcp.json pin" });
      expect(actingIdentity(undefined, {}, at("repo", ".wt", "stream", "src")).name).toBe("be-stream");
    } finally {
      rmSync(at("repo", ".mcp.json"));
    }
  });

  test("an empty BUS_IDENTITY falls through to the pin, as sessionIdentity does", () => {
    const pin = { mcpServers: { grayboard: { command: "grayboard", args: ["mcp"], env: { BUS_IDENTITY: "be" } } } };
    writeFileSync(at("repo", ".mcp.json"), JSON.stringify(pin));
    try {
      expect(actingIdentity(undefined, { BUS_IDENTITY: "" }, at("repo", "src"))).toEqual({
        name: "be",
        source: "the repo's .mcp.json pin",
      });
    } finally {
      rmSync(at("repo", ".mcp.json"));
    }
  });

  test("names resolve by the server's rule: lowercased, invalid refused (#181)", () => {
    // The shell must act as the handle the session claims: the same explicit
    // name, lowercased, in both modes.
    expect(actingIdentity("Gray", {}, at("repo", "src"))).toEqual({ name: "gray", source: "--as" });
    const pin = { mcpServers: { grayboard: { command: "grayboard", args: ["mcp"], env: { BUS_IDENTITY: "be" } } } };
    writeFileSync(at("repo", ".mcp.json"), JSON.stringify(pin));
    try {
      expect(actingIdentity(undefined, { BUS_IDENTITY: "Sim" }, at("repo", "src"))).toEqual({
        name: "sim",
        source: "BUS_IDENTITY",
      });
    } finally {
      rmSync(at("repo", ".mcp.json"));
    }

    // A name invalid after lowercasing refuses, with the reason.
    expect(() => actingIdentity("Gray!", {}, at("repo", "src"))).toThrow(/invalid --as "Gray!"/);
    expect(() => actingIdentity(undefined, { BUS_IDENTITY: "Gray!" }, at("repo", "src"))).toThrow(/invalid identity name/);
  });
});

// #284 S9: on a server a shell may act as a team's alias it can hold.
test("server mode takes a scoped name, as-is; local mode refuses one", () => {
  expect(actingIdentity("Eng/Deploy", {}, at("repo", "src"), undefined, true)).toEqual({ name: "eng/deploy", source: "--as" });
  expect(actingIdentity(undefined, { BUS_IDENTITY: "eng/build" }, at("repo", "src"), undefined, true)).toEqual({ name: "eng/build", source: "BUS_IDENTITY" });
  expect(() => actingIdentity("eng/deploy", {}, at("repo", "src"))).toThrow(/invalid --as "eng\/deploy"/);
  const env = { GRAYBOARD_CREDENTIALS: join(root, "creds.json") };
  writeFileSync(env.GRAYBOARD_CREDENTIALS, JSON.stringify({ server: "http://x", token: "t", user_email: "you@example.com" }));
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    expect(busHandle("eng/deploy", "server")).toBe("eng/deploy");
    expect(busHandle("Be", "server")).toBe("you@example.com/be");
  } finally {
    process.env = saved;
  }
});

describe("the local rule: the shell's bound session (#182 decision 18)", () => {
  const row = (name: string | null, harness_pid: number | null, ...cwd: string[]) => ({ name, harness_pid, cwd: at(...cwd) });

  test("the session whose harness is an ancestor, wherever it runs", () => {
    const view = { sessions: [row("eng-142", 40, "repo"), row("other", 50, "repo", "src")], ancestors: [99, 40, 7] };
    expect(actingIdentity(undefined, {}, at("repo", "src"), view)).toEqual({ name: "eng-142", source: "the session this shell runs under" });
  });

  test("several under one harness: the checkout narrows them; a linked worktree is its own checkout", () => {
    const view = { sessions: [row("main", 40, "repo"), row("stream", 40, "repo", ".wt", "stream")], ancestors: [40] };
    expect(actingIdentity(undefined, {}, at("repo", "src"), view).name).toBe("main");
    expect(actingIdentity(undefined, {}, at("repo", ".wt", "stream", "src"), view).name).toBe("stream");
  });

  test("no ancestor match: the one session in this checkout", () => {
    const view = { sessions: [row("main", 40, "repo", "src"), row("stream", 41, "repo", ".wt", "stream")], ancestors: [99] };
    expect(actingIdentity(undefined, {}, at("repo"), view)).toEqual({ name: "main", source: "the session in this checkout" });
  });

  test("none, several, or an unbound one refuses and points at --as", () => {
    const two = { sessions: [row("a", 40, "repo"), row("b", 41, "repo", "src")], ancestors: [99] };
    expect(() => actingIdentity(undefined, {}, at("repo"), two)).toThrow(/2 live sessions could own this shell \(a, b\); pass --as/);
    expect(() => actingIdentity(undefined, {}, at("repo"), { sessions: [], ancestors: [] })).toThrow(/no live session.*pass --as/);
    const unbound = { sessions: [row(null, 40, "repo")], ancestors: [40] };
    expect(() => actingIdentity(undefined, {}, at("repo"), unbound)).toThrow(/hasn't bound a name yet/);
    // Several under this shell's harness, none in this checkout: says so (#182 audit 29).
    const elsewhere = { sessions: [row("main", 40, "repo"), row("stream", 40, "repo", ".wt", "stream")], ancestors: [40] };
    expect(() => actingIdentity(undefined, {}, root, elsewhere)).toThrow(/2 live sessions run this shell \(main, stream\), none in this checkout; pass --as/);
  });

  test("--as and an explicit BUS_IDENTITY still win", () => {
    const view = { sessions: [row("eng-142", 40, "repo")], ancestors: [40] };
    expect(actingIdentity("sim", {}, at("repo"), view).name).toBe("sim");
    expect(actingIdentity(undefined, { BUS_IDENTITY: "sim" }, at("repo"), view).name).toBe("sim");
  });
});
