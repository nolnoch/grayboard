import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/sdk";
import { Host } from "@opencode/plugin/host";

const root = process.env.GRAYBOARD_GIT_TEST_ROOT!;
assert(root);
assert.equal(Bun.version, "1.4.4");
for (const name of ["sdk", "core", "plugin", "util"]) {
  const manifest = await Bun.file(join(root, "node_modules/@opencode", name, "package.json")).json();
  assert.equal(manifest.version, "2.1.4");
}
const target = readFileSync(join(root, "target.txt"), "utf8").trim();
assert.match(target, /#[a-f0-9]{40}::path:adapters\/opencode-v2$/);
assert.equal(existsSync(join(root, "repository/adapters/opencode-v2/dist")), false);
writeFileSync(join(root, "home/config/opencode.json"), JSON.stringify({ plugins: [target] }));
// No enrollment, providers, credentials or MCP endpoints: loading must be inert.
const fetch0 = globalThis.fetch;
globalThis.fetch = (() => { throw new Error("Host fixture network denied"); }) as unknown as typeof fetch;
const host = await OpenCode.create({ log: { level: "debug", emit: entry => console.log("HOST_LOG", JSON.stringify(entry)) }, database: { path: join(root, "host.sqlite") }, models: { fetch: false }, config: { directory: join(root, "home/config"), project: false, claude: false }, fs: { filewatcher: false } });
const location = { directory: join(root, "project") };
try {
  await host.agent.list({ location });
  const deadline = Date.now() + 180_000;
  let plugin;
  do {
    const list = (await host.plugin.list({ location })).data;
    plugin = list.find(p => p.source.type === "package" && p.source.target === target);
    if (plugin?.state.status === "failed") throw new Error(JSON.stringify(plugin));
    if (plugin?.state.status === "active") break;
    await Bun.sleep(100);
  } while (Date.now() < deadline);
  assert.equal(plugin?.id, "grayboard");
  assert.equal(plugin?.state.status, "active");
  assert.equal(plugin?.features.server, true);
  assert.equal(plugin?.features.tui, true);
  assert.equal(plugin?.features.rpc, true);
  console.log("HOST_PLUGIN", JSON.stringify(plugin));
  function installed(directory: string): string | undefined {
    const candidate = join(directory, "node_modules/grayboard-opencode");
    if (existsSync(join(candidate, "package.json"))) return candidate;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "node_modules") continue;
      const found = installed(join(directory, entry.name));
      if (found) return found;
    }
  }
  const directory = installed(join(root, "home/cache"));
  assert(directory, "Actual OpenCode installer must create an installed package");
  assert.equal(existsSync(join(directory, "dist")), false);
  const files = readdirSync(directory).sort();
  assert.deepEqual(files, ["README.md", "index.js", "package.json", "src", "tui.js"]);
  const entries = Host.resolve({ name: "grayboard-opencode", directory });
  assert(entries.server?.endsWith("/src/index.ts"));
  assert(entries.tui?.endsWith("/src/tui.ts"));
  assert(entries.rpc?.endsWith("/src/rpc.ts"));
  const server = await Host.load(entries.server!) as typeof import("../src/index.js");
  const tui = await Host.load(entries.tui!) as typeof import("../src/tui.js");
  const rpc = await Host.load(entries.rpc!) as typeof import("../src/rpc.js");
  assert.equal(server.default.id, "grayboard");
  assert.equal(typeof server.default.effect, "function");
  assert.equal(tui.default.id, "grayboard.tui");
  assert(rpc.Grayboard);
  assert.equal((await host.rpc(server.Grayboard).status({}, { location })).state, "unenrolled");
  const local = Host.resolve({ directory });
  assert(local.server?.endsWith("/index.js"));
  assert(local.tui?.endsWith("/tui.js"));
  assert.equal((await Host.load(local.server!) as typeof server).default.id, "grayboard");
  assert.equal((await Host.load(local.tui!) as typeof tui).default.id, "grayboard.tui");
  writeFileSync(join(root, "installed.txt"), directory);
  console.log("INSTALLED_DIRECTORY", directory);
  console.log("SOURCE_ENTRIES", JSON.stringify(entries));
  console.log("GIT_SOURCE_HOST_OK", target);
} finally {
  await host.close();
  globalThis.fetch = fetch0;
}
