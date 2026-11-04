#!/usr/bin/env bun
// The `grayboard` entry. Claude Code runs `grayboard hook claude <event>` on
// every grayboard tool call (#551), so that path loads only lightweight record
// and identity-control modules:
// in a compiled binary every static import evaluates before argv is read, and
// the CLI's import graph costs 0.24-0.31 s a start. Every other command is
// cli.ts, loaded on demand.
import { runHook } from "../shared/claude_agents.ts";
import { sockDir } from "../shared/sockdir.ts";
import { syncIdentity } from "../shared/claude_identity.ts";

if (process.argv[2] === "hook" && process.argv[3] === "claude") {
  // Locally a child ends with its root (#548), so SubagentStop writes no marker,
  // and local mode stores no model or effort, so no facts (#545).
  const event = process.argv[4] ?? "";
  const input = await Bun.stdin.text();
  runHook(event, input, { base: sockDir(), env: process.env, hosted: false });
  try {
    const instructions = await syncIdentity(event, input, sockDir());
    if (instructions.length && (event === "session-start" || event === "pre-tool-use")) {
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: event === "session-start" ? "SessionStart" : "PreToolUse", additionalContext: instructions.join(" ") } }));
    }
  } catch (error) {
    const reason = `grayboard current conversation barrier failed: ${(error as Error).message}`;
    console.error(reason);
    if (event === "pre-tool-use") console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
    process.exitCode = 1;
  }
} else {
  await import("./cli.ts");
}
