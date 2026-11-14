// The grayboard CLI. Loaded by main.ts (the entry) for every command but a
// hook, so a hook doesn't pay for this module's imports (#551).
import { Command } from "commander";
import { writeFileSync, mkdirSync, readFileSync, existsSync, chmodSync, rmSync, lstatSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename, dirname, resolve } from "node:path";
import { runOAuthFlow } from "./oauth_flow.ts";
import { UPGRADE_REFUSAL } from "../shared/protocol.ts";
import { makeClient, makeUnauthClient, loadCredentials, busMode, credentialsPath, ApiClient, ApiError, signInHint, type Credentials } from "./api.ts";
import { isValidIdentityName } from "../shared/addressing.ts";
import pkg from "../../package.json" with { type: "json" };
import { adapterSource, adapterBundle } from "./adapters.ts" with { type: "macro" };
import { selfUpdate, type UpdateResult } from "./update.ts";
import { setupOpenCode, opencodeShimGuard, type OpenCodeSetupOptions } from "./opencode-setup.ts";
import { claudeCli, claudeLaunch, hasUserEntry, installClaudePlugin, pluginCommands, pluginEnabled, pluginVersions, printable, projectEntryWarnings, refreshClaudeHooks, refreshClaudePlugin, registerClaudeLocal, type PluginReport } from "./claude-setup.ts";
import { canonicalEndpoint } from "../shared/endpoint.ts";
import { piAgentDir } from "../shared/pi.ts";
import { Login } from "../../adapters/hosted-core/src/login.ts";
import { hostedConfigPath, type HostedConfig } from "../../adapters/hosted-core/src/config.ts";

function writeCredentials(creds: Credentials): void {
  const file = credentialsPath();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(creds, null, 2), { mode: 0o600 });
  // The mode above applies only to a new file; an existing one keeps its own (#88).
  chmodSync(file, 0o600);
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
const PI_DIR  = piAgentDir();

// Adapter files carry this binary's source (inlined at build time), so
// `update` rewrites them from the new binary.
// The opencode and local pi and omp adapters serve grayboard's tools
// themselves and read their command from the harness's grayboard MCP entry,
// so that entry is kept disabled (else the harness registers the tools
// twice), with BUS_PUSH=off so a re-enabled one never adds a second delivery
// owner.
type Entry = Record<string, unknown>;
// `local`: the entry as local mode keeps it.
type HarnessConfig = { path: string; section: "mcp" | "mcpServers"; local: (e: Entry) => Entry };
const pushOff = (e: Entry, key: string) => ({ ...(e[key] as Record<string, string> | undefined), BUS_PUSH: "off" });
const OC_CONFIG: HarnessConfig = {
  path: join(OC_DIR, "opencode.json"),
  section: "mcp",
  local: e => ({ ...e, enabled: false, environment: pushOff(e, "environment") }),
};
const OC_PLUGIN = { path: join(OC_DIR, "plugin", "grayboard.ts"), source: adapterSource("opencode") };

// pi and omp have two adapters each, one per mode. Server: the hosted
// extension (`.js`, a bundle of adapters/pi-family) talks to the server's
// /mcp itself, holds the delivery lease, and reads only
// `<agentDir>/grayboard/config.json {url}`; it needs no entry. Local: the
// adapter (pi's raw `.ts`, omp's bundle in the same `.ts` slot) runs a
// push-mode `grayboard mcp`, serves its tools and
// delivers its pushes, reading its command from the disabled user entry; omp's
// also runs each in-process subagent's calls as a child session (#523).
// Installing one variant removes the other. In omp the disabled user entry
// still shadows a repo's same-named .mcp.json entry, so it carries no
// BUS_IDENTITY: grayboard reads the repo's pin itself.
type PiFamily = {
  name: "pi" | "omp";
  clientId: string;
  config: HarnessConfig;
  stateDir: string;
  local: string;
  hosted: string;
  hostedConfig: string;
  source: string;
  bundle: string;
};
const piFamily = (name: "pi" | "omp", dir: string, f: Pick<PiFamily, "source" | "bundle">): PiFamily => ({
  name, clientId: `grayboard-${name}`, stateDir: join(dir, "grayboard"),
  // `exposure` is pi's, for its own MCP client, which doesn't run the entry.
  config: { path: join(dir, "mcp.json"), section: "mcpServers", local: ({ exposure: _, ...e }) => ({ ...e, enabled: false, env: pushOff(e, "env") }) },
  local: join(dir, "extensions", "grayboard.ts"), hosted: join(dir, "extensions", "grayboard.js"), hostedConfig: hostedConfigPath(join(dir, "grayboard")),
  source: f.source, bundle: f.bundle,
});
const PI = piFamily("pi", PI_DIR, { source: adapterSource("pi"), bundle: adapterBundle("pi") });
const OMP = piFamily("omp", OMP_DIR, { source: adapterBundle("omp", "local"), bundle: adapterBundle("omp") });

/** The hosted MCP endpoint of a server URL, as the server names its OAuth resource. */
const hostedMcpUrl = (server: string) => new URL(server.replace(/\/+$/, "") + "/mcp").href;

type FamilyInstall = { adapter: string; notes: string[] };
/**
 * Install the harness's adapter for the mode: `server` set → the hosted
 * extension; else the local adapter, with `entry` as the entry's command (or
 * the existing entry kept in its local shape). Leaving a hosted install's
 * server (local mode, or another server) signs the harness out of it first,
 * revoking its grant. Returns the adapter's path and what else changed.
 * Throws, before any file changes, on a server URL the hosted extension would
 * refuse or an unparseable mcp.json or config.json; throws after the entry
 * check if the sign-out does (its grant store's lock), leaving the install
 * as it was.
 */
