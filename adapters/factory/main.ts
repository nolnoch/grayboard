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
import { readFileSync } from "node:fs";
import { ClientBus, type FactoryBus } from "./bus.ts";
import { isDelegationBody, parseDelegation, receiptBody } from "./delegate.ts";
import { startRoster } from "./roster/roster.ts";

export type FactoryOptions = {
  serverUrl: string;
  token: string;
  identity: string;
  capabilities?: Record<string, string | number | boolean>;
  // The fleets config for the roster (#124's rescoped shape): when set, the
  // module also runs the fleet-roster cycle loop against this config file.
  fleetsPath?: string;
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
  // The fleet roster (#124's rescoped shape) runs beside the delegation
  // loop when a fleets config is set: FACTORY_FLEETS or the option. Its
  // cycle timer lives for the process; the controller's stop() is for tests
  // (which call startRoster directly).
  const fleetsPath = opts?.fleetsPath ?? process.env.FACTORY_FLEETS;
  if (fleetsPath) {
    void startRoster(bus, fleetsPath).catch((e) => console.error(`[factory] roster stopped: ${e instanceof Error ? e.message : String(e)}`));
  }
  return bus;
}

// The module's run loop: consume the event stream, answer delegations. One
// receipt per request, keyed by the request's message id — a redelivered
// DM (at-least-once) must not produce a second receipt.
async function runLoop(bus: FactoryBus): Promise<void> {
  for await (const e of bus.events()) {
    if (e.subject !== "dm") continue;
    const msg = e.payload;
    if (!isDelegationBody(msg.body)) continue;
    const d = parseDelegation(msg.body);
    if (!d) continue;
    await bus.send({
      to: d.requester,
      body: receiptBody(d),
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
