// The factory module's entry (#293, docs/future/factory.md §4/§5): an
// opt-in orchestrator process that runs as a launcher session on the bus.
// NOT part of the default install — it starts only when this file is run
// (`bun adapters/factory/main.ts`); nothing in src/ or install.sh references
// it. The skeleton receives delegation requests and answers each in-thread;
// spawn translators, the fleet roster and the module store land in their own
// PRs (#243/#264–#266, #124, #108).
//
// Isolation: this module builds only on the published client and protocol
// types (scripts/check_factory_isolation.ts enforces it).
import { readFileSync, readdirSync } from "node:fs";
import { ClientBus, type FactoryBus } from "./bus.ts";
import { isDelegationBody, parseDelegation, receiptBody, type DelegationPayload } from "./delegate.ts";
import { translate as translateOpencode, readAgentFile } from "./opencode/translate.ts";
import { join } from "node:path";

export type FactoryOptions = {
  serverUrl: string;
  token: string;
  identity: string;
  capabilities?: Record<string, string | number | boolean>;
};

// Credentials for a server-mode bus: the env the tests and ops use, or the
// credentials file `grayboard login` writes. The module reads the public
// file shape; the signing-in CLI is not part of its allowlisted surface.
function credentials(): { serverUrl: string; token: string } {
  if (process.env.GRAYBOARD_TOKEN) {
    return { serverUrl: process.env.GRAYBOARD_SERVER ?? "http://localhost:8080", token: process.env.GRAYBOARD_TOKEN };
  }
  const path = process.env.GRAYBOARD_CREDENTIALS;
  if (path) {
    const saved = JSON.parse(readFileSyncText(path)) as { session_token: string; server: string };
    return { serverUrl: saved.server, token: saved.session_token };
  }
  throw new Error("no credentials: set GRAYBOARD_TOKEN (and GRAYBOARD_SERVER), or GRAYBOARD_CREDENTIALS");
}

function readFileSyncText(path: string): string {
  return readFileSync(path, "utf8");
}

export async function run(opts?: Partial<FactoryOptions>): Promise<FactoryBus> {
  const creds = opts?.serverUrl && opts?.token ? { serverUrl: opts.serverUrl, token: opts.token } : credentials();
  const identity = opts?.identity ?? process.env.BUS_IDENTITY;
  if (!identity) throw new Error("the factory needs a name: set BUS_IDENTITY");
  const bus: FactoryBus = new ClientBus(creds.serverUrl, () => creds.token, identity, {
    capabilities: opts?.capabilities,
    onDead: (reason) => console.error(`[factory] stopped: ${reason}`),
  });
  void runLoop(bus);
  return bus;
}

// The module's run loop: consume the event stream, answer delegations. One
// receipt per request, keyed by the request's message id — a redelivered
// DM (at-least-once) must not produce a second receipt.
//
// Translation: the registry currently holds the OpenCode translator only
// (#265); pi (#243 re-home) and Claude Code (#264) land in their own PRs and
// slot into TRANSLATORS. A persona no translator resolves declines, and the
// request rotates on / falls to the human (docs/boards.md §13's degrade).
const TRANSLATORS: ((p: DelegationPayload) => { ok: true; body: string } | { ok: false; reason: string })[] = [
  (p) => {
    const agentsRoot = process.env.OPENCODE_AGENTS_ROOT ?? process.cwd();
    const scan = (dir: string) => {
      try {
        return listAgentFiles(join(agentsRoot, dir));
      } catch {
        return [];
      }
    };
    const dirSource = (dir: string) => (dir === ".opencode/agents" ? "project" : "user");
    const r = translateOpencode(p, scan, dirSource);
    return r.ok ? { ok: true, body: r.body } : { ok: false, reason: r.reason };
  },
];

function listAgentFiles(dir: string): { file: string; name?: string; description?: string; model?: string; reasoningEffort?: string }[] {
  const out: { file: string; name?: string; description?: string; model?: string; reasoningEffort?: string }[] = [];
  const dirents = readdirImpl(dir);
  for (const f of dirents.filter((e) => e.endsWith(".md"))) {
    const front = readAgentFile(join(dir, f));
    out.push({ file: f, ...front });
  }
  return out;
}

const readdirImpl = (dir: string): string[] => readdirSync(dir);

async function runLoop(bus: FactoryBus): Promise<void> {
  for await (const e of bus.events()) {
    if (e.subject !== "dm") continue;
    const msg = e.payload;
    if (!isDelegationBody(msg.body)) continue;
    const d = parseDelegation(msg.body);
    if (!d) continue;
    // First translator that claims the persona wins (one registry, one
    // resolution per request — the launcher IS one harness).
    let body: string | null = null;
    let declined = "";
    for (const t of TRANSLATORS) {
      const r = t(d);
      if (r.ok) {
        body = r.body;
        break;
      }
      declined = r.reason;
    }
    await bus.send({
      to: d.requester,
      body: body ?? receiptBody(d) + (declined ? ` [declined: ${declined}]` : ""),
      threadId: msg.id,
      idempotencyKey: `receipt:${msg.id}`,
    });
  }
}

if (import.meta.main) {
  run().catch((e) => {
    console.error(`[factory] ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
}