async function installPiFamily(h: PiFamily, server: string | undefined, entry?: Entry): Promise<FamilyInstall> {
  const notes: string[] = [];
  let url: string | undefined;
  if (server) {
    // The extension refuses to load with any other URL, and the harness may
    // then exit at startup. The URL isn't echoed: it may hold credentials.
    try { url = canonicalEndpoint(hostedMcpUrl(server))?.href; } catch {}
    if (!url) throw new Error(`${h.name}'s hosted extension needs a canonical HTTPS (or loopback HTTP) server URL, without credentials, query or fragment, so nothing was changed for ${h.name}`);
  }
  // The entry next: an unparseable mcp.json throws before any file changes.
  const existing = readConfig<Record<string, Record<string, Entry> | undefined>>(h.config.path, {})[h.config.section]?.grayboard;
  // `?.`: the file may hold JSON null.
  const old = readConfig<{ url?: unknown }>(h.hostedConfig, {})?.url;
  if (typeof old === "string" && old !== url) {
    const note = await signOutPiFamily(h, old);
    if (note) notes.push(note);
  }
  if (url) {
    if (dropEntry(h.config)) notes.push(`Removed the grayboard entry from ${h.config.path} (the hosted extension needs none)`);
    writeAdapter(h.hosted, h.bundle);
    rmSync(h.local, { force: true });
    writeConfig(h.hostedConfig, { url } satisfies HostedConfig);
    notes.push(`Wrote ${h.hostedConfig}`);
    return { adapter: h.hosted, notes };
  }
  // The local adapter reads its command from the entry, so one that's missing
  // (a server-mode install removed it, or the user did) is recreated with
  // this binary's command.
  const next = entry ?? (existing ? undefined : mcpCommand());
  if (putEntry(h.config, next)) {
    notes.push(next ? `Registered in ${h.config.path} (disabled: the extension serves the tools)` : `Disabled the grayboard entry in ${h.config.path} (the adapter serves the tools)`);
  }
  writeAdapter(h.local, h.source);
  rmSync(h.hosted, { force: true });
  if (typeof old === "string") {
    rmSync(h.hostedConfig, { force: true });
    notes.push(`Removed ${h.hostedConfig}`);
  }
  return { adapter: h.local, notes };
}

/**
 * Sign the harness's hosted extension out of `resource`, as its /grayboard
 * logout does: revoke the grant and bump the store's epoch, so running
 * sessions pause with the login notice. Dropping the extension otherwise
 * leaves its refresh token on disk, still able to mint access tokens.
 * Returns a note, or undefined when the harness holds nothing for `resource`.
 */
async function signOutPiFamily(h: PiFamily, resource: string): Promise<string | undefined> {
  let queued: string | undefined;
  let login: Login;
  try {
    login = new Login({ resource, clientId: h.clientId, stateDir: h.stateDir, harness: h.name, loginAction: "run /grayboard login",
      present: () => {}, notify: () => {}, diagnostic: r => { if (r.code === "revoke_queued") queued = r.message; } });
  } catch { return undefined; } // not canonical: the extension never loaded with it, so never signed in
  const s = await login.read();
  if (!s?.refresh && !s?.revoke?.length) return undefined;
  await login.logout();
  if (queued === undefined) return `Signed ${h.name} out of ${login.resource} and revoked its grant`;
  const cause = /\(([^()]*)\)$/.exec(queued)?.[1] ?? queued;
  return `Signed ${h.name} out of ${login.resource}; revoking its grant failed and stays queued for its next login there (${cause})`;
}

function writeAdapter(path: string, source: string): void {
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true }); // replace, never write through, an existing symlink
  writeFileSync(path, source);
}

/** A harness's JSON config, or `empty` when the file doesn't exist. Throws when it can't be parsed. */
function readConfig<T extends object>(path: string, empty: T): T {
  if (!existsSync(path)) return empty;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch (e) {
    throw new Error(`Can't parse ${path}: ${(e as Error).message}`);
  }
}

function writeConfig(path: string, cfg: object): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
}

/** Write `entry` (or reshape the existing one by `c.local`) as the harness's grayboard entry; true when the file changed. */
function putEntry(c: HarnessConfig, entry?: Entry): boolean {
  const cfg = readConfig<Record<string, Record<string, Entry> | undefined>>(c.path, {});
  const old = cfg[c.section]?.grayboard;
  const base = entry ?? old;
  if (!base) return false;
  const next = c.local(base);
  if (JSON.stringify(next) === JSON.stringify(old)) return false;
  cfg[c.section] = { ...cfg[c.section], grayboard: next };
  writeConfig(c.path, cfg);
  return true;
}

/** Delete the harness's grayboard entry; true when the file changed. */
function dropEntry(c: HarnessConfig): boolean {
  const cfg = readConfig<Record<string, Record<string, Entry> | undefined>>(c.path, {});
  if (!cfg[c.section]?.grayboard) return false;
  const { grayboard: _, ...rest } = cfg[c.section]!;
  cfg[c.section] = rest;
  writeConfig(c.path, cfg);
  return true;
}

// ── MCP server command ────────────────────────────────────────────────────────

type McpInvocation = { command: string; args: string[] };

