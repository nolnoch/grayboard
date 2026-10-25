import { describe, expect, test } from "bun:test";
import { detectHarness, defaultComms, commsRank, isCommsMechanism } from "./harness.ts";

describe("harness detection", () => {
  test("an explicit BUS_HARNESS overrides every marker", () => {
    expect(detectHarness({ BUS_HARNESS: "my-weird-setup", CLAUDECODE: "1" })).toBe("my-weird-setup");
  });

  test("each harness's documented marker is detected", () => {
    expect(detectHarness({ CLAUDECODE: "1" })).toBe("claude-code");
    expect(detectHarness({ OPENCODE_CONFIG: "/x/opencode.json" })).toBe("opencode");
    expect(detectHarness({ OPENCODE_CONFIG_DIR: "/x" })).toBe("opencode");
    expect(detectHarness({ PI_CODING_AGENT_DIR: "/home/u/.pi/agent" })).toBe("pi");
    expect(detectHarness({ CURSOR_AGENT_WORKER_ID: "w1" })).toBe("cursor");
  });

  test("an unrecognized environment reports null, never a guess", () => {
    expect(detectHarness({})).toBe(null);
    expect(detectHarness({ PATH: "/usr/bin" })).toBe(null);
  });

  test("an empty BUS_HARNESS does not shadow detection", () => {
    expect(detectHarness({ BUS_HARNESS: "  ", CLAUDECODE: "1" })).toBe("claude-code");
  });
});

describe("comms mechanism", () => {
  test("known harnesses default to native; the unknown default is the relay floor", () => {
    expect(defaultComms("claude-code", {})).toBe("native");
    expect(defaultComms("pi", {})).toBe("native");
    expect(defaultComms("opencode", {})).toBe("native");
    // Cursor's in-editor default is relay (its SDK/fabric path is opt-in).
    expect(defaultComms("cursor", {})).toBe("relay");
    expect(defaultComms(null, {})).toBe("relay");
    expect(defaultComms("something-new", {})).toBe("relay");
  });

  test("BUS_COMMS overrides the default, and only with a valid value", () => {
    expect(defaultComms("cursor", { BUS_COMMS: "fabric" })).toBe("fabric");
    expect(defaultComms("claude-code", { BUS_COMMS: "relay" })).toBe("relay");
    // An invalid override falls back to the harness default, not the junk.
    expect(defaultComms("pi", { BUS_COMMS: "telepathy" })).toBe("native");
  });

  test("the rank orders native over fabric over anything else", () => {
    expect(commsRank("native")).toBeGreaterThan(commsRank("fabric"));
    expect(commsRank("fabric")).toBeGreaterThan(commsRank("relay"));
    expect(commsRank("relay")).toBe(commsRank(null));
    expect(commsRank("garbage")).toBe(commsRank("relay"));
  });

  test("isCommsMechanism accepts exactly the three mechanisms", () => {
    expect(isCommsMechanism("native")).toBe(true);
    expect(isCommsMechanism("fabric")).toBe(true);
    expect(isCommsMechanism("relay")).toBe(true);
    expect(isCommsMechanism("native ")).toBe(false);
    expect(isCommsMechanism("Native")).toBe(false);
    expect(isCommsMechanism(1)).toBe(false);
    expect(isCommsMechanism(undefined)).toBe(false);
  });
});
