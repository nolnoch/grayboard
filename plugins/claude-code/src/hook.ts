// The plugin's hook entry (#551), bundled to dist/hook.js and run by bun from
// hooks/hooks.json: `<event> --data <CLAUDE_PLUGIN_DATA>`, the hook's input on
// stdin. It writes the record that tells the plugin's MCP server which agent
// made a grayboard call, and the root's model and effort (#545)
// (src/shared/claude_agents.ts), and after a grayboard call prints the live
// sign-in link as a systemMessage, the user's line (#500). Exits 0 whatever
// happens, with nothing on stderr: a hook never blocks or alters a call.
import { runHook } from "../../../src/shared/claude_agents.ts";

const [event, flag, data] = process.argv.slice(2);
// An unexpanded `${CLAUDE_PLUGIN_DATA}` falls back to the environment's.
const base = flag === "--data" && data && !data.startsWith("${") ? data : process.env.CLAUDE_PLUGIN_DATA;
const out = event && base ? runHook(event, await Bun.stdin.text(), { base, env: process.env, hosted: true }) : undefined;
if (out) process.stdout.write(out);
