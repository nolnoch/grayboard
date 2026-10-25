import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "jsonc-parser";
import { hostedEndpoint, isHostedGrayboard, opencodeShimGuard, setupOpenCode, type OpenCodeSetupOptions } from "./opencode-setup.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const source = readFileSync(new URL("../../adapters/opencode/grayboard.ts", import.meta.url), "utf8");
const cli = join(import.meta.dir, "main.ts");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "gb-oc-"));
  roots.push(root);
  const plugin = join(root, "installed-plugin");
  mkdirSync(plugin);
  writeFileSync(join(plugin, "package.json"), JSON.stringify({ name: "grayboard-opencode", main: "index.js" }));
  // Configurator fixture only, not proof of the production plugin's runtime contract.
  writeFileSync(join(plugin, "index.js"), "export default { id: 'grayboard', setup() {} };\n");
  const config = join(root, "opencode.jsonc");
  const opts: OpenCodeSetupOptions = { url: "https://grayboard.example.com/mcp", plugin, config };
  const run = (extra: Partial<OpenCodeSetupOptions> = {}) => setupOpenCode({ ...opts, ...extra }, source);
  const read = () => parse(readFileSync(config, "utf8"));
  const adapter = join(root, "plugin", "grayboard.ts");
  const old = { type: "local", command: ["/usr/local/bin/grayboard", "mcp"], environment: { BUS_PUSH: "off", BUS_IDENTITY: "fe" } };
  const seedAdapter = (contents = source) => { mkdirSync(join(root, "plugin"), { recursive: true }); writeFileSync(adapter, contents); };
  return { root, config, plugin, opts, run, read, adapter, old, seedAdapter };
}

for (const eol of ["\n", "\r\n"]) test(`JSONC preserves unrelated bytes/line endings and second run is exact: ${JSON.stringify(eol)}`, () => {
  const f = fixture();
  const unrelated = '  // keep secret and spacing\n  "model" : "private-token-do-not-print",\n  "identityPin": { "BUS_IDENTITY" : "be" },';
  const server = '      "other" : { "type":"remote", "url":"https://other.example.com/mcp" },';
  const plugin = '    { "package": "other-plugin", "options": { "key" : "keep" } },';
  writeFileSync(f.config, ['{', unrelated, '  "mcp": {', '    "timeout": { "startup": 1234 },', '    "servers": {', server, '    },', '  },', '  "plugins": [', plugin, '  ],', '}', ''].join('\n').replaceAll('\n', eol));
  f.run();
  const text = readFileSync(f.config, "utf8");
  for (const fragment of [unrelated, server, plugin]) expect(text).toContain(fragment.replaceAll('\n', eol));
  if (eol === '\r\n') expect(text.replaceAll('\r\n', '')).not.toContain('\n');
  expect(f.read().mcp.servers.grayboard).toEqual({ type: "remote", url: f.opts.url });
  expect(f.read().plugins[1]).toEqual({ package: f.plugin });
  expect(f.run()).toEqual({ changed: false, migrated: false, dryRun: false });
  expect(readFileSync(f.config, "utf8")).toBe(text);
});

test("new JSON includes schema; dry-run leaves no artifacts", () => {
  const f = fixture();
  const before = readdirSync(f.root).sort();
  expect(f.run({ dryRun: true }).changed).toBe(true);
  expect(readdirSync(f.root).sort()).toEqual(before);
  f.run({ config: f.config.slice(0, -1) });
  expect(parse(readFileSync(f.config.slice(0, -1), "utf8")).$schema).toBe("https://opencode.ai/config.json");
});

for (const text of ["", "[]", "null", '{"mcp":[]}', '{"mcp":{"servers":[]}}', '{"plugins":{}}', '{"plugin":{}}', '{"plugins":[42]}', '{"plugins":[{"package":123}]}', '{"plugins":[{"package":"x","options":false}]}', '{"a":1,"a":2}', '{"mcp":{"servers":{"grayboard":{},"grayboard":{}}}}', '{"x":']) test(`invalid/wrong-shaped/duplicate config refuses: ${text}`, () => {
  const f = fixture();
  writeFileSync(f.config, text);
  expect(() => f.run({ migrate: true })).toThrow();
  expect(readFileSync(f.config, "utf8")).toBe(text);
  expect(readdirSync(f.root).sort()).toEqual(["installed-plugin", "opencode.jsonc"]);
});

