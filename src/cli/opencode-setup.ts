import { lstatSync, statSync, readFileSync, writeFileSync, renameSync, unlinkSync, linkSync, symlinkSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { applyEdits, modify, parseTree, getNodeValue, findNodeAtLocation, createScanner, SyntaxKind, type Node, type ParseError } from "jsonc-parser";
import { isValidIdentityName } from "../shared/addressing.ts";

type ObjectValue = Record<string, any>;
const object = (v: unknown): v is ObjectValue => !!v && typeof v === "object" && !Array.isArray(v);
const scopes = "grayboard:tools grayboard:delivery";
const backupSuffix = ".grayboard-backup";

function fail(message: string): never {
  throw new Error(`${message}. Resolve manually before configuring OpenCode; no configuration contents were printed`);
}

function info(path: string) {
  try { return lstatSync(path); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

function document(path: string): { text: string; value: ObjectValue; mode: number } {
  const st = info(path);
  if (!st) return { text: "", value: {}, mode: 0o600 };
  if (!st.isFile() || st.isSymbolicLink()) fail("Config must be a regular file, not a symlink");
  const text = readFileSync(path, "utf8");
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length || !tree || tree.type !== "object") fail("Invalid JSON/JSONC config object");
  const unique = (node: Node) => {
    if (node.type === "object") {
      const keys = new Set<string>();
      for (const prop of node.children ?? []) {
        const key = prop.children![0]!.value as string;
        if (keys.has(key)) fail("Duplicate JSON/JSONC property");
        keys.add(key);
      }
    }
    for (const child of node.children ?? []) unique(child);
  };
  unique(tree);
  const value = JSON.parse(JSON.stringify(getNodeValue(tree)));
  shape(value);
  return { text, value, mode: st.mode & 0o777 };
}

function shape(cfg: ObjectValue): void {
  if (cfg.mcp !== undefined && !object(cfg.mcp)) fail("mcp must be an object");
  if (cfg.mcp?.servers !== undefined && !object(cfg.mcp.servers)) fail("mcp.servers must be an object");
  for (const key of ["plugins", "plugin"]) {
    if (cfg[key] !== undefined && (!Array.isArray(cfg[key]) || !cfg[key].every((entry: unknown) =>
      typeof entry === "string" ||
      (object(entry) && typeof entry.package === "string" && (entry.options === undefined || object(entry.options))) ||
      (key === "plugin" && Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && object(entry[1]))))) fail(`${key} must be a valid plugin array`);
  }
}

function removeOwnedProperty(text: string, path: string[]): string {
  const tree = parseTree(text);
  if (!tree) fail("Cannot locate configuration object");
  const prop = findNodeAtLocation(tree, path)?.parent;
  if (!prop || prop.type !== "property") fail("Cannot locate owned configuration property");
  const siblings = prop.parent!.children!;
  const index = siblings.indexOf(prop);
  const start = index > 0 ? siblings[index - 1]!.offset + siblings[index - 1]!.length : prop.offset + prop.length;
  const end = index > 0 ? prop.offset : prop.parent!.offset + prop.parent!.length;
  const scanner = createScanner(text, true);
  scanner.setPosition(start);
  const edits = [{ offset: prop.offset, length: prop.length, content: "" }];
  const token = scanner.scan();
  if (scanner.getTokenOffset() < end && token === SyntaxKind.CommaToken) edits.push({ offset: scanner.getTokenOffset(), length: 1, content: "" });
  // jsonc-parser's property removal also consumes inter-property comments.
  return applyEdits(text, edits);
}

export function hostedEndpoint(raw: string): string {
  if (typeof raw !== "string" || raw.length > 2048 || /[\x00-\x20\x7f\\%]/.test(raw)) fail("Invalid MCP endpoint");
  let u: URL;
  try { u = new URL(raw); } catch { return fail("Invalid MCP endpoint"); }
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(u.hostname);
  if ((u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) ||
      u.username || u.password || u.search || u.hash || raw.includes("?") || raw.includes("#") ||
      !u.pathname.endsWith("/mcp") || u.pathname.includes("//") || u.href !== raw) fail("MCP endpoint must be canonical HTTPS (or HTTP loopback) ending in /mcp, without credentials, query, or fragment");
  return u.href;
}

function identity(value: unknown): value is string {
  return typeof value === "string" && isValidIdentityName(value) && value === value.toLowerCase() && value !== "human";
}

function substitution(value: string): boolean {
  return /\{(?:env|file):/.test(value);
}

function publicClientId(value: unknown): value is string {
  return typeof value === "string" && /^[\x21-\x7e]{1,512}$/.test(value) && !substitution(value);
}

export function isHostedGrayboard(value: unknown): boolean {
  if (object(value) && value.type === "remote" && Object.keys(value).every(k => ["type", "url"].includes(k))) {
    try { hostedEndpoint(value.url); return true; } catch { return false; }
  }
  return isLegacyHostedGrayboard(value);
}

function isLegacyHostedGrayboard(value: unknown): boolean {
  if (!object(value) || value.type !== "remote" || !object(value.headers) || !identity(value.headers["X-Grayboard-Identity"]) ||
      !object(value.oauth) || !publicClientId(value.oauth.client_id) ||
      typeof value.oauth.scope !== "string" ||
      Object.keys(value).some(k => !["type", "url", "headers", "oauth"].includes(k)) ||
      Object.keys(value.headers).some(k => k !== "X-Grayboard-Identity") ||
      Object.keys(value.oauth).some(k => !["client_id", "scope"].includes(k))) return false;
  const requested = value.oauth.scope.split(/\s+/).sort();
  if (!isDeepStrictEqual(requested, scopes.split(" ").sort())) return false;
  try { hostedEndpoint(value.url); return true; } catch { return false; }
}

function sibling(path: string): string {
  return path.endsWith(".jsonc") ? path.slice(0, -1) : path + "c";
}

/** Ordinary setup/update must not replace hosted registrations, including uncertain config. */
export function opencodeShimGuard(directory: string): { skip: boolean; warning?: string } {
  try {
    let hosted = false;
    for (const name of ["opencode.json", "opencode.jsonc"]) {
      const cfg = document(join(directory, name)).value;
      for (const entry of [cfg.mcp?.grayboard, cfg.mcp?.servers?.grayboard]) {
        if (entry === undefined || localEntry(entry, true)) continue;
        if (!isHostedGrayboard(entry)) return { skip: true, warning: "Remote or unrecognized grayboard MCP configuration found; leaving OpenCode unchanged" };
        hosted = true;
      }
    }
    return { skip: hosted, ...(hosted ? { warning: "Hosted OpenCode registration preserved; the CLI push adapter was not installed or refreshed" } : {}) };
  } catch {
    return { skip: true, warning: "OpenCode config is malformed, ambiguous, or symlinked; leaving its registration and adapter unchanged" };
  }
}

function pluginDirectory(path: string): string {
  const directory = resolve(path);
  if (substitution(directory)) fail("Plugin directory must be a literal path without OpenCode substitutions");
  try {
    if (!statSync(directory).isDirectory()) fail("Plugin must be an installed directory");
    const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    if (pkg.name !== "grayboard-opencode") fail("Plugin package must be grayboard-opencode");
    const candidates = ["server.ts", "server.js", "server.mjs", "server.cjs", "index.ts", "index.js", "index.mjs", "index.cjs"];
    const root = realpathSync(directory);
    if (!candidates.some(entry => {
      const target = resolve(directory, entry);
      try { return target.startsWith(directory + "/") && statSync(target).isFile() && realpathSync(target).startsWith(root + "/") && /\.[cm]?[jt]s$/.test(target); } catch { return false; }
    })) fail("Plugin directory has no loadable server/index entry");
  } catch (e) {
    if ((e as Error).message.includes("Resolve manually")) throw e;
    fail("Cannot validate installed plugin directory");
  }
  return directory;
}

function localEntry(entry: unknown, registration = false): boolean {
  if (!object(entry) || entry.type !== "local" || Object.keys(entry).some(k => !["type", "command", "environment", "enabled"].includes(k)) ||
      (entry.enabled !== undefined && typeof entry.enabled !== "boolean") ||
      !Array.isArray(entry.command) || !entry.command.every((x: unknown) => typeof x === "string")) return false;
  const [cmd, ...args] = entry.command as string[];
  if (!cmd) return false;
  let tail: string[];
  if (/^grayboard(?:\.exe)?$/.test(basename(cmd))) tail = args;
  else if (/^bun(?:\.exe)?$/.test(basename(cmd)) && args[0]?.endsWith("/src/cli/main.ts")) tail = args.slice(1);
  else return false;
  if (!(isDeepStrictEqual(tail, ["mcp"]) || isDeepStrictEqual(tail, ["mcp", "--mode", "local"]) || isDeepStrictEqual(tail, ["mcp", "--mode", "server"]))) return false;
  const env = entry.environment;
  return env === undefined || (object(env) && Object.keys(env).every(k =>
    // Ordinary adapter refresh retains its established environment handling; migration stays strict.
    (registration && typeof env[k] === "string") ||
    (k === "BUS_PUSH" && env[k] === "off") || (k === "BUS_IDENTITY" && identity(env[k]))));
}

function packageReference(entry: unknown): string | undefined {
  if (Array.isArray(entry)) return typeof entry[0] === "string" ? entry[0] : undefined;
  return typeof entry === "string" ? entry : object(entry) && typeof entry.package === "string" ? entry.package : undefined;
}

function grayboardPackage(entry: unknown, base: string): boolean {
  const ref = packageReference(entry);
  if (!ref) return false;
  if (/^grayboard-opencode(?:@|$)/.test(ref) || /^github:nolnoch\/grayboard#.+::path:adapters\/opencode-v2$/.test(ref)) return true;
  if (ref.includes("grayboard") && /\.[jt]s$/.test(ref)) fail("Configured Grayboard plugin file requires manual migration");
  if (!isAbsolute(ref) && !ref.startsWith(".") && !ref.startsWith("file:")) return false;
  try {
    const path = ref.startsWith("file:") ? fileURLToPath(ref) : resolve(base, ref);
    return JSON.parse(readFileSync(join(path, "package.json"), "utf8")).name === "grayboard-opencode";
  } catch { return false; }
}

export type OpenCodeSetupOptions = {
  url: string; config: string; revision?: string; plugin?: string; name?: string; create?: boolean;
  migrate?: boolean; dryRun?: boolean;
};

type Move = { path: string; backup: string; source: string };

/** Adapter source is supplied by the CLI's existing build macro, not loaded from a checkout. */
export function setupOpenCode(opts: OpenCodeSetupOptions, expectedAdapterSource: string, beforeReplace?: () => void): { changed: boolean; migrated: boolean; dryRun: boolean } {
  const url = hostedEndpoint(opts.url);
  if (!url.startsWith("https://")) fail("Hosted OpenCode setup requires HTTPS; use the existing local adapter for HTTP/local development");
  if (opts.name !== undefined && !identity(opts.name)) fail("Name must be a lowercase simple agent name, not human or a full handle");
  if (opts.create && !opts.name) fail("--create requires an explicit --name");
  if (opts.plugin && opts.revision) fail("Choose --revision or installed-directory --plugin, not both");
  if (!opts.plugin && !/^[0-9a-f]{40}$/.test(opts.revision ?? "")) fail("Git plugin setup requires --revision with a full lowercase 40-character commit hash; alternatively supply an installed --plugin directory");
  const plugin = opts.plugin ? pluginDirectory(opts.plugin) : `github:nolnoch/grayboard#${opts.revision}::path:adapters/opencode-v2`;
  const path = resolve(opts.config);
  if (![".json", ".jsonc"].includes(extname(path))) fail("Select an explicit JSON or JSONC config file");
  if (!statSync(dirname(path)).isDirectory()) fail("Config parent directory must exist");
  const current = document(path);
  const other = document(sibling(path)).value;
  if (other.mcp?.grayboard !== undefined || other.mcp?.servers?.grayboard !== undefined ||
      [other.plugins, other.plugin].some(list => list?.some((entry: unknown) => grayboardPackage(entry, dirname(path))))) fail("Sibling config defines Grayboard; resolve the selected scope's conflicting files manually");
  const desired = { type: "remote", url };
  const cfg = current.value;
  const old = cfg.mcp?.grayboard;
  const native = cfg.mcp?.servers?.grayboard;
  if (old !== undefined && !localEntry(old)) fail("Unrecognized V1 Grayboard MCP command");
  if (native !== undefined && !isDeepStrictEqual(native, desired) && !localEntry(native) && !isHostedGrayboard(native)) fail("Unrecognized native Grayboard MCP entry");
  const ownedPlugins = (cfg.plugins ?? []).map((entry: unknown, i: number) => grayboardPackage(entry, dirname(path)) ? i : -1).filter((i: number) => i >= 0) as number[];
  if (ownedPlugins.length > 1 || (cfg.plugin ?? []).some((entry: unknown) => grayboardPackage(entry, dirname(path)))) fail("Conflicting Grayboard plugin entries require manual migration");
  const pluginIndex = ownedPlugins[0];
  const priorPlugin = pluginIndex === undefined ? undefined : cfg.plugins[pluginIndex];
  if (object(priorPlugin) && Object.keys(priorPlugin).some(k => !["package", "options"].includes(k))) fail("Unknown Grayboard plugin fields");
  const pluginEntry: ObjectValue = object(priorPlugin) ? { ...priorPlugin, package: plugin } : { package: plugin };
  if (opts.name !== undefined) pluginEntry.options = { ...pluginEntry.options, name: opts.name, create: !!opts.create };
  const moves: Move[] = [];
  const adapterPaths = [join(dirname(path), "plugin", "grayboard.ts")];
  if (basename(dirname(path)) !== ".opencode") adapterPaths.push(join(dirname(path), ".opencode", "plugin", "grayboard.ts"));
  for (const adapter of adapterPaths) {
    const st = info(adapter);
    if (!st) continue;
    if (!st.isFile() && !st.isSymbolicLink()) fail("Unrecognized Grayboard adapter; refusing to move user code");
    let source: string;
    try {
      if (!statSync(adapter).isFile()) fail("Grayboard adapter target must be a regular file");
      source = readFileSync(adapter, "utf8");
    } catch { return fail("Dangling or unreadable Grayboard adapter requires manual migration"); }
    if (source !== expectedAdapterSource) fail("Unrecognized Grayboard adapter; refusing to move user code");
    const backup = adapter + backupSuffix;
    if (info(backup)) fail("Adapter backup already exists");
    moves.push({ path: adapter, backup, source });
  }
  const migration = old !== undefined || (native !== undefined && !isDeepStrictEqual(native, desired)) || moves.length > 0 ||
    (priorPlugin !== undefined && !isDeepStrictEqual(priorPlugin, pluginEntry));
  if (migration && !opts.migrate) fail("Existing Grayboard configuration or adapter requires explicit --migrate");
  let text = current.text || '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
  const set = (keys: (string | number)[], value: unknown) => {
    // Formatting an insertion also reformats adjacent user-owned values.
    text = applyEdits(text, modify(text, keys, value, {}));
  };
  if (old !== undefined) text = removeOwnedProperty(text, ["mcp", "grayboard"]);
  if (!isDeepStrictEqual(native, desired)) set(["mcp", "servers", "grayboard"], desired);
  if (pluginIndex === undefined) {
    if (cfg.plugins === undefined) set(["plugins"], [pluginEntry]);
    else set(["plugins", -1], pluginEntry);
  } else if (!isDeepStrictEqual(priorPlugin, pluginEntry)) {
    // Preserve unrelated option bytes and enrollment.
    if (object(priorPlugin)) {
      if (priorPlugin.package !== plugin) set(["plugins", pluginIndex, "package"], plugin);
      if (opts.name !== undefined) {
        set(["plugins", pluginIndex, "options", "name"], opts.name);
        set(["plugins", pluginIndex, "options", "create"], !!opts.create);
      }
    } else set(["plugins", pluginIndex], pluginEntry);
  }
  const changed = text !== current.text;
  const configBackup = path + backupSuffix;
  if (migration && current.text && changed && info(configBackup)) fail("Config backup already exists");
  if (opts.dryRun || (!changed && !moves.length)) return { changed, migrated: migration, dryRun: !!opts.dryRun };
  // Preflight is complete. Keep the selected file atomic and roll back adapter moves on failure.
  const temp = path + `.grayboard-${process.pid}-${crypto.randomUUID()}.tmp`;
  const moved: Move[] = [];
  let backedUp = false;
  let tempCreated = false;
  try {
    if (document(path).text !== current.text) fail("Config changed during setup");
    if (migration && current.text && changed) {
      writeFileSync(configBackup, current.text, { flag: "wx", mode: current.mode });
      backedUp = true;
    }
    for (const move of moves) {
      if (info(move.backup) || readFileSync(move.path, "utf8") !== move.source) fail("Adapter changed during setup");
      renameSync(move.path, move.backup);
      moved.push(move);
    }
    if (changed) {
      writeFileSync(temp, text, { flag: "wx", mode: current.mode });
      tempCreated = true;
      beforeReplace?.();
      if (document(path).text !== current.text) fail("Config changed during setup");
      renameSync(temp, path);
      tempCreated = false;
    }
  } catch (e) {
    let incomplete = false;
    const recover = (action: () => void) => {
      try { action(); } catch { incomplete = true; }
    };
    if (tempCreated) recover(() => unlinkSync(temp));
    for (const move of moved.reverse()) recover(() => {
      // Both creates are atomic no-replace; never hard-link a symlink's target.
      if (lstatSync(move.backup).isSymbolicLink()) symlinkSync(readlinkSync(move.backup), move.path);
      else linkSync(move.backup, move.path);
      unlinkSync(move.backup);
    });
    // A backup pathname may have been replaced or edited; never delete it on rollback.
    if (backedUp) incomplete = true;
    if (incomplete) {
      const changed = e instanceof Error && e.message.startsWith("Config changed during setup") ? "Config changed during setup. " : "";
      throw new Error(changed + "OpenCode setup failed; manual recovery required. Concurrent entries were preserved and config backups retained; recovery may be incomplete", { cause: e });
    }
    throw e;
  }
  return { changed, migrated: migration, dryRun: false };
}
