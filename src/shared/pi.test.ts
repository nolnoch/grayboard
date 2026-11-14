// piAgentDir follows pi's own rule for PI_CODING_AGENT_DIR (#279 audit 14):
// empty is unset, `~` expands, a file:// URL converts, anything else is as is.
import { expect, test } from "bun:test";
import { piAgentDir } from "./pi.ts";

const HOME = "/home/you";

test("unset or empty is ~/.pi/agent, never the current directory", () => {
  expect(piAgentDir({}, HOME)).toBe("/home/you/.pi/agent");
  expect(piAgentDir({ PI_CODING_AGENT_DIR: "" }, HOME)).toBe("/home/you/.pi/agent");
});

test("a leading ~ expands to the home directory; a file:// URL converts; other paths are kept", () => {
  expect(piAgentDir({ PI_CODING_AGENT_DIR: "~" }, HOME)).toBe(HOME);
  expect(piAgentDir({ PI_CODING_AGENT_DIR: "~/agents/pi" }, HOME)).toBe("/home/you/agents/pi");
  expect(piAgentDir({ PI_CODING_AGENT_DIR: "file:///srv/pi%20agent" }, HOME)).toBe("/srv/pi agent");
  expect(piAgentDir({ PI_CODING_AGENT_DIR: "/srv/pi" }, HOME)).toBe("/srv/pi");
  expect(piAgentDir({ PI_CODING_AGENT_DIR: "~other/pi" }, HOME)).toBe("~other/pi");
});

// The local pi adapter installs as one raw file, so it carries its own copy of
// the rule; with an empty variable it read ./mcp.json and ran a repo's command
// (#437). Imported with the variable aimed at an empty scratch dir, so loading
// it reads no real mcp.json.
test("the local pi adapter's copy resolves every case as piAgentDir does (#437)", async () => {
  const saved = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = "/nonexistent/grayboard-437";
  try {
    const { agentDir } = await import("../../adapters/pi/grayboard.ts");
    for (const value of [undefined, "", "~", "~/agents/pi", "file:///srv/pi%20agent", "/srv/pi", "~other/pi", "relative/pi"]) {
      const env = value === undefined ? {} : { PI_CODING_AGENT_DIR: value };
      expect(agentDir(env, HOME)).toBe(piAgentDir(env, HOME));
    }
    expect(agentDir({ PI_CODING_AGENT_DIR: "" }, HOME)).toBe("/home/you/.pi/agent");
  } finally {
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved;
  }
});