for (const url of ["http://remote.example.com/mcp", "https://user:password@example.com/mcp", "https://example.com/mcp?token=secret", "https://example.com/mcp#fragment", "https://example.com/mcp?", "https://example.com/mcp#", "https://example.com//mcp", "https://example.com/a/../mcp", "https://example.com/%2e/mcp", "https://example.com/a\\mcp", "https://example.com/mcp/", "https://EXAMPLE.com/mcp", "https://example.com:443/mcp"]) test(`unsafe/ambiguous endpoint refuses: ${url}`, () => expect(() => hostedEndpoint(url)).toThrow());
for (const url of ["https://grayboard.example.com/team/mcp", "http://127.0.0.1:8080/mcp", "http://localhost:8080/mcp", "http://[::1]:8080/mcp"]) test(`explicit endpoint accepts: ${url}`, () => expect(hostedEndpoint(url)).toBe(url));
for (const name of ["human", "Human", "FE", "you@example.com/fe", "../fe", "", "a".repeat(33)]) test(`invalid name refuses: ${name}`, () => {
  const f = fixture();
  expect(() => f.run({ name })).toThrow();
  expect(existsSync(f.config)).toBe(false);
});
for (const revision of [undefined, "master", "abc123", "a".repeat(39), "A".repeat(40), "{env:REVISION}"]) test("Git source requires explicit full commit hash", () => {
  const f = fixture();
  expect(() => f.run({ plugin: undefined, revision })).toThrow();
  expect(existsSync(f.config)).toBe(false);
});

test("hosted setup refuses HTTP loopback before writes while generic compatibility recognition remains", () => {
  const f = fixture();
  const before = readdirSync(f.root).sort();
  expect(() => f.run({ url: "http://127.0.0.1:8080/mcp" })).toThrow("existing local adapter");
  expect(readdirSync(f.root).sort()).toEqual(before);
  expect(hostedEndpoint("http://127.0.0.1:8080/mcp")).toBe("http://127.0.0.1:8080/mcp");
});

test("installed-directory validation checks package name and direct loadable server/index entry", () => {
  const f = fixture();
  expect(() => f.run({ plugin: join(f.plugin, "index.js") })).toThrow();
  writeFileSync(join(f.plugin, "package.json"), '{"name":"other"}');
  expect(() => f.run()).toThrow();
  writeFileSync(join(f.plugin, "package.json"), '{"name":"grayboard-opencode","main":"../outside.js"}');
  rmSync(join(f.plugin, "index.js"));
  writeFileSync(join(f.root, "outside.js"), "export default {};");
  expect(() => f.run()).toThrow();
  symlinkSync(join(f.root, "outside.js"), join(f.plugin, "index.js"));
  expect(() => f.run()).toThrow();
  expect(existsSync(f.config)).toBe(false);
});

test("selected config symlinks and dangling symlinks refuse without target mutation", () => {
  for (const dangling of [false, true]) {
    const f = fixture();
    const target = join(f.root, "target.json");
    if (!dangling) writeFileSync(target, '{}\n');
    symlinkSync(target, f.config);
    expect(() => f.run({ migrate: true })).toThrow();
    expect(lstatSync(f.config).isSymbolicLink()).toBe(true);
    if (!dangling) expect(readFileSync(target, "utf8")).toBe('{}\n');
  }
});

test("sibling conflict/malformed/symlink config refuses; unrelated sibling stays byte-exact", () => {
  const f = fixture();
  const sibling = f.config.slice(0, -1);
  for (const value of [{ mcp: { grayboard: f.old } }, { mcp: { servers: { grayboard: {} } } }, { plugins: [{ package: f.plugin }] }, { plugin: [['grayboard-opencode@1.10.0', { enrollment: true }]] }]) {
    writeFileSync(sibling, JSON.stringify(value));
    expect(() => f.run({ migrate: true })).toThrow("Sibling");
    expect(existsSync(f.config)).toBe(false);
  }
  writeFileSync(sibling, "invalid");
  expect(() => f.run()).toThrow();
  rmSync(sibling);
  symlinkSync(join(f.root, "missing"), sibling);
  expect(() => f.run()).toThrow();
  rmSync(sibling);
  writeFileSync(sibling, '{ // unrelated\n "model": "other" }');
  f.run();
  expect(readFileSync(sibling, "utf8")).toBe('{ // unrelated\n "model": "other" }');
});