/** How Claude Code should start grayboard's MCP server: this CLI, `mcp` subcommand. */
function mcpCommand(): McpInvocation {
  // In a `bun build --compile` binary, execPath is the binary itself; from
  // source it's bun, and the entry is main.ts beside this module.
  if (!/^bun(\.exe)?$/.test(basename(process.execPath))) {
    return { command: resolve(process.execPath), args: ["mcp"] };
  }
  return { command: "bun", args: [join(import.meta.dir, "main.ts"), "mcp"] };
}

// ── .mcp.json helpers ─────────────────────────────────────────────────────────

function writeMcpJson(targetPath: string, identityName: string, force: boolean): void {
  const plugin = mcpCommand();
  const entry = {
    command: plugin.command,
    args:    plugin.args,
    env:     { BUS_IDENTITY: identityName },
  };
  // A pin is a suggestion: sessions start unbound and bind it by choice (#182).
  const wrote = (verb: string) => console.log(
    `${verb} ${targetPath}: "${identityName}" is pinned as this checkout's default. ` +
    `Sessions start unbound and list it first; set BUS_IDENTITY in the launch command to bind at start.`,
  );

  if (force) {
    const old = existsSync(targetPath) ? JSON.parse(readFileSync(targetPath, "utf8")) : null;
    if (old?.mcpServers) {
      const keys = Object.keys(old.mcpServers).filter(k => k !== "grayboard");
      if (keys.length > 0) {
        console.warn(`Warning: --force is clobbering mcpServers keys: ${keys.join(", ")}`);
      }
    }
    writeFileSync(targetPath, JSON.stringify({ mcpServers: { grayboard: entry } }, null, 2) + "\n");
    wrote("Wrote");
    return;
  }

  // Merge mode
  if (!existsSync(targetPath)) {
    writeFileSync(targetPath, JSON.stringify({ mcpServers: { grayboard: entry } }, null, 2) + "\n");
    wrote("Created");
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
  wrote("Updated");
}

// ── program ───────────────────────────────────────────────────────────────────

const program = new Command();
program
  .name("grayboard")
  .description("Grayboard CLI — manage identities, teams, and sessions")
  .option("--json", "output JSON")
  .option("--as <handle>", "Act as this handle (literal, no worktree suffix) instead of the one this directory's session uses")
  .version(pkg.version);

const globalJson = () => !!(program.opts() as { json?: boolean }).json;
const globalAs = () => (program.opts() as { as?: string }).as;

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
    // Local credentials go regardless; what the server did decides the message.
    let outcome = "Logged out. The server closed this sign-in's open MCP connections.";
    const creds = loadCredentials();
    const server = process.env.GRAYBOARD_SERVER ?? creds?.server;
    try {
      // A file that's corrupt, already signed out or names no server has no
      // sign-in to revoke; it's still cleared below (#87).
      if (!server || !creds?.session_token) outcome = "No valid sign-in was stored; the local credentials file is cleared.";
      else await makeClient().post("/api/auth/logout");
    } catch (e) {
      outcome = e instanceof ApiError
        ? e.status === 401
          ? "Local credentials removed. The server already refuses this sign-in."
          : `Local credentials removed, but the server answered ${e.status} (${e.message}): this sign-in may still be valid there.`
        : "Local credentials removed, but the server could not be reached: this sign-in stays valid there until it is revoked.";
    }
    const file = credentialsPath();
    if (existsSync(file)) {
      writeFileSync(file, "");
      chmodSync(file, 0o600);
    }
    console.log(outcome);
  });

