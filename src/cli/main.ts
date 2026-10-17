#!/usr/bin/env bun
import { Command } from "commander";
import { writeFileSync, mkdirSync, readFileSync, existsSync, chmodSync, rmSync, lstatSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { join, basename, dirname, resolve } from "node:path";
import { runOAuthFlow } from "./oauth_flow.ts";
import { makeClient, makeUnauthClient, loadCredentials, busMode, credentialsPath, ApiClient, ApiError, signInHint, type Credentials } from "./api.ts";
import { isValidIdentityName } from "../shared/addressing.ts";
import pkg from "../../package.json" with { type: "json" };
import { adapterSource } from "./adapters.ts" with { type: "macro" };
import { selfUpdate } from "./update.ts";

const CREDS_DIR  = join(homedir(), ".grayboard");
const CREDS_FILE = join(CREDS_DIR, "credentials");

function writeCredentials(creds: Credentials): void {
  mkdirSync(CREDS_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

function output(data: unknown, json: boolean): void {
  if (json) { console.log(JSON.stringify(data, null, 2)); return; }
  if (typeof data === "string") { console.log(data); return; }
  console.log(JSON.stringify(data, null, 2));
}

function handleApiError(e: unknown): never {
  if (e instanceof ApiError) {
    const msg = e.status === 401 ? signInHint(process.env.GRAYBOARD_SERVER ?? loadCredentials()?.server) : e.message;
    console.error(`Error (${e.code}): ${msg}`);
  } else {
    console.error(String(e));
  }
  process.exit(1);
}

// ── push adapters (omp, opencode, pi) ─────────────────────────────────────────────

const OMP_DIR = join(homedir(), ".omp", "agent");
const OC_DIR  = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode");
const PI_DIR  = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

// Adapter files carry this binary's source (inlined at build time), so
// `update` rewrites them from the new binary.
const ADAPTERS = [
  { path: join(OMP_DIR, "extensions", "grayboard.ts"), source: adapterSource("omp") },
  { path: join(OC_DIR, "plugin", "grayboard.ts"),      source: adapterSource("opencode") },
  { path: join(PI_DIR, "extensions", "grayboard.ts"),  source: adapterSource("pi") },
];

function writeAdapter(path: string, source: string): void {
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true }); // replace, never write through, an existing symlink
  writeFileSync(path, source);
}

// ── MCP server command ────────────────────────────────────────────────────────

type McpInvocation = { command: string; args: string[] };

/** How Claude Code should start grayboard's MCP server: this CLI, `mcp` subcommand. */
function mcpCommand(): McpInvocation {
  // In a `bun build --compile` binary, execPath is the binary itself; from
  // source it's bun, and import.meta.path is this script.
  if (!/^bun(\.exe)?$/.test(basename(process.execPath))) {
    return { command: resolve(process.execPath), args: ["mcp"] };
  }
  return { command: "bun", args: [import.meta.path, "mcp"] };
}

// ── .mcp.json helpers ─────────────────────────────────────────────────────────

function writeMcpJson(targetPath: string, identityName: string, force: boolean): void {
  const plugin = mcpCommand();
  const entry = {
    command: plugin.command,
    args:    plugin.args,
    env:     { BUS_IDENTITY: identityName },
  };

  if (force) {
    const old = existsSync(targetPath) ? JSON.parse(readFileSync(targetPath, "utf8")) : null;
    if (old?.mcpServers) {
      const keys = Object.keys(old.mcpServers).filter(k => k !== "grayboard");
      if (keys.length > 0) {
        console.warn(`Warning: --force is clobbering mcpServers keys: ${keys.join(", ")}`);
      }
    }
    writeFileSync(targetPath, JSON.stringify({ mcpServers: { grayboard: entry } }, null, 2) + "\n");
    console.log(`Wrote ${targetPath}`);
    return;
  }

  // Merge mode
  if (!existsSync(targetPath)) {
    writeFileSync(targetPath, JSON.stringify({ mcpServers: { grayboard: entry } }, null, 2) + "\n");
    console.log(`Created ${targetPath}`);
    return;
  }

  let existing: { mcpServers?: Record<string, unknown> };
  try {
    existing = JSON.parse(readFileSync(targetPath, "utf8"));
  } catch {
    console.error(`${targetPath} exists but is not valid JSON. Fix it manually or use --force.`);
    process.exit(1);
  }
  if (!existing.mcpServers || typeof existing.mcpServers !== "object") {
    console.error(`${targetPath} has no "mcpServers" object. Fix it manually or use --force.`);
    process.exit(1);
  }
  existing.mcpServers["grayboard"] = entry;
  writeFileSync(targetPath, JSON.stringify(existing, null, 2) + "\n");
  console.log(`Updated ${targetPath}`);
}

// ── program ───────────────────────────────────────────────────────────────────

const program = new Command();
program
  .name("grayboard")
  .description("Grayboard CLI — manage identities, teams, and sessions")
  .option("--json", "output JSON")
  .version(pkg.version);

const globalJson = () => !!(program.opts() as { json?: boolean }).json;

// ── login / logout / whoami ───────────────────────────────────────────────────

async function login(serverUrl: string, devEmail?: string): Promise<void> {
  const client = makeUnauthClient(serverUrl);

  if (devEmail) {
    try {
      const res = await client.post("/api/auth/dev-login", { email: devEmail }) as { session_token: string; user_email: string };
      writeCredentials({ session_token: res.session_token, server: serverUrl, user_email: res.user_email });
      console.log(`Logged in as ${res.user_email} (dev mode)`);
    } catch (e) { handleApiError(e); }
    return;
  }

  // Bootstrap: fetch the public OAuth config from the server. Env vars override
  // for unusual setups (e.g. pointing the loopback flow at a different OAuth app
  // than the server's own).
  let googleClientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  let orgDomain      = process.env.GRAYBOARD_ORG_DOMAIN;
  if (!googleClientId || !orgDomain) {
    try {
      const cfg = await client.get("/api/auth/config") as { google_client_id: string; org_domain: string };
      googleClientId ??= cfg.google_client_id;
      orgDomain      ??= cfg.org_domain;
    } catch (e) {
      handleApiError(e);
    }
  }
  if (!googleClientId) {
    console.error("Server did not return a google_client_id and GOOGLE_OAUTH_CLIENT_ID is not set.");
    process.exit(1);
  }

  let oauthResult;
  try {
    oauthResult = await runOAuthFlow(googleClientId, serverUrl, orgDomain);
  } catch (e) { handleApiError(e); }

  try {
    const res = await client.post("/api/auth/exchange", {
      code:          oauthResult.code,
      code_verifier: oauthResult.codeVerifier,
      redirect_uri:  oauthResult.redirectUri,
    }) as { session_token: string; user_email: string };
    writeCredentials({ session_token: res.session_token, server: serverUrl, user_email: res.user_email });
    console.log(`Logged in as ${res.user_email}`);
  } catch (e) { handleApiError(e); }
}

program
  .command("login")
  .description("Authenticate with Google and store credentials")
  .option("--dev <email>", "Dev-mode login (only works if server has GRAYBOARD_DEV_AUTH=1)")
  .option("--server <url>", "Server URL (or set GRAYBOARD_SERVER env var)")
  .action(async (opts: { dev?: string; server?: string }) => {
    const serverUrl = opts.server ?? process.env.GRAYBOARD_SERVER;
    if (!serverUrl) {
      console.error("Server URL required: use --server <url> or set GRAYBOARD_SERVER");
      process.exit(1);
    }
    await login(serverUrl, opts.dev);
  });

program
  .command("logout")
  .description("Revoke current session and delete local credentials")
  .action(async () => {
    try {
      await makeClient().post("/api/auth/logout");
    } catch {
      // best-effort; remove local creds regardless
    }
    if (existsSync(CREDS_FILE)) {
      writeFileSync(CREDS_FILE, "");
      chmodSync(CREDS_FILE, 0o600);
    }
    console.log("Logged out. Note: active MCP server connections continue until they reconnect.");
  });

program
  .command("whoami")
  .description("Show current user and identities")
  .action(async () => {
    try {
      const res = await makeClient().get("/api/whoami");
      output(res, globalJson());
    } catch (e) { handleApiError(e); }
  });

// ── tail (local mode) ────────────────────────────────────────────────────────

program
  .command("tail <board>")
  .description("Watch a local-mode board live (read-only)")
  .option("-n, --lines <n>", "Recent posts to show first", "10")
  .action(async (board: string, opts: { lines: string }) => {
    // Imported lazily: opening the local bus creates ~/.claude-bus.
    const { runTail } = await import("../local/tail.ts");
    await runTail(board, Number.parseInt(opts.lines, 10) || 0);
  });

// ── bridge (opt-in) ──────────────────────────────────────────────────────────

const bridgeCmd = program
  .command("bridge")
  .description("Relay a human's handle to a chat app, so agents can reach you on your phone");

bridgeCmd
  .command("slack")
  .description("Relay your handle to a private Slack channel (config: ~/.grayboard/slack.json; setup: https://github.com/nolnoch/grayboard#slack-bridge-setup)")
  .action(async () => {
    // Imported lazily: nothing Slack loads unless you run this.
    const { runSlackBridge } = await import("../bridge/slack.ts");
    await runSlackBridge(mcpCommand());
  });

// ── mcp / setup ──────────────────────────────────────────────────────────────

program
  .command("mcp")
  .description("Run the MCP server for Claude Code: server mode when signed in, local otherwise")
  .option("--mode <mode>", "Force local or server mode, e.g. for one repo")
  .action(async (opts: { mode?: string }) => {
    const mode = opts.mode ?? busMode();
    if (mode !== "local" && mode !== "server") {
      console.error(`[grayboard] --mode must be local or server, not "${mode}"`);
      process.exit(1);
    }
    // stdout is the MCP transport from here on; log to stderr only.
    try {
      if (mode === "server") await import("../plugin/mcp.ts");
      else await import("../local/mcp.ts");
    } catch (e) {
      console.error(`[grayboard] ${(e as Error).message}`);
      process.exit(1);
    }
  });

const CHANNELS_FLAG = "--dangerously-load-development-channels server:grayboard";

program
  .command("setup")
  .description("Choose local or team-server mode and register grayboard with Claude Code, omp, opencode, and pi")
  .option("--local", "Agents talk on this machine only")
  .option("--server <url>", "Agents talk through this team server")
  .option("--no-register", "Don't register grayboard with Claude Code, omp, opencode, or pi")
  .option("-y, --yes", "Accept the defaults without asking")
  .action(async (opts: { local?: boolean; server?: string; register: boolean; yes?: boolean }) => {
    const interactive = !opts.yes && !!process.stdin.isTTY;
    const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
    const ask = async (q: string, dflt = ""): Promise<string> => {
      if (!rl) return dflt;
      const a = (await rl.question(dflt ? `${q} [${dflt}] ` : `${q} `)).trim() || dflt;
      return a || ask(q, dflt);
    };
    const confirm = async (q: string, dflt: boolean): Promise<boolean> => {
      if (!rl) return dflt;
      const a = (await rl.question(`${q} [${dflt ? "Y/n" : "y/N"}] `)).trim();
      return a ? /^y/i.test(a) : dflt;
    };

    try {
      const creds = loadCredentials();

      // 1. Mode
      let server = opts.server;
      if (!opts.local && !server) {
        const signedIn = busMode() === "server";
        if (rl) console.log("How will your agents talk?\n  1) On this machine only (no account needed)\n  2) Through a team server");
        const pick = await ask("Choose", signedIn ? "2" : "1");
        if (pick === "2") {
          server = await ask("Server URL:", creds?.server ?? process.env.GRAYBOARD_SERVER);
          if (!server) { console.error("Server URL required: pass --server <url>"); process.exit(1); }
        }
      }

      if (server) {
        if (creds?.session_token && creds.server === server) {
          console.log(`Signed in to ${server} as ${creds.user_email}.`);
        } else {
          await login(server);
        }
      } else if (existsSync(credentialsPath())) {
        const where = creds?.server ? ` from ${creds.server}` : "";
        if (!(await confirm(`Local mode signs you out${where}. Continue?`, true))) process.exit(1);
        if (creds?.session_token) {
          try { await new ApiClient(creds.server, creds.session_token).post("/api/auth/logout"); } catch {}
        }
        rmSync(credentialsPath(), { force: true });
        console.log("Using local mode.");
      } else {
        console.log("Using local mode.");
      }

      // 2. Register with Claude Code, for every project (user scope)
      const { command, args } = mcpCommand();
      const addArgs = ["mcp", "add", "--scope", "user", "grayboard", "--", command, ...args];
      const claude = Bun.which("claude");
      if (opts.register && claude && (await confirm("Make grayboard available in every Claude Code project?", true))) {
        Bun.spawnSync([claude, "mcp", "remove", "--scope", "user", "grayboard"], { stdout: "ignore", stderr: "ignore" });
        const r = Bun.spawnSync([claude, ...addArgs], { stdout: "inherit", stderr: "inherit" });
        if (r.exitCode !== 0) process.exit(r.exitCode ?? 1);
      } else if (opts.register && !claude) {
        console.log(`\nClaude Code's \`claude\` command wasn't found. Once it's installed, run:\n  claude ${addArgs.map(a => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);
      }

      // 3. omp: register for every project (it ignores Claude Code's user
      // registration), and install the push adapter that wakes the session.
      // The user entry outranks a repo's .mcp.json in omp, so it carries no
      // BUS_IDENTITY; grayboard reads the repo's pin itself.
      const omp = !!Bun.which("omp");
      if (opts.register && omp && (await confirm("Make grayboard available in every omp project?", true))) {
        const cfgPath = join(OMP_DIR, "mcp.json");
        let cfg: { mcpServers?: Record<string, unknown> } = {};
        try { cfg = JSON.parse(readFileSync(cfgPath, "utf8")); } catch (e) {
          if (existsSync(cfgPath)) { console.error(`Can't parse ${cfgPath}: ${(e as Error).message}`); process.exit(1); }
        }
        cfg.mcpServers = { ...cfg.mcpServers, grayboard: { command, args } };
        mkdirSync(OMP_DIR, { recursive: true });
        writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
        const ext = ADAPTERS[0]!;
        writeAdapter(ext.path, ext.source);
        console.log(`Registered in ${cfgPath}; installed ${ext.path}`);
      }

      // 4. opencode: it drops MCP notifications, so its entry is tools only
      // (BUS_PUSH=off) and the plugin runs the push side. opencode merges
      // opencode.json and opencode.jsonc, so this leaves a commented .jsonc alone.
      const opencode = !!Bun.which("opencode");
      if (opts.register && opencode && (await confirm("Make grayboard available in every opencode project?", true))) {
        const cfgPath = join(OC_DIR, "opencode.json");
        let cfg: { $schema?: string; mcp?: Record<string, unknown> } = { $schema: "https://opencode.ai/config.json" };
        try { cfg = JSON.parse(readFileSync(cfgPath, "utf8")); } catch (e) {
          if (existsSync(cfgPath)) { console.error(`Can't parse ${cfgPath}: ${(e as Error).message}`); process.exit(1); }
        }
        cfg.mcp = { ...cfg.mcp, grayboard: { type: "local", command: [command, ...args], environment: { BUS_PUSH: "off" } } };
        mkdirSync(OC_DIR, { recursive: true });
        writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
        const plugin = ADAPTERS[1]!;
        writeAdapter(plugin.path, plugin.source);
        console.log(`Registered in ${cfgPath}; installed ${plugin.path}`);
      }

      // 5. pi: its MCP client drops notifications and, for direct tools, the
      // server's instructions, so like opencode its entry is tools only and
      // the extension runs the push side and supplies the instructions.
      const piCli = !!Bun.which("pi");
      if (opts.register && piCli && (await confirm("Make grayboard available in every pi project?", true))) {
        const cfgPath = join(PI_DIR, "mcp.json");
        let cfg: { mcpServers?: Record<string, unknown> } = {};
        try { cfg = JSON.parse(readFileSync(cfgPath, "utf8")); } catch (e) {
          if (existsSync(cfgPath)) { console.error(`Can't parse ${cfgPath}: ${(e as Error).message}`); process.exit(1); }
        }
        cfg.mcpServers = { ...cfg.mcpServers, grayboard: { command, args, env: { BUS_PUSH: "off" }, exposure: "direct" } };
        mkdirSync(PI_DIR, { recursive: true });
        writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
        const ext = ADAPTERS[2]!;
        writeAdapter(ext.path, ext.source);
        console.log(`Registered in ${cfgPath}; installed ${ext.path}`);
      }

      const others = [omp && "omp", opencode && "opencode", piCli && "pi"].filter(Boolean).join(" or ");
      console.log(
        `\nDone. Start Claude Code with:\n  claude ${CHANNELS_FLAG}\n` +
        (others ? `or ${others} as usual.\n\n` : `\n`) +
        `Each session is named after its repo (in ~/code/api you're "api"). ` +
        `To pick a name, set BUS_IDENTITY in that repo's .mcp.json (grayboard identity create <name> --mcp).`,
      );
    } finally {
      rl?.close();
    }
  });

// ── update ───────────────────────────────────────────────────────────────────

program
  .command("update")
  .description("Replace this binary with the latest release")
  .action(async () => {
    let tag: string | null;
    try {
      tag = await selfUpdate(pkg.version);
    } catch (e) {
      console.error(`[grayboard] update failed: ${(e as Error).message}`);
      process.exit(1);
    }
    if (!tag) { console.log(`grayboard ${pkg.version} is the latest release.`); return; }
    console.log(`Updated grayboard ${pkg.version} → ${tag}. Running sessions keep the old version until reconnected (/mcp → grayboard → reconnect).`);
    // The new binary rewrites the push adapters it carries. 1.0.0 lacks the
    // command; `setup` reinstalls adapters there.
    const r = Bun.spawnSync([process.execPath, "refresh-adapters"], { stdout: "inherit", stderr: "ignore" });
    if (r.exitCode !== 0) console.log("If you use omp, opencode, or pi, run `grayboard setup` to refresh their adapters.");
  });

program
  .command("refresh-adapters", { hidden: true })
  .description("Rewrite installed omp/opencode/pi push adapters from this binary")
  .action(() => {
    for (const a of ADAPTERS) {
      // A symlink means a checkout is installed there on purpose: leave it.
      if (!existsSync(a.path) || lstatSync(a.path).isSymbolicLink()) continue;
      writeAdapter(a.path, a.source);
      console.log(`Refreshed ${a.path}`);
    }
  });

// ── identity ─────────────────────────────────────────────────────────────────

const identityCmd = program.command("identity");

identityCmd
  .command("list")
  .description("List your identities")
  .action(async () => {
    try {
      output(await makeClient().get("/api/identities"), globalJson());
    } catch (e) { handleApiError(e); }
  });

identityCmd
  .command("create <name>")
  .description("Create an identity (local mode: nothing to reserve; use with --mcp)")
  .option("--mcp [path]",  "Write .mcp.json entry (default: ./.mcp.json)")
  .option("--force",       "Overwrite entire .mcp.json instead of merging")
  .action(async (name: string, opts: { mcp?: string | boolean; force?: boolean }) => {
    const mcpPath = opts.mcp === undefined ? null : opts.mcp === true ? "./.mcp.json" : opts.mcp;
    if (busMode() === "local") {
      if (!mcpPath) {
        console.error("Local mode has no identities to reserve. Use --mcp to name this repo's sessions.");
        process.exit(1);
      }
      if (!isValidIdentityName(name)) {
        console.error(`Invalid identity "${name}": 1–32 chars, a-z 0-9 _ -`);
        process.exit(1);
      }
      writeMcpJson(mcpPath, name.toLowerCase(), opts.force ?? false);
      return;
    }

    let res: { name: string; created_at: number };
    try {
      res = await makeClient().post("/api/identities", { name }) as typeof res;
    } catch (e) { handleApiError(e); }

    if (globalJson()) {
      output(res!, true);
    } else {
      console.log(`Created identity '${res!.name}'`);
    }

    if (mcpPath) writeMcpJson(mcpPath, name.toLowerCase(), opts.force ?? false);
  });

identityCmd
  .command("rm <name>")
  .description("Delete an identity")
  .action(async (name: string) => {
    try {
      output(await makeClient().del(`/api/identities/${name}`), globalJson());
    } catch (e) { handleApiError(e); }
  });

// ── team ─────────────────────────────────────────────────────────────────────

const teamCmd = program.command("team");

teamCmd
  .command("list")
  .description("List teams you belong to")
  .action(async () => {
    try { output(await makeClient().get("/api/teams"), globalJson()); }
    catch (e) { handleApiError(e); }
  });

teamCmd
  .command("create <name>")
  .description("Create a team (you are auto-added as a member; teams are invite-only)")
  .action(async (name: string) => {
    try { output(await makeClient().post("/api/teams", { name }), globalJson()); }
    catch (e) { handleApiError(e); }
  });

teamCmd
  .command("add <team> <email>")
  .description("Add someone to a team you're in, or any team if you're an admin (they must have signed in once)")
  .action(async (team: string, email: string) => {
    try { output(await makeClient().post(`/api/teams/${team}/add`, { email }), globalJson()); }
    catch (e) { handleApiError(e); }
  });

teamCmd
  .command("remove <team> <email>")
  .description("Remove someone from a team you're in, or any team if you're an admin")
  .action(async (team: string, email: string) => {
    try { output(await makeClient().post(`/api/teams/${team}/remove`, { email }), globalJson()); }
    catch (e) { handleApiError(e); }
  });

teamCmd
  .command("leave <name>")
  .description("Leave a team")
  .action(async (name: string) => {
    try { output(await makeClient().post(`/api/teams/${name}/leave`), globalJson()); }
    catch (e) { handleApiError(e); }
  });

teamCmd
  .command("members <name>")
  .description("List team members")
  .action(async (name: string) => {
    try { output(await makeClient().get(`/api/teams/${name}/members`), globalJson()); }
    catch (e) { handleApiError(e); }
  });

// ── admin ─────────────────────────────────────────────────────────────────────

const adminCmd = program
  .command("admin")
  .description("Admin commands (emails in the server's GRAYBOARD_ADMINS only; all actions are logged)");

adminCmd
  .command("revoke-session")
  .description("Revoke session(s) for a user")
  .requiredOption("--email <email>", "Target user email")
  .option("--all", "Revoke all sessions (default: true for v1)")
  .action(async (opts: { email: string; all?: boolean }) => {
    try { output(await makeClient().post("/api/admin/revoke-session", { email: opts.email, all: true }), globalJson()); }
    catch (e) { handleApiError(e); }
  });

adminCmd
  .command("disable-user")
  .description("Disable a user account")
  .requiredOption("--email <email>", "Target user email")
  .action(async (opts: { email: string }) => {
    try { output(await makeClient().post("/api/admin/disable-user", { email: opts.email }), globalJson()); }
    catch (e) { handleApiError(e); }
  });

adminCmd
  .command("enable-user")
  .description("Re-enable a disabled user account")
  .requiredOption("--email <email>", "Target user email")
  .action(async (opts: { email: string }) => {
    try { output(await makeClient().post("/api/admin/enable-user", { email: opts.email }), globalJson()); }
    catch (e) { handleApiError(e); }
  });

program.parseAsync(process.argv);
