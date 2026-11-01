// The plugin's one executable, bundled to dist/grayboard.js and run by bun:
//   (no args)                 the stdio MCP server Claude Code starts (plugin.json mcpServers.grayboard)
//   logout --data <dir>       revokes the grant in <dir> (the /grayboard:logout skill, user-only)
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pkg from "../../../package.json" with { type: "json" };
import { Login } from "../../../adapters/hosted-core/src/login.ts";
import { readJson } from "../../../adapters/hosted-core/src/storage.ts";
import { hostFiles } from "../../../src/shared/claude_channels.ts";
import { parentCommandLine } from "../../../src/shared/toolguard.ts";
import { CLIENT_ID, createPlugin, HARNESS, LOGIN_INTERACTIVE } from "./plugin.ts";

const log = (message: string) => { process.stderr.write(`${message}\n`); };

async function logout(args: string[]): Promise<number> {
  const at = args.indexOf("--data");
  const dataDir = at >= 0 ? args[at + 1] : undefined;
  if (!dataDir) { log("grayboard logout: --data <plugin data dir> is required"); return 2; }
  // The skill's shell carries no server URL, so every grant this plugin holds
  // signs out: each store names its own server.
  let names: string[];
  try { names = readdirSync(join(dataDir, "grants")).filter(n => /^[0-9a-f]{64}\.json$/.test(n)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; names = []; }
  const servers = new Set<string>();
  const unreadable: string[] = [];
  for (const name of names) {
    // An unreadable grant file is a failure, not "not signed in": the user would believe they were signed out.
    let store: { resource?: unknown; clientId?: unknown } | undefined;
    try { store = await readJson(join(dataDir, "grants", name)) as typeof store; }
    catch (error) { unreadable.push(`${name}: ${(error as Error).message}`); continue; }
    if (typeof store?.resource === "string" && store.clientId === CLIENT_ID) servers.add(store.resource);
  }
  if (unreadable.length) { log(`grayboard logout: couldn't read ${unreadable.join("; ")}; nothing was signed out`); return 1; }
  if (!servers.size) { console.log("Not signed in to grayboard; nothing to sign out of."); return 0; }
  let failed = false;
  for (const resource of servers) {
    const warnings: string[] = [];
    const login = new Login({
      resource, clientId: CLIENT_ID, stateDir: dataDir, harness: HARNESS, loginAction: LOGIN_INTERACTIVE,
      present: () => {}, notify: () => {},
      diagnostic: record => { if (record.state === "degraded" || record.state === "paused") warnings.push(record.message); },
    });
    const pauses = `every Claude Code session on ${new URL(resource).origin} pauses until it signs in again`;
    try {
      await login.logout();
      console.log(warnings.length ? `${warnings.join("; ")}; ${pauses}` : `Signed out of grayboard; ${pauses}`);
    } catch (error) {
      failed = true;
      log(`grayboard logout from ${new URL(resource).origin} failed: ${(error as Error).message}`);
    }
  }
  return failed ? 1 : 0;
}

async function serve(): Promise<void> {
  const plugin = createPlugin({ env: process.env, parentCmd: parentCommandLine(), files: hostFiles(), version: pkg.version, cwd: process.cwd(), log });
  let exiting = false;
  const exit = async () => {
    if (exiting) return;
    exiting = true;
    await plugin.shutdown();
    process.exit(0);
  };
  // stdin EOF is how Claude Code ends a stdio server; SIGTERM if it outlives that.
  process.stdin.on("end", () => void exit());
  process.on("SIGTERM", () => void exit());
  process.on("SIGINT", () => void exit());
  const transport = new StdioServerTransport();
  transport.onclose = () => void exit();
  await plugin.connect(transport);
}

const [verb, ...rest] = process.argv.slice(2);
if (verb === "logout") process.exit(await logout(rest));
else if (verb === undefined) await serve();
else { log(`grayboard plugin: unknown command ${verb}; use logout --data <dir>`); process.exit(2); }
