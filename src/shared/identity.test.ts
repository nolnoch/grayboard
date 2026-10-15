import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkedWorktreeName, resolveIdentity } from "./identity.ts";

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
