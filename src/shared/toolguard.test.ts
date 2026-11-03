import { describe, expect, test } from "bun:test";
import type { ClaudeFiles } from "./claude_channels.ts";
import { channelsOff, updateNoticeText } from "./toolguard.ts";

const CC = { CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli" };
// A host with no Claude Code account or managed files.
const none: ClaudeFiles = { platform: "linux", home: "/home/u", user: "u", read: () => null, list: () => [], plist: () => null };
const off = (env: Record<string, string>, cmd: string | null) => channelsOff(env, cmd, none);

describe("channelsOff", () => {
  test("a Claude Code session without the dev flag naming server:grayboard", () => {
    expect(off(CC, "claude --resume web")).toContain("claude --dangerously-load-development-channels server:grayboard");
    expect(off(CC, "/home/u/.local/bin/claude")).not.toBeNull();
    expect(off(CC, "claude --channels=plugin:foo")).not.toBeNull();
    expect(off(CC, "claude --channels server:grayboard")).not.toBeNull(); // --channels never loads a server entry
  });

  test("a Claude Code session with the dev flag", () => {
    expect(off(CC, "claude --dangerously-load-development-channels server:grayboard")).toBeNull();
    expect(off(CC, "claude --model sonnet --dangerously-load-development-channels server:grayboard --resume x")).toBeNull();
  });

  test("-p is off even with the dev flag", () => {
    expect(off(CC, "claude -p --dangerously-load-development-channels server:grayboard")).toContain("non-interactive");
    expect(off({ ...CC, CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }, "claude --dangerously-load-development-channels server:grayboard")).not.toBeNull();
  });

  test("anything else is not flagged", () => {
    expect(off({}, "claude")).toBeNull(); // not under Claude Code
    expect(off(CC, "bun /home/u/.bun/bin/omp --model x")).toBeNull(); // omp launched from a Claude Code shell
    expect(off(CC, null)).toBeNull(); // parent unreadable
  });
});

describe("updateNoticeText", () => {
  test("under omp's local adapter it says restart omp, never /mcp reconnect, which would start a second grayboard (#523)", () => {
    const omp = updateNoticeText({ BUS_HARNESS: "omp" });
    expect(omp).toContain("Ask the user to restart omp.");
    expect(omp).not.toContain("/mcp");
    expect(updateNoticeText({})).toContain("reconnect it (/mcp → grayboard → reconnect)");
  });
});
