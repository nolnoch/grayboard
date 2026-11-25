import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredIdentity, defaultIdentity, describeLocation, linkedWorktreeName, pinnedIdentity, resolveIdentity, sessionIdentity } from "./identity.ts";

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

describe("describeLocation", () => {
  test("main checkout and linked worktree, with live branch", () => {
    writeFileSync(at("repo", ".git", "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(at("repo", ".git", "worktrees", "stream"), { recursive: true });
    writeFileSync(at("repo", ".git", "worktrees", "stream", "HEAD"), "ref: refs/heads/wt-stream\n");
    expect(describeLocation(at("repo", "src"))).toBe("repo on main");
    expect(describeLocation(at("repo", ".wt", "stream", "src"))).toBe("repo worktree stream on wt-stream");
    writeFileSync(at("repo", ".git", "HEAD"), "0123456789abcdef\n");
    expect(describeLocation(at("repo"))).toBe("repo on 0123456");
  });
  test("outside git: the directory name", () => expect(describeLocation(at("plain", "sub"))).toBe("sub"));
});

describe("configuredIdentity (#443: a hosted adapter's start bind)", () => {
  test("nothing without an explicit BUS_IDENTITY", () => {
    expect(configuredIdentity({}, at("repo"))).toBeUndefined();
    expect(configuredIdentity({ BUS_IDENTITY: "" }, at("repo"))).toBeUndefined();
  });
  test("a pin echo is none", () => {
    const pin = { mcpServers: { grayboard: { command: "grayboard", args: ["mcp"], env: { BUS_IDENTITY: "be" } } } };
    writeFileSync(at("repo", ".mcp.json"), JSON.stringify(pin));
    try { expect(configuredIdentity({ BUS_IDENTITY: "be" }, at("repo", ".wt", "stream"))).toBeUndefined(); }
    finally { rmSync(at("repo", ".mcp.json")); }
  });
  test("an explicit one is lowercased, verbatim otherwise; one the naming rule refuses is an error", () => {
    expect(configuredIdentity({ BUS_IDENTITY: "Sim" }, at("repo", ".wt", "stream"))).toEqual({ name: "sim" });
    expect(configuredIdentity({ BUS_IDENTITY: "no spaces" }, at("repo"))).toEqual({ error: expect.stringContaining("invalid identity name") });
  });
  test("a server name may carry a scope (#543 audit 2)", () => {
    expect(configuredIdentity({ BUS_IDENTITY: "Eng/Deploy" }, at("repo"))).toEqual({ name: "eng/deploy" });
    expect(configuredIdentity({ BUS_IDENTITY: "you@example.com/sim" }, at("repo"))).toEqual({ name: "you@example.com/sim" });
  });
});

describe("sessionIdentity", () => {
  test("BUS_IDENTITY wins", () => expect(sessionIdentity({ BUS_IDENTITY: "be" }, at("repo"))).toBe("be"));
  test("default plus worktree suffix", () => expect(sessionIdentity({}, at("repo", ".wt", "stream"))).toBe("repo-stream"));
  test("empty BUS_IDENTITY falls back", () => expect(sessionIdentity({ BUS_IDENTITY: "" }, at("repo"))).toBe("repo"));

  test("an explicit BUS_IDENTITY is used verbatim: no worktree suffix", () => {
    const pin = { mcpServers: { grayboard: { command: "grayboard", args: ["mcp"], env: { BUS_IDENTITY: "be" } } } };
    writeFileSync(at("repo", ".mcp.json"), JSON.stringify(pin));
    try {
      // Differs from every pin: the user chose this name, and a worktree
      // session must join it — not fork a look-alike ("sim-stream") with an
      // empty mailbox, orphaning nothing because "sim-stream" never existed.
      expect(sessionIdentity({ BUS_IDENTITY: "sim" }, at("repo", ".wt", "stream"))).toBe("sim");
      expect(sessionIdentity({ BUS_IDENTITY: "sim" }, at("repo", "src"))).toBe("sim");
    } finally {
      rmSync(at("repo", ".mcp.json"));
    }
  });

  test("a BUS_IDENTITY that re-delivers the repo's pin stays derived: the suffix composes", () => {
    // Harnesses load the pin into BUS_IDENTITY; that's not an override.
    // Existing worktree handles ("be-stream") keep their name, mail and claims.
    const pin = { mcpServers: { grayboard: { command: "grayboard", args: ["mcp"], env: { BUS_IDENTITY: "be" } } } };
    writeFileSync(at("repo", ".mcp.json"), JSON.stringify(pin));
    try {
      expect(sessionIdentity({ BUS_IDENTITY: "be" }, at("repo", ".wt", "stream"))).toBe("be-stream");
    } finally {
      rmSync(at("repo", ".mcp.json"));
    }
  });

  test("a BUS_IDENTITY equal to the repo's .omp/mcp.json pin stays derived: the suffix composes", () => {
    // A BUS_IDENTITY equal to omp's .omp/mcp.json pin re-delivers it (omp
    // ran that entry before #523) — an omp session in a worktree must keep
    // the suffix it always had, so comparing against .mcp.json alone
    // (treating omp's pin as explicit) would orphan that handle's mail.
    const ompPin = { mcpServers: { grayboard: { command: "grayboard", args: ["mcp"], env: { BUS_IDENTITY: "fe" } } } };
    mkdirSync(at("repo", ".omp"), { recursive: true });
    writeFileSync(at("repo", ".omp", "mcp.json"), JSON.stringify(ompPin));
    try {
      expect(sessionIdentity({ BUS_IDENTITY: "fe" }, at("repo", ".wt", "stream"))).toBe("fe-stream");
      // With both pins present, matching EITHER one stays derived.
      const pin = { mcpServers: { grayboard: { command: "grayboard", args: ["mcp"], env: { BUS_IDENTITY: "be" } } } };
      writeFileSync(at("repo", ".mcp.json"), JSON.stringify(pin));
      try {
        expect(sessionIdentity({ BUS_IDENTITY: "be" }, at("repo", ".wt", "stream"))).toBe("be-stream");
        expect(sessionIdentity({ BUS_IDENTITY: "fe" }, at("repo", ".wt", "stream"))).toBe("fe-stream");
      } finally {
        rmSync(at("repo", ".mcp.json"));
      }
    } finally {
      rmSync(at("repo", ".omp"), { recursive: true, force: true });
    }
  });

  test("default naming reads a repo's .omp/mcp.json pin under omp only, after .mcp.json, enabled or not", () => {
    // Other harnesses never read .omp/mcp.json: a repo that pins only there
    // keeps their directory-derived handles (#182). Under omp (its local
    // adapter sets BUS_HARNESS=omp) the pin names the session, from a
    // disabled entry too, since the adapter refuses an enabled one (#523).
    const ompPin = { mcpServers: { grayboard: { command: "grayboard", args: ["mcp"], enabled: false, env: { BUS_IDENTITY: "fe" } } } };
    mkdirSync(at("repo", ".omp"), { recursive: true });
    writeFileSync(at("repo", ".omp", "mcp.json"), JSON.stringify(ompPin));
    try {
      for (const env of [{}, { BUS_HARNESS: "pi" }]) {
        expect(sessionIdentity(env, at("repo", "src"))).toBe("repo");
        expect(sessionIdentity(env, at("repo", ".wt", "stream"))).toBe("repo-stream");
        expect(pinnedIdentity(at("repo", "src"), env)).toBeUndefined();
      }
      const omp = { BUS_HARNESS: "omp" };
      expect(sessionIdentity(omp, at("repo", "src"))).toBe("fe");
      expect(sessionIdentity(omp, at("repo", ".wt", "stream"))).toBe("fe-stream");
      expect(pinnedIdentity(at("repo", "src"), omp)).toEqual({ name: "fe", file: ".omp/mcp.json" });
      // .mcp.json's pin comes first, under omp too.
      writeFileSync(at("repo", ".mcp.json"), JSON.stringify({ mcpServers: { grayboard: { command: "grayboard", args: ["mcp"], env: { BUS_IDENTITY: "be" } } } }));
      try {
        expect(sessionIdentity(omp, at("repo", "src"))).toBe("be");
        expect(pinnedIdentity(at("repo", "src"), omp)).toEqual({ name: "be", file: ".mcp.json" });
      } finally {
        rmSync(at("repo", ".mcp.json"));
      }
    } finally {
      rmSync(at("repo", ".omp"), { recursive: true, force: true });
    }
  });

  test("a user-scope BUS_IDENTITY is one name across worktrees: the collision is loud", () => {
    // No repo pin: an env value from a user-level registration (claude mcp
    // add -e, pi's user mcp.json) is a chosen task name, used verbatim in
    // every worktree. Two worktree sessions then resolve to the same name;
    // the second starts unbound and names the holder (#182), which keeps one
    // live session per name instead of the silent push-loss the suffix used
    // to paper over.
    expect(sessionIdentity({ BUS_IDENTITY: "be" }, at("repo", ".wt", "stream"))).toBe("be");
    expect(sessionIdentity({ BUS_IDENTITY: "be" }, at("repo", ".wt", "be-throughput"))).toBe("be");
  });

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
