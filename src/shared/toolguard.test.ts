import { describe, expect, test } from "bun:test";
import { channelsOff } from "./toolguard.ts";

const CC = { CLAUDECODE: "1" };

describe("channelsOff", () => {
  test("a Claude Code session without a channels flag", () => {
    expect(channelsOff(CC, "claude --resume web")).toBe(true);
    expect(channelsOff(CC, "/home/u/.local/bin/claude")).toBe(true);
  });

  test("a Claude Code session with either channels flag", () => {
    expect(channelsOff(CC, "claude --dangerously-load-development-channels server:grayboard")).toBe(false);
    expect(channelsOff(CC, "claude --model sonnet --dangerously-load-development-channels server:grayboard --resume x")).toBe(false);
    expect(channelsOff(CC, "claude --channels=plugin:foo")).toBe(false);
  });

  test("anything else is not flagged", () => {
    expect(channelsOff({}, "claude")).toBe(false); // not under Claude Code
    expect(channelsOff(CC, "bun /home/u/.bun/bin/omp --model x")).toBe(false); // omp launched from a Claude Code shell
    expect(channelsOff(CC, null)).toBe(false); // parent unreadable
  });
});
