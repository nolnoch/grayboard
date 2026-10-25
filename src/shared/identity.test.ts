import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultIdentity, describeLocation, linkedWorktreeName, resolveIdentity, sessionIdentity, sessionLane } from "./identity.ts";

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

describe("sessionIdentity", () => {
  test("a true explicit BUS_IDENTITY wins, literal: no worktree suffix", () => {
    expect(sessionIdentity({ BUS_IDENTITY: "be" }, at("repo"))).toBe("be");
    // The wrong-fleet bug: an explicit identity launched from a worktree
    // joins that identity's fleet instead of forking a look-alike.
    expect(sessionIdentity({ BUS_IDENTITY: "be" }, at("repo", ".wt", "stream"))).toBe("be");
    // BUS_LANE makes it explicit even when it matches the pin: the user
    // named the fleet they're joining.
    expect(sessionIdentity({ BUS_IDENTITY: "be", BUS_LANE: "x" }, at("repo", ".wt", "stream"))).toBe("be");
  });
  test("a BUS_IDENTITY that re-delivers the repo's pin is derived: the suffix composes (be-stream keeps its mail and claims)", () => {
    const pin = { mcpServers: { grayboard: { command: "grayboard", args: ["mcp"], env: { BUS_IDENTITY: "be" } } } };
    writeFileSync(at("repo", ".mcp.json"), JSON.stringify(pin));
    try {
      // Harnesses load the pin into BUS_IDENTITY: treating it as literal
      // would silently migrate every worktree identity (be-stream → be),
      // orphaning its queued mail and claims. Equal to the pin = derived.
      expect(sessionIdentity({ BUS_IDENTITY: "be" }, at("repo", ".wt", "stream"))).toBe("be-stream");
      expect(sessionIdentity({ BUS_IDENTITY: "be" }, at("repo"))).toBe("be");
      // And its lane is the default (the suffix is in the name).
      expect(sessionLane({ BUS_IDENTITY: "be" }, at("repo", ".wt", "stream"))).toBeNull();
    } finally {
      rmSync(at("repo", ".mcp.json"));
    }
  });
  test("a pin keeps the worktree suffix (derived identities unchanged)", () => {
    const pin = { mcpServers: { grayboard: { command: "grayboard", args: ["mcp"], env: { BUS_IDENTITY: "be" } } } };
    writeFileSync(at("repo", ".mcp.json"), JSON.stringify(pin));
    try {
      expect(sessionIdentity({}, at("repo", ".wt", "stream"))).toBe("be-stream");
    } finally {
      rmSync(at("repo", ".mcp.json"));
    }
  });
  test("default plus worktree suffix", () => expect(sessionIdentity({}, at("repo", ".wt", "stream"))).toBe("repo-stream"));
  test("empty BUS_IDENTITY falls back", () => expect(sessionIdentity({ BUS_IDENTITY: "" }, at("repo"))).toBe("repo"));

  test("an EMPTY BUS_IDENTITY falls through to the pin (N3: ?? skipped it)", () => {
    // `BUS_IDENTITY=` is how a caller clears an inherited value; the pin —
    // not the directory name — is what it must fall back to, as master did.
    const pin = { mcpServers: { grayboard: { command: "grayboard", args: ["mcp"], env: { BUS_IDENTITY: "fe" } } } };
    writeFileSync(at("repo", ".mcp.json"), JSON.stringify(pin));
    try {
      expect(sessionIdentity({ BUS_IDENTITY: "" }, at("repo"))).toBe("fe");
      expect(sessionIdentity({ BUS_IDENTITY: "" }, at("repo", ".wt", "stream"))).toBe("fe-stream");
    } finally {
      rmSync(at("repo", ".mcp.json"));
    }
  });

  test("a BUS_IDENTITY equal to the repo's .omp/mcp.json pin is derived: the suffix composes", () => {
    // omp pins per-repo identities in .omp/mcp.json, not .mcp.json; a
    // harness re-delivering THAT pin must be derived too, or every existing
    // omp worktree identity (fe-omp-stream) silently becomes fe-omp on lane
    // stream, orphaning its mail and claims.
    mkdirSync(at("repo", ".omp"), { recursive: true });
    const pin = { mcpServers: { grayboard: { command: "grayboard", args: ["mcp"], env: { BUS_IDENTITY: "fe-omp" } } } };
    writeFileSync(at("repo", ".omp", "mcp.json"), JSON.stringify(pin));
    try {
      expect(sessionIdentity({ BUS_IDENTITY: "fe-omp" }, at("repo", ".wt", "stream"))).toBe("fe-omp-stream");
      // Default naming (no BUS_IDENTITY) stays .mcp.json-or-directory: an omp
      // pin is echo-detection material only, so no assertion here — the
      // directory default wins (the omp-only test below, master's contract).
      // A name no pin source knows is still a true explicit join.
      expect(sessionIdentity({ BUS_IDENTITY: "scratch" }, at("repo", ".wt", "stream"))).toBe("scratch");
    } finally {
      rmSync(at("repo", ".omp"), { recursive: true });
    }
  });

  test("with BOTH pins present, a BUS_IDENTITY matching EITHER pin is derived", () => {
    // README's omp recipe: .mcp.json pins the Claude Code identity (fe),
    // omp's .omp/mcp.json pins its own (fe-omp). omp re-delivers ITS pin as
    // env; comparing against only the first pin (.mcp.json's fe) would call
    // fe-omp explicit, drop the worktree suffix, and orphan fe-omp-stream's
    // mail and claims.
    const pinA = { mcpServers: { grayboard: { command: "grayboard", args: ["mcp"], env: { BUS_IDENTITY: "fe" } } } };
    const pinB = { mcpServers: { grayboard: { command: "grayboard", args: ["mcp"], env: { BUS_IDENTITY: "fe-omp" } } } };
    writeFileSync(at("repo", ".mcp.json"), JSON.stringify(pinA));
    mkdirSync(at("repo", ".omp"), { recursive: true });
    writeFileSync(at("repo", ".omp", "mcp.json"), JSON.stringify(pinB));
    try {
      expect(sessionIdentity({ BUS_IDENTITY: "fe-omp" }, at("repo", ".wt", "stream"))).toBe("fe-omp-stream");
      expect(sessionIdentity({ BUS_IDENTITY: "fe" }, at("repo", ".wt", "stream"))).toBe("fe-stream");
      // Still explicit: a name no pin source knows, or a named lane.
      expect(sessionIdentity({ BUS_IDENTITY: "other" }, at("repo", ".wt", "stream"))).toBe("other");
      expect(sessionIdentity({ BUS_IDENTITY: "fe-omp", BUS_LANE: "x" }, at("repo", ".wt", "stream"))).toBe("fe-omp");
    } finally {
      rmSync(at("repo", ".mcp.json"));
      rmSync(at("repo", ".omp"), { recursive: true });
    }
  });

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
    // omp pins its own identity in .omp/mcp.json (README §Other harnesses)
    // and delivers it as BUS_IDENTITY — an omp session in a worktree must
    // keep the suffix it always had, so comparing against .mcp.json alone
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

  test("a repo with only an omp pin keeps the directory default: echo detection, not default naming", () => {
    // The omp pin participates in isExplicitIdentity only (a BUS_IDENTITY
    // re-delivering it stays derived). Default naming with no BUS_IDENTITY
    // stays .mcp.json alone, as before this PR: a repo that pins only
    // .omp/mcp.json keeps its directory-derived handles (#182 specifies
    // default resolution further).
    const ompPin = { mcpServers: { grayboard: { command: "grayboard", args: ["mcp"], env: { BUS_IDENTITY: "fe" } } } };
    mkdirSync(at("repo", ".omp"), { recursive: true });
    writeFileSync(at("repo", ".omp", "mcp.json"), JSON.stringify(ompPin));
    try {
      expect(sessionIdentity({}, at("repo", "src"))).toBe("repo");
      expect(sessionIdentity({}, at("repo", ".wt", "stream"))).toBe("repo-stream");
    } finally {
      rmSync(at("repo", ".omp"), { recursive: true, force: true });
    }
  });

  test("a user-scope BUS_IDENTITY is one name across worktrees: the collision is loud", () => {
    // No repo pin: an env value from a user-level registration (claude mcp
    // add -e, pi's user mcp.json) is a chosen task name, used verbatim in
    // every worktree. Two worktree sessions then resolve to the same name;
    // the second is refused at startup (identity_in_use / the local refusal),
    // which keeps one live session per name instead of the silent push-loss
    // the suffix used to paper over. #182 specifies an unbound start instead
    // of a refusal; until it lands, the refusal is today's behavior.
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

describe("sessionLane", () => {
  test("BUS_LANE wins", () => {
    expect(sessionLane({ BUS_IDENTITY: "be", BUS_LANE: "research-3" }, at("repo"))).toBe("research-3");
    expect(sessionLane({ BUS_LANE: "Research-3" }, at("repo"))).toBe("research-3");
  });
  test("invalid BUS_LANE fails loudly", () => {
    expect(() => sessionLane({ BUS_LANE: "Bad Lane!" }, at("repo"))).toThrow(/invalid BUS_LANE/);
  });
  test("an explicit identity in a worktree: the worktree name is the implicit lane", () => {
    expect(sessionLane({ BUS_IDENTITY: "be" }, at("repo", ".wt", "stream"))).toBe("stream");
    expect(sessionLane({ BUS_IDENTITY: "be", BUS_LANE: "x" }, at("repo", ".wt", "stream"))).toBe("x");
  });
  test("an explicit identity outside a worktree: no lane of its own", () => {
    expect(sessionLane({ BUS_IDENTITY: "be" }, at("repo"))).toBeNull();
  });
  test("a derived identity carries the suffix in the name; its lane is the default", () => {
    expect(sessionLane({}, at("repo", ".wt", "stream"))).toBeNull();
    expect(sessionLane({}, at("repo"))).toBeNull();
    // A pin re-delivered as BUS_IDENTITY is derived too (see sessionIdentity).
    const pin = { mcpServers: { grayboard: { command: "grayboard", args: ["mcp"], env: { BUS_IDENTITY: "be" } } } };
    writeFileSync(at("repo", ".mcp.json"), JSON.stringify(pin));
    try {
      expect(sessionLane({ BUS_IDENTITY: "be" }, at("repo", ".wt", "stream"))).toBeNull();
    } finally {
      rmSync(at("repo", ".mcp.json"));
    }
  });
});
