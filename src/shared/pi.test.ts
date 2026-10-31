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
