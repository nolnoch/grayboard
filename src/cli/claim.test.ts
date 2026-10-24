import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actingIdentity } from "./claim.ts";

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

describe("actingIdentity", () => {
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
});
