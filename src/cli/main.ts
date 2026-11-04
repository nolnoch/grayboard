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
import type { SessionStartOutput } from "./claude_hooks.ts";

if (process.argv[2] === "hook" && process.argv[3] === "claude") {
  // Locally a child ends with its root (#548), so SubagentStop writes no marker,
  // and local mode stores no model or effort, so no facts (#545).
  const event = process.argv[4] ?? "";
  const input = await Bun.stdin.text();
  try {
    runHook(event, input, { base: sockDir(), env: process.env, hosted: false });
    const instructions = await syncIdentity(event, input, sockDir());
    if (event === "session-start" || event === "pre-tool-use") {
      let title: SessionStartOutput | null = null;
      if (event === "session-start" && ["startup", "resume", "fork"].includes(JSON.parse(input).source)) {
        // A static import would load the full local DB graph on every PreToolUse.
        // Resolve the title only after this SessionStart's rotation acknowledges.
        const { sessionStartOutput } = await import("./claude_hooks.ts");
        title = sessionStartOutput(input);
      }
      if (title || instructions.length) {
        console.log(JSON.stringify({ hookSpecificOutput: {
          hookEventName: event === "session-start" ? "SessionStart" : "PreToolUse",
          ...title?.hookSpecificOutput,
          ...(instructions.length ? { additionalContext: instructions.join(" ") } : {}),
        } }));
      }
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
