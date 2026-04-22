#!/usr/bin/env bun
import { Command } from "commander";
import { writeFileSync, mkdirSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { runOAuthFlow } from "./oauth_flow.ts";
import { makeClient, makeUnauthClient, loadCredentials, ApiError, type Credentials } from "./api.ts";
import pkg from "../../package.json" with { type: "json" };

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
    console.error(`Error (${e.code}): ${e.message}`);
  } else {
    console.error(String(e));
  }
  process.exit(1);
}

// ── plugin path resolution ────────────────────────────────────────────────────

type PluginInvocation = { command: string; args: string[] };

function findPluginCommand(): PluginInvocation {
  // 1. explicit override (env var) — accepts either a .ts source path or a binary path
  const override = process.env.GRAYBOARD_PLUGIN_PATH;
  if (override) {
    return override.endsWith(".ts")
      ? { command: "bun", args: [override] }
      : { command: override, args: [] };
  }

  // 2. compiled sibling binary next to the grayboard CLI (the install.sh case).
  //    Use execPath, not argv[1]: in a `bun build --compile` binary, argv[1] is a
  //    virtual filesystem path (/$bunfs/root/...) while execPath is the actual
  //    on-disk binary location.
  const execDir = dirname(resolve(process.execPath));
  for (const name of ["grayboard-plugin", "grayboard-plugin.exe"]) {
    const candidate = join(execDir, name);
    if (existsSync(candidate)) return { command: resolve(candidate), args: [] };
  }

  // 3. source tree — walk up from the CLI script (argv[1]) looking for
  //    src/plugin/main.ts. In source mode execPath is the bun binary itself, so
  //    argv[1] is what tells us where our script lives.
  if (process.argv[1]) {
    let dir = dirname(resolve(process.argv[1]));
    for (let i = 0; i < 6; i++) {
      const candidate = join(dir, "src", "plugin", "main.ts");
      if (existsSync(candidate)) return { command: "bun", args: [resolve(candidate)] };
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  throw new Error(
    "Cannot locate grayboard-plugin. Install the release binaries (curl …install.sh | bash), or set GRAYBOARD_PLUGIN_PATH to either a compiled grayboard-plugin binary or src/plugin/main.ts.",
  );
}

// ── .mcp.json helpers ─────────────────────────────────────────────────────────

function writeMcpJson(targetPath: string, identityName: string, force: boolean): void {
  let plugin: PluginInvocation;
  try {
    plugin = findPluginCommand();
  } catch (e) {
    console.error(String(e));
    process.exit(1);
  }

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
    const client = makeUnauthClient(serverUrl);

    if (opts.dev) {
      try {
        const res = await client.post("/api/auth/dev-login", { email: opts.dev }) as { session_token: string; user_email: string };
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
  .description("Create an identity")
  .option("--mcp [path]",  "Write .mcp.json entry (default: ./.mcp.json)")
  .option("--force",       "Overwrite entire .mcp.json instead of merging")
  .action(async (name: string, opts: { mcp?: string | boolean; force?: boolean }) => {
    let res: { name: string; created_at: number };
    try {
      res = await makeClient().post("/api/identities", { name }) as typeof res;
    } catch (e) { handleApiError(e); }

    if (globalJson()) {
      output(res!, true);
    } else {
      console.log(`Created identity '${res!.name}'`);
    }

    if (opts.mcp !== undefined) {
      const mcpPath = opts.mcp === true ? "./.mcp.json" : (opts.mcp as string);
      writeMcpJson(mcpPath, name.toLowerCase(), opts.force ?? false);
    }
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
  .description("Create a team (you are auto-added as a member)")
  .action(async (name: string) => {
    try { output(await makeClient().post("/api/teams", { name }), globalJson()); }
    catch (e) { handleApiError(e); }
  });

teamCmd
  .command("join <name>")
  .description("Join a team")
  .action(async (name: string) => {
    try { output(await makeClient().post(`/api/teams/${name}/join`), globalJson()); }
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
  .description("Admin commands (v1: any authenticated user; all actions are logged)");

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