test("recognized V1 and carried adapter require explicit migration, backups, then idempotence", () => {
  const f = fixture();
  const original = '{ // config backup\n "mcp": { "grayboard": ' + JSON.stringify(f.old) + ', "other": { "command":["other"] } }, "plugins": [] }\n';
  writeFileSync(f.config, original);
  f.seedAdapter();
  expect(() => f.run()).toThrow("--migrate");
  expect(readFileSync(f.config, "utf8")).toBe(original);
  expect(readFileSync(f.adapter, "utf8")).toBe(source);
  expect(f.run({ migrate: true }).migrated).toBe(true);
  expect(readFileSync(f.config + ".grayboard-backup", "utf8")).toBe(original);
  expect(readFileSync(f.adapter + ".grayboard-backup", "utf8")).toBe(source);
  expect(existsSync(f.adapter)).toBe(false);
  expect(f.read().mcp.grayboard).toBeUndefined();
  expect(f.read().mcp.other).toEqual({ command: ["other"] });
  expect(f.run().changed).toBe(false);
});

for (const position of ["first", "last", "only", "trailing"]) test(`V1 property removal preserves inter-property comments: ${position}`, () => {
  const f = fixture();
  const own = '"grayboard":' + JSON.stringify(f.old);
  const other = '"other" : {"type":"local","command":["other"]}';
  const content = position === "first" ? `${own}, /* keep next comment */ ${other}` : position === "last" ? `${other}, /* keep previous comment */ ${own}` : position === "trailing" ? `${other}, /* keep previous comment */ ${own}, /* keep trailing comment */` : `/* keep only comment */ ${own}, /* keep trailing comment */`;
  writeFileSync(f.config, `{"mcp":{${content}}}`);
  f.run({ migrate: true });
  const text = readFileSync(f.config, "utf8");
  for (const comment of content.match(/\/\*.*?\*\//g) ?? []) expect(text).toContain(comment);
  if (position !== "only") expect(text).toContain(other);
  expect(f.read().mcp.grayboard).toBeUndefined();
  expect(f.run().changed).toBe(false);
});

test("recognized adapter symlink itself moves, never changing checkout target", () => {
  const f = fixture();
  const target = join(f.root, "checkout-adapter.ts");
  writeFileSync(target, source);
  mkdirSync(join(f.root, "plugin"));
  symlinkSync(target, f.adapter);
  f.run({ migrate: true });
  expect(lstatSync(f.adapter + ".grayboard-backup").isSymbolicLink()).toBe(true);
  expect(readlinkSync(f.adapter + ".grayboard-backup")).toBe(target);
  expect(readFileSync(target, "utf8")).toBe(source);
});

for (const kind of ["custom", "dangling", "custom-link", "backup", "config-backup"]) test(`migration preflight refuses ${kind} without writes`, () => {
  const f = fixture();
  writeFileSync(f.config, JSON.stringify({ mcp: { grayboard: f.old } }));
  f.seedAdapter(kind === "custom" ? "user code" : source);
  if (kind === "dangling" || kind === "custom-link") {
    rmSync(f.adapter);
    const target = join(f.root, "target.ts");
    if (kind === "custom-link") writeFileSync(target, "user code");
    symlinkSync(target, f.adapter);
  }
  if (kind === "backup") writeFileSync(f.adapter + ".grayboard-backup", "existing backup");
  if (kind === "config-backup") writeFileSync(f.config + ".grayboard-backup", "existing backup");
  const before = readFileSync(f.config, "utf8");
  expect(() => f.run({ migrate: true })).toThrow();
  expect(readFileSync(f.config, "utf8")).toBe(before);
  expect(lstatSync(f.adapter)).toBeDefined();
  if (kind === "backup") expect(readFileSync(f.adapter + ".grayboard-backup", "utf8")).toBe("existing backup");
  if (kind === "config-backup") expect(readFileSync(f.config + ".grayboard-backup", "utf8")).toBe("existing backup");
});

test("migration dry-run validates all inputs without creating backups or moving adapter", () => {
  const f = fixture();
  const before = JSON.stringify({ mcp: { grayboard: f.old } });
  writeFileSync(f.config, before);
  f.seedAdapter();
  const result = f.run({ migrate: true, dryRun: true });
  expect(result).toEqual({ changed: true, migrated: true, dryRun: true });
  expect(readFileSync(f.config, "utf8")).toBe(before);
  expect(readFileSync(f.adapter, "utf8")).toBe(source);
  expect(existsSync(f.config + ".grayboard-backup")).toBe(false);
  expect(existsSync(f.adapter + ".grayboard-backup")).toBe(false);
  expect(() => f.run({ migrate: true, name: "human" })).toThrow();
  expect(readFileSync(f.adapter, "utf8")).toBe(source);
});

test("injected replacement failure restores adapter and retains config backup for manual recovery", () => {
  const f = fixture();
  writeFileSync(f.config, JSON.stringify({ mcp: { grayboard: f.old } }));
  const before = readFileSync(f.config, "utf8");
  f.seedAdapter();
  const injected = new Error("injected failure");
  let failure: unknown;
  try { setupOpenCode({ ...f.opts, migrate: true }, source, () => { throw injected; }); } catch (e) { failure = e; }
  expect((failure as Error).cause).toBe(injected);
  expect((failure as Error).message).toContain("manual recovery");
  expect(readFileSync(f.config, "utf8")).toBe(before);
  expect(readFileSync(f.adapter, "utf8")).toBe(source);
  expect(readFileSync(f.config + ".grayboard-backup", "utf8")).toBe(before);
  expect(existsSync(f.adapter + ".grayboard-backup")).toBe(false);
  expect(readdirSync(f.root).some(x => x.endsWith(".tmp"))).toBe(false);
});

for (const replacement of ["file", "edit", "symlink", "directory"]) test(`rollback retains concurrent ${replacement} config backup and concurrent selected config`, () => {
  const f = fixture();
  const original = JSON.stringify({ mcp: { grayboard: f.old } });
  writeFileSync(f.config, original); f.seedAdapter();
  const backup = f.config + ".grayboard-backup", saved = backup + ".saved", target = join(f.root, "user-target");
  const concurrent = '{"concurrent":"selected replacement"}';
  writeFileSync(target, "user backup data");
  let failure: unknown;
  try {
    setupOpenCode({ ...f.opts, migrate: true }, source, () => {
      if (replacement !== "edit") renameSync(backup, saved);
      if (replacement === "symlink") symlinkSync(target, backup);
      else if (replacement === "directory") { mkdirSync(backup); writeFileSync(join(backup, "retained"), "user backup data"); }
      else writeFileSync(backup, "user backup data");
      writeFileSync(f.config, concurrent);
    });
  } catch (e) { failure = e; }
  expect((failure as Error).message).toContain("manual recovery");
  expect(((failure as Error).cause as Error)?.message).toContain("Config changed during setup");
  expect(readFileSync(f.config, "utf8")).toBe(concurrent);
  expect(readFileSync(f.adapter, "utf8")).toBe(source);
  expect(readFileSync(target, "utf8")).toBe("user backup data");
  if (replacement === "symlink") expect(readlinkSync(backup)).toBe(target);
  else expect(readFileSync(replacement === "directory" ? join(backup, "retained") : backup, "utf8")).toBe("user backup data");
  if (replacement !== "edit") expect(readFileSync(saved, "utf8")).toBe(original);
  expect(readdirSync(f.root).some(x => x.endsWith(".tmp"))).toBe(false);
});

test("unrecognized commands and remote secrets refuse migration", () => {
  const f = fixture();
  f.run();
  const desired = f.read().mcp.servers.grayboard;
  for (const entry of [{ type: "local", command: ["custom", "mcp"] }, { ...f.old, command: ["grayboard", "mcp", "--extra"] }, { ...f.old, environment: { CUSTOM_SECRET: "secret" } }, { ...desired, headers: { ...desired.headers, Authorization: "secret" } }, { ...desired, oauth: { ...desired.oauth, client_secret: "secret" } }]) {
    writeFileSync(f.config, JSON.stringify({ mcp: { servers: { grayboard: entry } } }));
    const before = readFileSync(f.config, "utf8");
    expect(() => f.run({ migrate: true })).toThrow("Unrecognized");
    expect(readFileSync(f.config, "utf8")).toBe(before);
  }
});

test("recognized fixed-header profile migrates explicitly to native OAuth defaults", () => {
  const f = fixture();
  const legacy = { type: "remote", url: f.opts.url, headers: { "X-Grayboard-Identity": "fe" }, oauth: { client_id: "operator-public", scope: "grayboard:tools grayboard:delivery" } };
  writeFileSync(f.config, JSON.stringify({ mcp: { servers: { grayboard: legacy } } }));
  expect(isHostedGrayboard(legacy)).toBe(true);
  expect(() => f.run()).toThrow("--migrate");
  f.run({ migrate: true });
  expect(f.read().mcp.servers.grayboard).toEqual({ type: "remote", url: f.opts.url });
  expect(isHostedGrayboard({ ...legacy, oauth: { ...legacy.oauth, scope: "grayboard:tools" } })).toBe(false);
  expect(isHostedGrayboard({ ...legacy, headers: { "X-Grayboard-Identity": "human" } })).toBe(false);
});

test("plugin source migration preserves option bytes/enrollment and unrelated entries", () => {
  const f = fixture();
  const options = '"options" : { "enrollment" : "{env:KEEP}", "unknown" : [1, 2], "file" : "{file:./keep}" }';
  writeFileSync(f.config, '{"plugins": [{"package":"grayboard-opencode@1.10.0", ' + options + '}, "other"]}');
  expect(() => f.run()).toThrow("--migrate");
  f.run({ migrate: true });
  expect(readFileSync(f.config, "utf8")).toContain(options);
  expect(f.read().plugins).toEqual([{ package: f.plugin, options: { enrollment: "{env:KEEP}", unknown: [1, 2], file: "{file:./keep}" } }, "other"]);
  expect(f.run().changed).toBe(false);
});
for (const cfg of [{ plugins: ['grayboard-opencode', 'grayboard-opencode@1.10.0'] }, { plugin: [['grayboard-opencode', {}]] }, { plugins: ['./plugin/grayboard.ts'] }, { plugins: [{ package: 'grayboard-opencode', surprise: true }] }]) test("ambiguous owned plugin entries refuse even migration", () => {
  const f = fixture();
  writeFileSync(f.config, JSON.stringify(cfg));
  expect(() => f.run({ migrate: true })).toThrow();
  expect(readFileSync(f.config, "utf8")).toBe(JSON.stringify(cfg));
});

test("guard allows local/V1 and fails closed on hosted, malformed, ambiguous or symlink configs", () => {
  const f = fixture();
  expect(opencodeShimGuard(f.root).skip).toBe(false);
  writeFileSync(f.config, JSON.stringify({ mcp: { grayboard: f.old } }));
  expect(opencodeShimGuard(f.root).skip).toBe(false);
  for (const text of ['{"mcp":{"servers":{"grayboard":{}}}}', 'broken', '{"mcp":[],"mcp":{}}']) {
    writeFileSync(f.config, text);
    expect(opencodeShimGuard(f.root).skip).toBe(true);
  }
  rmSync(f.config);
  f.run();
  expect(opencodeShimGuard(f.root).skip).toBe(true);
  const cfg = readFileSync(f.config, "utf8");
  rmSync(f.config);
  const target = join(f.root, "target.jsonc");
  writeFileSync(target, cfg);
  symlinkSync(target, f.config);
  expect(opencodeShimGuard(f.root).skip).toBe(true);
});

function invoke(f: ReturnType<typeof fixture>, args: string[]) {
  const env = { ...process.env, HOME: f.root, XDG_CONFIG_HOME: join(f.root, "config"), GRAYBOARD_CREDENTIALS: join(f.root, "credentials"), PI_CODING_AGENT_DIR: join(f.root, "pi"), PATH: join(f.root, "bin"), GRAYBOARD_TOKEN: undefined, GRAYBOARD_SERVER: undefined, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
  return Bun.spawnSync([process.execPath, cli, ...args], { cwd: f.root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
}
function cliArgs(f: ReturnType<typeof fixture>) {
  return ["setup-opencode", "--url", f.opts.url, "--plugin", f.plugin, "--config", f.config];
}
function fakeOpenCode(f: ReturnType<typeof fixture>) {
  mkdirSync(join(f.root, "bin"));
  writeFileSync(join(f.root, "bin", "opencode"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(f.root, "bin", "opencode"), 0o755);
}

for (const credentials of ["", "signed-out-or-private-token\n"]) test("CLI opt-in needs no binaries/login; credential bytes unchanged; dry-run/failure redacted", () => {
  const f = fixture();
  writeFileSync(join(f.root, "credentials"), credentials);
  writeFileSync(f.config, '{ // keep\n "otherSecret": "do-not-print-this" }\n');
  const before = readFileSync(f.config, "utf8");
  const files = readdirSync(f.root).sort();
  const dry = invoke(f, [...cliArgs(f), "--dry-run"]);
  expect(dry.exitCode, dry.stderr.toString()).toBe(0);
  expect(dry.stdout.toString()).toContain("Sign-in PENDING");
  expect(dry.stdout.toString()).not.toContain("do-not-print-this");
  expect(dry.stdout.toString()).not.toContain("client_secret");
  expect(readFileSync(f.config, "utf8")).toBe(before);
  expect(readdirSync(f.root).sort()).toEqual(files);
  const result = invoke(f, cliArgs(f));
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(readFileSync(join(f.root, "credentials"), "utf8")).toBe(credentials);
  for (const name of [".claude", ".omp", "pi"]) expect(existsSync(join(f.root, name))).toBe(false);
  const again = invoke(f, cliArgs(f));
  expect(again.exitCode).toBe(0);
  expect(again.stdout.toString()).toContain("unchanged");
  writeFileSync(f.config, '{"secret":"do-not-print-this",');
  const bad = invoke(f, cliArgs(f));
  expect(bad.exitCode).toBe(1);
  expect(bad.stderr.toString()).not.toContain("do-not-print-this");
});

test("ordinary setup/refresh preserve hosted JSONC, comments, existing adapter and backup", () => {
  const f = fixture();
  const ocDir = join(f.root, "config", "opencode");
  mkdirSync(ocDir, { recursive: true });
  f.opts.config = join(ocDir, "opencode.jsonc");
  writeFileSync(f.opts.config, '{ // hosted comments\n "plugins": [] }\n');
  setupOpenCode(f.opts, source);
  const cfg = readFileSync(f.opts.config, "utf8");
  mkdirSync(join(ocDir, "plugin"));
  const adapter = join(ocDir, "plugin", "grayboard.ts");
  writeFileSync(adapter, "custom existing code");
  writeFileSync(adapter + ".grayboard-backup", source);
  fakeOpenCode(f);
  for (const args of [["setup", "--local", "-y"], ["refresh-adapters"]]) {
    const result = invoke(f, args);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(readFileSync(f.opts.config, "utf8")).toBe(cfg);
    expect(readFileSync(adapter, "utf8")).toBe("custom existing code");
    expect(readFileSync(adapter + ".grayboard-backup", "utf8")).toBe(source);
    expect(existsSync(join(ocDir, "opencode.json"))).toBe(false);
  }
});

for (const legacy of [
  { type: "remote", url: "https://grayboard.example.com/mcp", oauth: { clientId: "operator-public" } },
  { type: "remote", url: "https://grayboard.example.com/mcp", oauth: { clientId: "{env:PRIVATE_TOKEN}" } },
  { type: "remote", url: "https://grayboard.example.com/mcp", oauth: { clientId: "{file:./private-token}" } },
  { type: "local", command: ["custom-grayboard-wrapper", "mcp"] },
]) test("ordinary setup/refresh preserve remote or unknown V1-compatible Grayboard registration", () => {
  const f = fixture();
  const ocDir = join(f.root, "config", "opencode");
  mkdirSync(join(ocDir, "plugin"), { recursive: true });
  const config = join(ocDir, "opencode.json");
  const original = JSON.stringify({ mcp: { grayboard: legacy }, unrelated: "{env:KEEP}" });
  writeFileSync(config, original);
  const adapter = join(ocDir, "plugin", "grayboard.ts");
  writeFileSync(adapter, "user-owned adapter bytes");
  fakeOpenCode(f);
  expect(opencodeShimGuard(ocDir).skip).toBe(true);
  for (const args of [["setup", "--local", "-y"], ["refresh-adapters"]]) {
    const result = invoke(f, args);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(readFileSync(config, "utf8")).toBe(original);
    expect(readFileSync(adapter, "utf8")).toBe("user-owned adapter bytes");
  }
});

test("default Git source needs no client, name, options or installed directory", () => {
  const f = fixture();
  const revision = "a".repeat(40);
  f.run({ plugin: undefined, revision });
  expect(f.read().plugins).toEqual([{ package: `github:nolnoch/grayboard#${revision}::path:adapters/opencode-v2` }]);
  expect(f.read().mcp.servers.grayboard).toEqual({ type: "remote", url: f.opts.url });
  expect(f.run({ plugin: undefined, revision }).changed).toBe(false);
  expect(() => f.run({ revision })).toThrow("not both");
});

test("Git references are owned for sibling/duplicate refusal and explicit revision migration", () => {
  const f = fixture();
  const revision = "a".repeat(40);
  const entry = { package: `github:nolnoch/grayboard#${revision}::path:adapters/opencode-v2` };
  writeFileSync(f.config.slice(0, -1), JSON.stringify({ plugins: [entry] }));
  expect(() => f.run({ plugin: undefined, revision })).toThrow("Sibling");
  rmSync(f.config.slice(0, -1));
  writeFileSync(f.config, JSON.stringify({ plugins: [entry, entry] }));
  expect(() => f.run({ migrate: true })).toThrow("Conflicting");
  writeFileSync(f.config, JSON.stringify({ plugins: [entry] }));
  expect(() => f.run()).toThrow("--migrate");
  f.run({ migrate: true });
  expect(f.read().plugins).toEqual([{ package: f.plugin }]);
});

test("CLI emits the minimal Git/native profile without plugin installation or name", () => {
  const f = fixture();
  const revision = "b".repeat(40);
  const result = invoke(f, ["setup-opencode", "--url", f.opts.url, "--revision", revision, "--config", f.config]);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(f.read().plugins).toEqual([{ package: `github:nolnoch/grayboard#${revision}::path:adapters/opencode-v2` }]);
  expect(f.read().mcp.servers.grayboard).toEqual({ type: "remote", url: f.opts.url });
});

test("optional name explicitly defaults create false and preserves unrelated plugin option bytes", () => {
  const f = fixture();
  expect(() => f.run({ create: true })).toThrow("requires");
  f.run({ name: "fe" });
  expect(f.read().plugins[0].options).toEqual({ name: "fe", create: false });
  expect(() => f.run({ name: "be", create: true })).toThrow("--migrate");
  f.run({ name: "be", create: true, migrate: true });
  expect(f.read().plugins[0].options).toEqual({ name: "be", create: true });
});

for (const directive of ["{env:PRIVATE_TOKEN}", "{file:./private-token}", "prefix-{env:PRIVATE_TOKEN}-suffix", "prefix-{file:./private-token}-suffix"]) test("public client ID and emitted plugin path reject substitutions before writes", () => {
  const f = fixture();
  const before = readdirSync(f.root).sort();
  expect(() => f.run({ plugin: undefined, revision: directive })).toThrow();
  expect(readdirSync(f.root).sort()).toEqual(before);
  const result = invoke(f, [...cliArgs(f), "--revision", directive, "--dry-run"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).not.toContain(directive);
  expect(readdirSync(f.root).sort()).toEqual(before);
  f.run();
  const native = f.read().mcp.servers.grayboard;
  const unsafe = { ...native, oauth: { ...native.oauth, client_id: directive } };
  expect(isHostedGrayboard(unsafe)).toBe(false);
  const original = JSON.stringify({ mcp: { servers: { grayboard: unsafe } } });
  writeFileSync(f.config, original);
  expect(opencodeShimGuard(f.root).skip).toBe(true);
  expect(() => f.run({ migrate: true })).toThrow("Unrecognized");
  expect(readFileSync(f.config, "utf8")).toBe(original);
  expect(existsSync(f.config + ".grayboard-backup")).toBe(false);
  rmSync(f.config);
  const plugin = join(f.root, directive);
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(plugin, "package.json"), '{"name":"grayboard-opencode"}');
  writeFileSync(join(plugin, "index.js"), "export default {};");
  const installed = readdirSync(f.root).sort();
  expect(() => f.run({ plugin })).toThrow();
  const badPlugin = invoke(f, [...cliArgs(f), "--plugin", plugin]);
  expect(badPlugin.exitCode).toBe(1);
  expect(badPlugin.stderr.toString()).not.toContain(plugin);
  expect(readdirSync(f.root).sort()).toEqual(installed);
  expect(existsSync(f.config)).toBe(false);
});

for (const replacement of ["file", "symlink"]) test(`rollback preserves concurrent ${replacement} and owned backup with original cause`, () => {
  const f = fixture();
  const original = JSON.stringify({ mcp: { grayboard: f.old } });
  writeFileSync(f.config, original);
  f.seedAdapter();
  const target = join(f.root, "user-code.ts");
  writeFileSync(target, "concurrent user replacement");
  const injected = new Error("injected failure");
  let failure: unknown;
  try {
    setupOpenCode({ ...f.opts, migrate: true }, source, () => {
      if (replacement === "file") writeFileSync(f.adapter, "concurrent user replacement");
      else symlinkSync(target, f.adapter);
      throw injected;
    });
  } catch (e) { failure = e; }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).cause).toBe(injected);
  expect((failure as Error).message).toContain("manual recovery");
  expect(readFileSync(f.adapter, "utf8")).toBe("concurrent user replacement");
  if (replacement === "symlink") expect(readlinkSync(f.adapter)).toBe(target);
  expect(readFileSync(f.adapter + ".grayboard-backup", "utf8")).toBe(source);
  expect(readFileSync(f.config, "utf8")).toBe(original);
  expect(readFileSync(f.config + ".grayboard-backup", "utf8")).toBe(original);
});

test("temp cleanup failure does not skip restoring any moved adapter and retains config backup", () => {
  const f = fixture();
  const original = JSON.stringify({ mcp: { grayboard: f.old } });
  writeFileSync(f.config, original);
  f.seedAdapter();
  const second = join(f.root, ".opencode", "plugin", "grayboard.ts");
  mkdirSync(join(f.root, ".opencode", "plugin"), { recursive: true });
  const target = join(f.root, "carried.ts");
  writeFileSync(target, source);
  symlinkSync(target, second);
  const injected = new Error("injected failure");
  let failure: unknown;
  try {
    setupOpenCode({ ...f.opts, migrate: true }, source, () => {
      const temp = join(f.root, readdirSync(f.root).find(name => name.endsWith(".tmp"))!);
      rmSync(temp);
      mkdirSync(temp);
      throw injected;
    });
  } catch (e) { failure = e; }
  expect((failure as Error).cause).toBe(injected);
  expect((failure as Error).message).toContain("manual recovery");
  expect(readFileSync(f.adapter, "utf8")).toBe(source);
  expect(lstatSync(second).isSymbolicLink()).toBe(true);
  expect(readlinkSync(second)).toBe(target);
  expect(existsSync(f.adapter + ".grayboard-backup")).toBe(false);
  expect(existsSync(second + ".grayboard-backup")).toBe(false);
  expect(readFileSync(f.config + ".grayboard-backup", "utf8")).toBe(original);
});

test("ordinary registration recognizes retained custom environment without making hosted migration permissive", () => {
  const f = fixture();
  const entry = { ...f.old, enabled: false, environment: { ...f.old.environment, GRAYBOARD_X: "1" } };
  writeFileSync(f.config, JSON.stringify({ mcp: { grayboard: entry } }));
  expect(opencodeShimGuard(f.root)).toEqual({ skip: false });
  expect(() => f.run({ migrate: true })).toThrow("Unrecognized V1");
  expect(f.read().mcp.grayboard).toEqual(entry);
});

for (const enabled of [true, false]) test(`explicit migration recognizes retained enabled=${enabled} registration`, () => {
  const f = fixture();
  writeFileSync(f.config, JSON.stringify({ mcp: { grayboard: { ...f.old, enabled } } }));
  f.run({ migrate: true });
  expect(f.read().mcp.grayboard).toBeUndefined();
  expect(f.read().mcp.servers.grayboard).toEqual({ type: "remote", url: f.opts.url });
});

test("ordinary local/V1 setup and refresh still install carried shim; refresh respects symlinks", () => {
  const f = fixture();
  fakeOpenCode(f);
  const result = invoke(f, ["setup", "--local", "-y"]);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const ocDir = join(f.root, "config", "opencode");
  const adapter = join(ocDir, "plugin", "grayboard.ts");
  expect(readFileSync(adapter, "utf8")).toBe(source);
  expect(JSON.parse(readFileSync(join(ocDir, "opencode.json"), "utf8")).mcp.grayboard.environment).toEqual({ BUS_PUSH: "off" });
  writeFileSync(adapter, "stale adapter");
  expect(invoke(f, ["refresh-adapters"]).exitCode).toBe(0);
  expect(readFileSync(adapter, "utf8")).toBe(source);
  const target = join(f.root, "checkout.ts");
  writeFileSync(target, "intentional checkout");
  rmSync(adapter);
  symlinkSync(target, adapter);
  expect(invoke(f, ["refresh-adapters"]).exitCode).toBe(0);
  expect(lstatSync(adapter).isSymbolicLink()).toBe(true);
  expect(readFileSync(target, "utf8")).toBe("intentional checkout");
});
