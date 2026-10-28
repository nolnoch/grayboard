import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { OpenCode } from "@opencode/sdk";
type LogEntry = { message: string; level?: unknown; attributes?: unknown };
import { Grayboard } from "../src/rpc.js";

const root = process.env.GRAYBOARD_LOG_PROBE_DIR;
assert(root, "Use an owned empty private directory");
assert.equal(Bun.version, "1.4.4");
const installed = resolve(import.meta.dir, "..");
mkdirSync(join(root, "project"), { recursive: true });
const entries: LogEntry[] = [];
let host: Awaited<ReturnType<typeof OpenCode.create>> | undefined;
try {
  host = await OpenCode.create({ log: { level: "warn", emit: (entry: LogEntry) => { entries.push(entry); } }, database: { path: join(root, "host.sqlite") }, models: { fetch: false }, config: { directory: join(root, "config"), project: false, claude: false, content: JSON.stringify({ plugins: [{ package: installed }] }) }, fs: { filewatcher: false } });
  const location = { directory: join(root, "project") };
  await host.agent.list({ location });
  const session = await host.session.create({ location, title: "Logger probe" });
  let plugins = await host.plugin.list({ location });
  for (let n = 0; n < 160 && !plugins.data.some((p: { id?: string; state: { status: string } }) => p.id === "grayboard"); n++) {
    await Bun.sleep(50);
    plugins = await host.plugin.list({ location });
  }
  await Bun.write(join(root, "plugins.json"), JSON.stringify(plugins, null, 2));
  assert(plugins.data.some((p: { id?: string; state: { status: string } }) => p.id === "grayboard" && p.state.status === "active"), "Native package loader must activate the genuine Effect default");
  const rpc = host.rpc(Grayboard);
  const result = await rpc.enroll({ sessionID: session.id }, { location });
  assert.equal(result.state, "paused");
  assert(result.roots.some((r: { sessionID?: string; operation: string; code?: string }) => r.sessionID === session.id && r.operation === "enroll" && r.code === "operation_failed"));
  await host.close(); host = undefined;
  const diagnostic = entries.filter(e => e.message.includes("Grayboard subscriber state"));
  assert(diagnostic.length > 0, "Actual host writer receives inherited logger output");
  const text = JSON.stringify(diagnostic);
  assert(text.includes(session.id)); assert(text.includes("operation_failed")); assert(text.includes("enroll"));
  assert(!text.includes("Bearer")); assert(!text.includes("access_token"));
  const count = entries.length;
  await assert.rejects(rpc.enroll({ sessionID: session.id }, { location }));
  assert.equal(entries.length, count, "An RPC attempt after host unload cannot restart the emitter");
  await Bun.write(join(root, "result.json"), JSON.stringify({ bun: Bun.version, installed, plugin: "grayboard", diagnostic, unloaded: true }, null, 2));
} finally {
  await host?.close();
  await Bun.write(join(root, "entries.json"), JSON.stringify(entries, null, 2));
}
