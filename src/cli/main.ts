#!/usr/bin/env bun
// The `grayboard` entry. Claude Code runs `grayboard hook claude <event>` on
// every grayboard tool call (#551), so that path loads only the record module:
// in a compiled binary every static import evaluates before argv is read, and
// the CLI's import graph costs 0.24-0.31 s a start. Every other command is
// cli.ts, loaded on demand.
import { runHook } from "../shared/claude_agents.ts";
import { sockDir } from "../shared/sockdir.ts";

if (process.argv[2] === "hook" && process.argv[3] === "claude") {
  // Locally a child ends with its root (#548), so SubagentStop writes no marker.
  runHook(process.argv[4] ?? "", await Bun.stdin.text(), { base: sockDir(), env: process.env, ended: false });
} else {
  await import("./cli.ts");
}
