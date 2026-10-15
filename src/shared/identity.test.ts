import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultIdentity, linkedWorktreeName, resolveIdentity, sessionIdentity } from "./identity.ts";

let root: string;
const at = (...p: string[]) => join(root, ...p);

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "grayboard-identity-"));
  mkdirSync(at("plain", "sub"), { recursive: true });
  mkdirSync(at("repo", ".git", "worktrees"), { recursive: true });
  mkdirSync(at("repo", "src"), { recursive: true });
  for (const wt of ["stream", "be-throughput", "Fix Login!", "a-very-long-worktree-name-that-overflows", "be"]) {
    mkdirSync(at("repo", ".wt", wt, "src"), { recursive: true });
    writeFileSync(at("repo", ".wt", wt, ".git"), `gitdir: ${at("repo", ".git", "worktrees", wt)}\n`);
  }
  mkdirSync(at("My Repo!", ".git"), { recursive: true });
  mkdirSync(at("bare.git", "worktrees"), { recursive: true });
  mkdirSync(at("bare-wt"), { recursive: true });
  writeFileSync(at("bare-wt", ".git"), `gitdir: ${at("bare.git", "worktrees", "bare-wt")}\n`);
  mkdirSync(at("repo", "vendor", "lib"), { recursive: true });
  writeFileSync(at("repo", "vendor", "lib", ".git"), `gitdir: ${at("repo", ".git", "modules", "lib")}\n`);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("linkedWorktreeName", () => {
  test("outside git", () => expect(linkedWorktreeName(at("plain", "sub"))).toBeNull());
  test("main checkout", () => expect(linkedWorktreeName(at("repo", "src"))).toBeNull());
  test("linked worktree root", () => expect(linkedWorktreeName(at("repo", ".wt", "stream"))).toBe("stream"));
  test("nested inside a linked worktree", () => expect(linkedWorktreeName(at("repo", ".wt", "stream", "src"))).toBe("stream"));
  test("submodule is not a worktree", () => expect(linkedWorktreeName(at("repo", "vendor", "lib"))).toBeNull());
});

describe("resolveIdentity", () => {
  test("main checkout keeps base verbatim", () => expect(resolveIdentity("Gray", at("repo"))).toBe("Gray"));
  test("worktree name is suffixed", () => expect(resolveIdentity("be", at("repo", ".wt", "stream"))).toBe("be-stream"));
  test("already-prefixed worktree name used as-is", () =>
    expect(resolveIdentity("be", at("repo", ".wt", "be-throughput"))).toBe("be-throughput"));
  test("worktree named like the base keeps base", () => expect(resolveIdentity("be", at("repo", ".wt", "be"))).toBe("be"));
  test("invalid chars sanitized", () => expect(resolveIdentity("be", at("repo", ".wt", "Fix Login!"))).toBe("be-fix-login"));
  test("truncated to 32 chars", () => {
    const id = resolveIdentity("be", at("repo", ".wt", "a-very-long-worktree-name-that-overflows"));
    expect(id.length).toBeLessThanOrEqual(32);
    expect(id).toMatch(/^be-a-very-long-worktree-name[a-z-]*[a-z]$/);
  });
});

describe("defaultIdentity", () => {
  test("repo directory name", () => expect(defaultIdentity(at("repo", "src"))).toBe("repo"));
  test("a worktree counts as its repo", () => expect(defaultIdentity(at("repo", ".wt", "stream", "src"))).toBe("repo"));
  test("worktree of a bare repo", () => expect(defaultIdentity(at("bare-wt"))).toBe("bare"));
  test("submodule is its own repo", () => expect(defaultIdentity(at("repo", "vendor", "lib"))).toBe("lib"));
  test("sanitized", () => expect(defaultIdentity(at("My Repo!"))).toBe("my-repo"));
  test("outside git: the directory name", () => expect(defaultIdentity(at("plain", "sub"))).toBe("sub"));
});

describe("sessionIdentity", () => {
  test("BUS_IDENTITY wins", () => expect(sessionIdentity({ BUS_IDENTITY: "be" }, at("repo"))).toBe("be"));
  test("default plus worktree suffix", () => expect(sessionIdentity({}, at("repo", ".wt", "stream"))).toBe("repo-stream"));
  test("empty BUS_IDENTITY falls back", () => expect(sessionIdentity({ BUS_IDENTITY: "" }, at("repo"))).toBe("repo"));

  test("unset BUS_IDENTITY uses the repo's .mcp.json pin, worktrees included", () => {
    const pin = { mcpServers: { grayboard: { command: "grayboard", args: ["mcp"], env: { BUS_IDENTITY: "be" } } } };
    writeFileSync(at("repo", ".mcp.json"), JSON.stringify(pin));
    try {
      expect(sessionIdentity({}, at("repo", "src"))).toBe("be");
      expect(sessionIdentity({}, at("repo", ".wt", "stream"))).toBe("be-stream");
      expect(sessionIdentity({ BUS_IDENTITY: "other" }, at("repo"))).toBe("other");
      writeFileSync(at("repo", ".mcp.json"), "{ not json");
      expect(sessionIdentity({}, at("repo"))).toBe("repo");
    } finally {
      rmSync(at("repo", ".mcp.json"));
    }
  });
});