program
  .command("whoami")
  .description("Show the handle this shell acts as; in server mode, also your user and identities")
  .action(async () => {
    const { actingName, busHandle } = await import("./claim.ts");
    let acting;
    try {
      const { name, source, held } = await actingName(globalAs());
      // A session holding several aliases acts as the first (#284 S6).
      acting = { handle: busHandle(name), source, ...(held && held.length > 1 ? { held } : {}) };
    } catch (e) { console.error(`[grayboard] whoami: ${(e as Error).message}`); process.exit(1); }
    if (busMode() === "local") {
      const also = acting.held ? `; that session also holds ${acting.held.slice(1).join(", ")}` : "";
      output(globalJson() ? acting : `${acting.handle} (from ${acting.source}${also})`, globalJson());
      return;
    }
    try {
      const res = await makeClient().get("/api/whoami") as Record<string, unknown>;
      output({ ...acting, ...res }, globalJson());
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

// ── claims ───────────────────────────────────────────────────────────────────

program
  .command("claims")
  .description("List active claims held by other sessions; exits 2 if any match, for merge or deploy hooks (--json for JSON)")
  .option("--prefix <prefix>", "Only claims whose key starts with this, e.g. dev:")
  .option("--include-self", "Count this session's own claims too")
  .action(async (opts: { prefix?: string; includeSelf?: boolean }) => {
    const { runClaims } = await import("./claims.ts");
    process.exitCode = await runClaims({ ...opts, json: globalJson(), as: globalAs() });
  });

// ── retention (the local bus) ────────────────────────────────────────────────

program
  .command("retention [setting]")
  .description("Show or store how long the local bus keeps history: off, a whole number of days, or default. Outranks BUS_RETENTION_DAYS in every session")
  .action(async (setting: string | undefined) => {
    const { runRetention } = await import("./retention.ts");
    process.exitCode = runRetention(setting, { json: globalJson() });
  });

// ── claim (both modes) ───────────────────────────────────────────────────────

const claimCmd = program.command("claim").description("Take, release or watch a claim as this directory's session (see whoami; --as overrides)");

claimCmd
  .command("take <key>")
  .description("Take or renew a claim; exits 2 if someone else holds it")
  .option("--ttl <duration>", "How long, like 45m, 2h or 3d (default 30m, max 7d)")
  .option("--until <time>", "ISO 8601 stop time instead of --ttl")
  .option("--note <text>", "What you're doing with it")
  .option("--board <board>", "Board to announce it on")
  .action(async (key: string, opts: { ttl?: string; until?: string; note?: string; board?: string }) => {
    const { runClaimTool } = await import("./claim.ts");
    let ttl_minutes: number | undefined;
    if (opts.ttl !== undefined) {
      const { parseTtl } = await import("../shared/ttl.ts");
      try { ttl_minutes = parseTtl(opts.ttl) / 60_000; } catch (e) { console.error(`[grayboard] claim take: ${(e as Error).message}`); process.exit(1); }
    }
    process.exitCode = await runClaimTool("claim_take", { key, ttl_minutes, until: opts.until, note: opts.note, board: opts.board }, { as: globalAs(), json: globalJson() });
  });

claimCmd
  .command("release <key>")
  .description("Release a claim you hold")
  .option("--note <text>", "How it ended")
  .action(async (key: string, opts: { note?: string }) => {
    const { runClaimTool } = await import("./claim.ts");
    process.exitCode = await runClaimTool("claim_release", { key, note: opts.note }, { as: globalAs(), json: globalJson() });
  });

claimCmd
  .command("watch <key>")
  .description("Have this directory's session @mentioned when someone else's claim changes; returns at once")
  .option("--off", "Stop watching")
  .action(async (key: string, opts: { off?: boolean }) => {
    const { runClaimTool } = await import("./claim.ts");
    process.exitCode = await runClaimTool("claim_watch", { key, off: opts.off }, { as: globalAs(), json: globalJson() });
  });

// ── human (local mode) ───────────────────────────────────────────────────────

// These commands act on the local bus whether or not the machine is signed in to a server, as
// `grayboard mcp` does (#282 A1); on a server, your human is `grayboard slack link`.
function requireLocalBus(mode: string | undefined): void {
  if (mode !== undefined && mode !== "local") {
    console.error(`[grayboard] --mode must be local, not "${mode}"`);
    process.exit(1);
  }
}

async function humanCommand(run: (m: typeof import("../local/human.ts")) => void | Promise<void>): Promise<void> {
  // Imported lazily: opening the local bus creates ~/.claude-bus.
  const m = await import("../local/human.ts");
  const { CoreError } = await import("../core/errors.ts");
  try {
    await run(m);
  } catch (e) {
    if (!(e instanceof CoreError)) throw e;
    console.error(`[grayboard] ${e.message}`);
    process.exit(1);
  }
}

program
  .command("human [handle]")
  .description("Show the local human handle, or declare yours (agent sessions can't use it; announce and the Slack bridge speak as it)")
  .option("--mode <mode>", "local: the local bus on a machine signed in to a server")
  .action(async (handle: string | undefined, opts: { mode?: string }) => {
    requireLocalBus(opts.mode);
    await humanCommand((m) => m.runHuman(handle));
  });

program
  .command("announce <text...>")
  .description("Post to #announce as your human handle; it reaches every live agent session with your authority")
  .option("--ttl <duration>", "Also show it to sessions that start within this time, e.g. 45m, 2h, 3d (default: live sessions only)")
  .option("--mode <mode>", "local: the local bus on a machine signed in to a server")
  .action(async (text: string[], opts: { ttl?: string; mode?: string }) => {
    requireLocalBus(opts.mode);
    await humanCommand((m) => m.runAnnounce(text.join(" "), opts.ttl));
  });

const boardCmd = program.command("board").description("Boards, as your human handle");

boardCmd
  .command("create <name> <purpose...>")
  .description("Create a board as your human handle (agents create theirs with board_create)")
  .option("--mode <mode>", "local: the local bus on a machine signed in to a server")
  .action(async (name: string, purpose: string[], opts: { mode?: string }) => {
    requireLocalBus(opts.mode);
    await humanCommand((m) => m.runBoardCreate(name, purpose.join(" ")));
  });

// ── bridge (opt-in) ──────────────────────────────────────────────────────────

const bridgeCmd = program
  .command("bridge")
  .description("Relay a human's handle to a chat app, so agents can reach you on your phone");

bridgeCmd
  .command("slack")
  .description("Relay your handle to a private Slack channel (config: ~/.grayboard/slack.json; setup: https://github.com/nolnoch/grayboard/blob/master/docs/guide/slack.md#slack-bridge-setup)")
  .option("--mode <mode>", "local: relay the local bus on a machine signed in to a server")
  .action(async (opts: { mode?: string }) => {
    if (opts.mode !== undefined && opts.mode !== "local") {
      console.error(`[grayboard] the Slack bridge runs in local mode only; --mode must be local, not "${opts.mode}"`);
      process.exit(1);
    }
    // Imported lazily: nothing Slack loads unless you run this.
    const { runSlackBridge } = await import("../bridge/slack.ts");
    await runSlackBridge(mcpCommand(), opts.mode);
  });

// ── slack (server mode) ──────────────────────────────────────────────────────

const slackCmd = program
  .command("slack")
  .description("Reach your agents from a DM with your server's grayboard Slack app, as \"human\"");

slackCmd
  .command("link")
  .description("Get a one-time code to send to the grayboard app in Slack")
  .action(async () => {
    let res: { code: string; expires_in_s: number; linked: boolean };
    try { res = await makeClient().post("/api/slack/link") as typeof res; }
    catch (e) { handleApiError(e); }
    if (globalJson()) return output(res!, true);
    console.log(`In Slack, open a DM with the grayboard app and send:\n\n  link ${res!.code}\n\nThe code works once, for ${Math.round(res!.expires_in_s / 60)} minutes.${res!.linked ? " You're already linked; this moves the link to the Slack account that sends it." : ""}`);
  });

slackCmd
  .command("unlink")
  .description("Stop relaying to Slack; your agents' messages to \"human\" no longer reach you there")
  .action(async () => {
    try { output(await makeClient().post("/api/slack/unlink"), globalJson()); }
    catch (e) { handleApiError(e); }
  });

// ── mcp / setup ──────────────────────────────────────────────────────────────

// The refusal a `--mode server` gets: the WebSocket transport it dialed is gone (#282).
function refuseServerMode(mode: string | undefined): void {
  if (mode === "server") {
    console.error(`[grayboard] ${UPGRADE_REFUSAL}`);
    process.exit(1);
  }
  if (mode !== undefined && mode !== "local") {
    console.error(`[grayboard] --mode must be local, not "${mode}"`);
    process.exit(1);
  }
}

// Local on every machine: a signed-in user's local entries keep working, and a
// distributed bus is reached through the hosted MCP entry (#282).
program
  .command("mcp")
  .description("Run the local-bus MCP server")
  .option("--mode <mode>", "local (the only mode; server is served by the hosted MCP entry)")
  .action(async (opts: { mode?: string }) => {
    refuseServerMode(opts.mode);
    (await import("../local/launch.ts")).launch.modePinned = opts.mode === "local";
    // stdout is the MCP transport from here on; log to stderr only.
    try {
      await import("../local/mcp.ts");
    } catch (e) {
      console.error(`[grayboard] ${(e as Error).message}`);
      process.exit(1);
    }
  });

// The adapters that serve grayboard's tools themselves (pi, opencode; #182
// decision 13) register them from this list at load. It's what `mcp` would
// serve, and printing it opens no bus and no connection.
program
  .command("tools", { hidden: true })
  .description("Print the tools `grayboard mcp` serves, as JSON")
  .option("--mode <mode>", "local, as for mcp")
  .action(async (opts: { mode?: string }) => {
    refuseServerMode(opts.mode);
    console.log(JSON.stringify((await import("../local/tools.ts")).LOCAL_TOOLS));
  });

program
  .command("setup-opencode")
  .description("Configure an explicitly selected OpenCode V2 hosted MCP scope; no login or package installation")
  .requiredOption("--url <endpoint>", "Hosted MCP endpoint ending in /mcp")
  .option("--revision <sha>", "Full Git commit hash for the default Git/subdirectory plugin source")
  .option("--plugin <directory>", "Fallback: installed grayboard-opencode directory instead of Git")
  .option("--name <name>", "Optional startup mailbox binding; does not enroll delivery")
  .option("--create", "Explicitly allow creating the configured name (default false)")
  .option("--launcher", "Declare this OpenCode root a delegation launcher (plugin option launcher: true)")
  .option("--no-launcher", "Remove the launcher declaration; omit both to keep what is configured")
  .requiredOption("--config <path>", "Selected OpenCode JSON/JSONC file")
  .option("--migrate", "Explicitly migrate recognized Grayboard entries and back up owned adapters")
  .option("--dry-run", "Validate and report targeted changes without filesystem writes")
  .action((opts: OpenCodeSetupOptions) => {
    try {
      const result = setupOpenCode(opts, OC_PLUGIN.source);
      const config = result.changed ? (result.dryRun ? "config changes required" : "config changes applied") : "config unchanged";
      const adapters = result.adapters ? `; ${result.adapters} carried adapter${result.adapters === 1 ? "" : "s"} ${result.dryRun ? "to disable" : "disabled"}` : "";
      const migration = result.migrated ? (result.dryRun ? "; recognized migration required" : "; recognized migration") : "";
      console.log(`${result.dryRun ? "Dry run:" : "Configured:"} native mcp.servers.${result.mcpName ?? "grayboard"} and plugin source (${config})${adapters}${migration}${result.launcher ? `; launcher ${result.launcher}` : ""}.`);
      for (const path of result.backups ?? []) console.log(`Retained backup: ${path}`);
      console.log("Sign-in PENDING: open OpenCode /mcps, select grayboard, and sign in. No connection was verified; OpenCode owns OAuth and refresh.");
      console.log("Only the selected config and its sibling were checked; ancestor, managed, or other scope overrides remain possible. The plugin revalidates effective configuration.");
    } catch (e) {
      console.error(`[grayboard] ${(e as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("setup")
  .description("Choose local or team-server mode and register grayboard with Claude Code, omp, opencode, and pi")
  .option("--local", "Agents talk on this machine only")
  .option("--server <url>", "Agents talk through this team server")
  .option("--no-register", "Don't register grayboard with Claude Code, omp, opencode, or pi")
  .option("-y, --yes", "Accept the defaults without asking")
  .action(async (opts: { local?: boolean; server?: string; register: boolean; yes?: boolean }) => {
    const interactive = !opts.yes && !!process.stdin.isTTY;
    // Blocking reads from fd 0: Bun's stream stdin fails with EINVAL (kqueue) on macOS when stdin is /dev/tty, as in install.sh.
    const question = (q: string): string => {
      process.stdout.write(q);
      const buf = Buffer.alloc(1);
      const bytes: number[] = [];
      for (;;) {
        let n = 0;
        try { n = readSync(0, buf, 0, 1, null); } catch (e) {
          // A non-blocking fd 0 would otherwise spin a core while the user types.
          if ((e as NodeJS.ErrnoException).code === "EAGAIN") { Bun.sleepSync(20); continue; }
          throw e;
        }
        if (n === 0) throw new Error("stdin closed before setup finished");
        // Decode the whole line at once so multi-byte UTF-8 characters survive.
        if (buf[0] === 0x0a) return Buffer.from(bytes).toString("utf8");
        bytes.push(buf[0]!);
      }
    };
    const ask = async (q: string, dflt = ""): Promise<string> => {
      if (!interactive) return dflt;
      const a = question(dflt ? `${q} [${dflt}] ` : `${q} `).trim() || dflt;
      return a || ask(q, dflt);
    };
    const confirm = async (q: string, dflt: boolean): Promise<boolean> => {
      if (!interactive) return dflt;
      const a = question(`${q} [${dflt ? "Y/n" : "y/N"}] `).trim();
      return a ? /^y/i.test(a) : dflt;
    };

    const creds = loadCredentials();

    // 1. Mode
    let server = opts.server;
    if (!opts.local && !server) {
      const signedIn = busMode() === "server";
      if (interactive) console.log("How will your agents talk?\n  1) On this machine only (no account needed)\n  2) Through a team server");
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

    // 2. Claude Code, for every project (user scope). Local: the `grayboard
    // mcp` entry. Server: the hosted plugin, which needs no grayboard process.
    const { command, args } = mcpCommand();
    const claude = Bun.which("claude");
    if (opts.register && claude && (await confirm("Make grayboard available in every Claude Code project?", true))) {
      try {
        const run = claudeCli(claude);
        const notes = server ? installClaudePlugin(run, server) : registerClaudeLocal(run, command, args);
        for (const note of notes) console.log(note);
      } catch (e) { console.error(`[grayboard] ${(e as Error).message}`); process.exit(1); }
    } else if (opts.register && !claude) {
      let cmds: string[][];
      try { cmds = server ? pluginCommands(server) : [["mcp", "add", "--scope", "user", "grayboard", "--", command, ...args]]; } catch (e) { console.error(`[grayboard] ${(e as Error).message}`); process.exit(1); }
      console.log(`\nClaude Code's \`claude\` command wasn't found. Once it's installed, run:\n  ${printable(cmds)}`);
    }

    // 3. omp and 5. pi share one installer (installPiFamily): register for
    // every project (they ignore Claude Code's user registration) and install
    // the adapter for the mode. One that fails changed nothing for its
    // harness; the others still install, and setup exits 1.
    let failed = false;
    const installHarness = async (h: PiFamily) => {
      let r: FamilyInstall;
      try { r = await installPiFamily(h, server, { command, args }); } catch (e) {
        console.error((e as Error).message);
        failed = true;
        process.exitCode = 1;
        return;
      }
      for (const note of r.notes) console.log(note);
      console.log(`Installed ${r.adapter}`);
      if (server) console.log(`Run /grayboard login in ${h.name} to sign it in.`);
    };
    // 3. omp. Local: the bundled adapter runs grayboard, serves its tools and
    // delivers pushes to main. Server: the hosted extension against /mcp.
    const omp = !!Bun.which("omp");
    if (opts.register && omp && (await confirm("Make grayboard available in every omp project?", true))) await installHarness(OMP);

    // 4. opencode: it drops MCP notifications, so the plugin runs one
    // grayboard process, serves its tools and delivers its pushes; the
    // entry, disabled, is the plugin's config. opencode merges opencode.json
    // and opencode.jsonc, so this leaves a commented .jsonc alone.
    // A team server is reached only through opencode's hosted MCP entry (#282): the
    // `grayboard mcp` entry this step writes would run the local bus, so server mode skips it.
    const opencode = !!Bun.which("opencode");
    if (opts.register && opencode && server) {
      console.log(opencodeHostedHint(server));
    }
    const ocGuard = opts.register && opencode && !server ? opencodeShimGuard(OC_DIR) : { skip: false };
    if (ocGuard.warning) console.warn(`[grayboard] ${ocGuard.warning}`);
    // The prompt can wait indefinitely: classify again after it, so a hosted migration finished meanwhile never gains a second delivery owner.
    const ocRecheck = () => {
      const guard = opencodeShimGuard(OC_DIR);
      if (guard.skip && guard.warning) console.warn(`[grayboard] ${guard.warning}`);
      return !guard.skip;
    };
    if (opts.register && opencode && !server && !ocGuard.skip && (await confirm("Make grayboard available in every opencode project?", true)) && ocRecheck()) {
      if (!existsSync(OC_CONFIG.path)) writeConfig(OC_CONFIG.path, { $schema: "https://opencode.ai/config.json" });
      try { putEntry(OC_CONFIG, { type: "local", command: [command, ...args] }); } catch (e) { console.error((e as Error).message); process.exit(1); }
      writeAdapter(OC_PLUGIN.path, OC_PLUGIN.source);
      console.log(`Registered in ${OC_CONFIG.path} (disabled: the plugin serves the tools); installed ${OC_PLUGIN.path}`);
    }

    // 5. pi. Local: its MCP client drops notifications and, for direct
    // tools, the server's instructions, so like opencode the extension serves
    // the tools, runs the push side and supplies the instructions. Server: the
    // hosted extension does all of that against the server's /mcp itself.
    const piCli = !!Bun.which("pi");
    if (opts.register && piCli && (await confirm("Make grayboard available in every pi project?", true))) await installHarness(PI);

    for (const w of undeliveredEntries()) console.warn(`[grayboard] ${w}`);
    if (failed) return;
    const others = [omp && "omp", opencode && "opencode", piCli && "pi"].filter(Boolean).join(" or ");
    console.log(
      `\nDone. Start Claude Code with:\n  ${claudeLaunch(!!server)}\n` +
      (others ? `or ${others} as usual.\n\n` : `\n`) +
      `Each session starts unbound and binds a name with bind once it knows its task.` +
      // The hosted adapters don't send the repo's name as a suggestion yet;
      // Claude Code's plugin and pi/omp's extension read BUS_IDENTITY (#443),
      // hosted OpenCode takes its start name from setup-opencode --name.
      (server ? "" : ` The repo's name (in ~/code/api, "api") is suggested first.`) +
      ` To bind a name at start, set BUS_IDENTITY in the launch command${server && opencode ? " (OpenCode: grayboard setup-opencode --name)" : ""}.`,
    );
  });

/**
 * omp, opencode and pi drop MCP notifications, so their grayboard entry must
 * stay disabled with BUS_PUSH=off and an adapter must deliver (#95). An
 * enabled push-mode entry with no adapter of either variant runs a delivery
 * owner whose pushes go nowhere: messages are consumed unseen while senders
 * see delivered_now. Returns one warning per such harness.
 */
function undeliveredEntries(): string[] {
  const out: string[] = [];
  const present = (p: string) => { try { lstatSync(p); return true; } catch { return false; } };
  const harnesses: { name: string; config: HarnessConfig; env: string; adapters: string[] }[] = [
    { name: "omp", config: OMP.config, env: "env", adapters: [OMP.local, OMP.hosted] },
    { name: "opencode", config: OC_CONFIG, env: "environment", adapters: [OC_PLUGIN.path] },
    { name: "pi", config: PI.config, env: "env", adapters: [PI.local, PI.hosted] },
  ];
  for (const h of harnesses) {
    let e: Entry | undefined;
    try { e = readConfig<Record<string, Record<string, Entry> | undefined>>(h.config.path, {})?.[h.config.section]?.grayboard; } catch { continue; }
    // A remote entry (hosted opencode) runs no `grayboard mcp`.
    if (!e || typeof e !== "object" || e.enabled === false || e.type === "remote") continue;
    if ((e[h.env] as Record<string, unknown> | undefined)?.BUS_PUSH === "off") continue;
    if (h.adapters.some(present)) continue;
    out.push(`${h.name}: the grayboard entry in ${h.config.path} is enabled with push on, but no grayboard adapter is installed, so ${h.name} drops its pushes and messages to its sessions are consumed unseen. Run \`grayboard setup\` to install the adapter, or remove the entry.`);
  }
  return out;
}

/** A failed adapter refresh step: printed with what to do, and the run fails. */
function adapterFailed(e: unknown): void {
  console.log(`${(e as Error).message}; fix it, then run \`grayboard setup\``);
  process.exitCode = 1;
}

/**
 * Claude Code, local mode: a user-scope `grayboard mcp` entry gets grayboard's
 * hooks, without asking, so a setup that predates one gets it (#551).
 *
 * Claude Code, server mode: a user still on the user-scope `grayboard mcp`
 * entry (setup before the plugin) moves to the hosted plugin; an installed
 * plugin updates to the marketplace's current pin (#443). Either way the pin,
 * the plugin and this grayboard's version are then compared (#511). A failure
 * sets the exit code and is printed. Beside the plugin, a project's grayboard
 * entry runs a second grayboard: checked even when the update failed.
 */
function refreshClaude(): void {
  try {
    if (busMode() !== "server") for (const note of refreshClaudeHooks()) console.log(note);
  } catch (e) { adapterFailed(e); }
  try {
    const claude = Bun.which("claude");
    if (busMode() === "server" && claude) {
      let r: PluginReport;
      if (hasUserEntry()) {
        const server = process.env.GRAYBOARD_SERVER ?? loadCredentials()?.server;
        if (!server) throw new Error("Server mode with no server URL, so Claude Code wasn't moved to the grayboard plugin");
        const installed = installClaudePlugin(claudeCli(claude), server);
        const check = pluginVersions(claudeCli(claude), pkg.version);
        r = { notes: [...installed, ...check.notes], problem: check.problem };
      } else {
        r = refreshClaudePlugin(claudeCli(claude), pkg.version);
      }
      for (const note of r.notes) console.log(note);
      if (r.problem) { console.log(r.problem); process.exitCode = 1; }
    }
  } catch (e) { adapterFailed(e); }
  try {
    if (busMode() === "server" && Bun.which("claude") && pluginEnabled()) for (const w of projectEntryWarnings(process.cwd())) console.log(`[grayboard] ${w}`);
  } catch (e) { adapterFailed(e); }
}

// ── update ───────────────────────────────────────────────────────────────────

program
  .command("update")
  .description("Replace this binary with the latest release, then update the Claude Code plugin to the marketplace's pin")
  .action(async () => {
    let r: UpdateResult;
    try {
      r = await selfUpdate(pkg.version);
    } catch (e) {
      console.error(`[grayboard] update failed: ${(e as Error).message}`);
      process.exit(1);
    }
    if (!r.updated) {
      // The binary is current, so the adapters it carries are too; the
      // Claude Code plugin follows the marketplace's pin, which merges after
      // the release (#511).
      console.log(`grayboard ${pkg.version} is the latest release (${r.origin}).`);
      refreshClaude();
      return;
    }
    console.log(`Updated grayboard ${pkg.version} → ${r.tag} from ${r.origin} (SHA256SUMS signed by key ${r.keyId}). Running sessions keep the old version until reconnected (/mcp → grayboard → reconnect).`);
    // The new binary rewrites the push adapters it carries. 1.0.0 lacks the
    // command; `setup` reinstalls adapters there.
    const refresh = Bun.spawnSync([process.execPath, "refresh-adapters"], { stdout: "inherit", stderr: "inherit" });
    if (refresh.exitCode !== 0) console.log("Some adapters weren't refreshed (above); after fixing that, run `grayboard setup`.");
  });

// The server URL without credentials: printed text never repeats a sign-in URL's user:password.
function withoutCredentials(server: string): string {
  try {
    const u = new URL(server);
    u.username = u.password = "";
    return u.href.replace(/\/+$/, "");
  } catch {
    return server.replace(/\/+$/, "");
  }
}

// A team server is reached only through opencode's hosted MCP entry (#282).
function opencodeHostedHint(server: string | undefined): string {
  return `opencode: a team server is reached through opencode's hosted MCP entry, which setup doesn't write. Run:\n  grayboard setup-opencode --url ${server ? `${withoutCredentials(server)}/mcp` : "<server url>/mcp"} --config <opencode config file> --revision <full git sha>`;
}

program
  .command("refresh-adapters", { hidden: true })
  .description("Rewrite installed omp/opencode/pi push adapters from this binary and update an enabled Claude Code plugin")
  .action(async () => {
    // A symlink means a checkout is installed there on purpose: leave it,
    // and the entry its version expects.
    const installed = (path: string) => existsSync(path) && !lstatSync(path).isSymbolicLink();
    if (installed(OC_PLUGIN.path)) {
      const guard = opencodeShimGuard(OC_DIR);
      if (guard.warning) console.log(`[grayboard] ${guard.warning}`);
      if (!guard.skip) {
        writeAdapter(OC_PLUGIN.path, OC_PLUGIN.source);
        console.log(`Refreshed ${OC_PLUGIN.path}`);
        try {
          if (putEntry(OC_CONFIG)) console.log(`Disabled the grayboard entry in ${OC_CONFIG.path} (the adapter serves the tools)`);
        } catch (e) { adapterFailed(e); }
        // Before #282 this entry served the team server on a signed-in machine; now it runs the local bus (#474).
        // The entry stays (a local opencode bus may be wanted); the user is told how to reach the server.
        // Signed out (a truncated credentials file) names no server and says nothing.
        const server = busMode() === "server" ? process.env.GRAYBOARD_SERVER ?? loadCredentials()?.server : undefined;
        if (server) {
          console.log(`opencode: the grayboard plugin in ${OC_PLUGIN.path} runs this machine's local bus, not the team server you're signed in to (${withoutCredentials(server)}).`);
          console.log(opencodeHostedHint(server));
        }
      }
    }
    // omp and pi: where either variant is installed (and neither is a
    // symlink), install the one the current mode uses.
    let server: string | undefined;
    for (const h of [OMP, PI]) {
      const paths = [h.local, h.hosted].filter(p => existsSync(p));
      if (paths.length === 0 || paths.some(p => lstatSync(p).isSymbolicLink())) continue;
      if (busMode() === "server") {
        server ??= process.env.GRAYBOARD_SERVER ?? loadCredentials()?.server;
        if (!server) { adapterFailed(new Error(`Server mode with no server URL, so ${h.name}'s adapter wasn't refreshed`)); continue; }
      }
      try {
        const r = await installPiFamily(h, server);
        console.log(`Refreshed ${r.adapter}`);
        for (const note of r.notes) console.log(note);
      } catch (e) { adapterFailed(e); }
    }
    for (const w of undeliveredEntries()) console.log(`[grayboard] ${w}`);
    refreshClaude();
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
    // Before anything is created, so a typo'd path isn't an ENOENT after the fact.
    if (mcpPath && !existsSync(dirname(resolve(mcpPath)))) {
      console.error(`--mcp ${mcpPath}: directory ${dirname(resolve(mcpPath))} doesn't exist`);
      process.exit(1);
    }
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

    // Before anything is reserved: the entry `--mcp` writes runs `grayboard mcp`, which joins this machine's
    // local bus, so on a server it would name a session that never reaches the team.
    if (mcpPath) {
      console.error("--mcp writes a `grayboard mcp` entry, which joins this machine's local bus (#282). On a server a session binds its name through the hosted plugin (`grayboard setup`).");
      process.exit(1);
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
  .description("Revoke every session a user has, signing them out everywhere")
  .requiredOption("--email <email>", "Target user email")
  .action(async (opts: { email: string }) => {
    try { output(await makeClient().post("/api/admin/revoke-session", { email: opts.email }), globalJson()); }
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
