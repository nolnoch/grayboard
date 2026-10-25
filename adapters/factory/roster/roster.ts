// The fleet roster (#124's rescoped shape, #293): a fleet is a named set of
// DISTINCT task identities the module manages as one unit. The shared-name
// design stays refused (docs/boards.md §3): every member is its own handle.
//
// The roster coordinates ONLY through the public surface (FactoryBus → the
// MCP tools): membership comes from a config file the module re-reads each
// cycle; presence is observed through peer_list; the status summary is
// posted on a fleet status board; work spreads across members through the
// public queue-board machinery (#131: a post delivers to exactly one
// subscriber, lanes rotate). The module is the orchestrator; grayboard
// never becomes one (principle 7, #288).
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FactoryBus } from "../bus.ts";
import { openStore, type Store } from "./store.ts";

export type FleetConfig = { name: string; members: string[] };
export type FactoryConfig = { fleets: FleetConfig[] };

// The data dir holds the store and the config default; FACTORY_DATA_DIR
// moves it (tests point it at a temp dir).
export function dataDir(): string {
  if (process.env.FACTORY_DATA_DIR) return process.env.FACTORY_DATA_DIR;
  // The repo root's .grayboard-factory: beside the checkout, gitignored.
  return join(import.meta.dir, "..", "..", "..", ".grayboard-factory");
}

export function boardsFor(fleet: string): { queueBoard: string; statusBoard: string } {
  return { queueBoard: `${fleet}-tasks`, statusBoard: `${fleet}-status` };
}

// Config validation: a fleet name is non-empty; every member handle is
// non-empty with no whitespace; a handle may serve several fleets but never
// the same fleet twice (each member is a distinct bus name — §3).
export function validateConfig(raw: unknown): FactoryConfig {
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as Record<string, unknown>).fleets)) {
    throw new Error("the fleets config needs { fleets: [{ name, members }] }");
  }
  const fleets = (raw as { fleets: unknown }).fleets as unknown[];
  const seenFleets = new Set<string>();
  const out: FleetConfig[] = [];
  for (const f of fleets) {
    if (typeof f !== "object" || f === null) throw new Error("each fleet is an object");
    const { name, members } = f as Record<string, unknown>;
    if (typeof name !== "string" || !name.trim()) throw new Error("a fleet name is required");
    if (seenFleets.has(name)) throw new Error(`fleet "${name}" appears twice`);
    seenFleets.add(name);
    if (!Array.isArray(members) || members.length === 0) throw new Error(`fleet "${name}" needs at least one member`);
    const seen = new Set<string>();
    for (const m of members) {
      if (typeof m !== "string" || !m.trim() || /\s/.test(m)) {
        throw new Error(`fleet "${name}" has an invalid member handle: ${JSON.stringify(m ?? null)}`);
      }
      if (seen.has(m)) throw new Error(`fleet "${name}" lists "${m}" twice — members are distinct names (§3)`);
      seen.add(m);
    }
    out.push({ name, members: [...seen] });
  }
  return { fleets: out };
}

export function loadConfig(path: string): FactoryConfig {
  return validateConfig(JSON.parse(readFileSync(path, "utf8")));
}

export type RosterOptions = {
  // Cycle interval; tests run fast cycles.
  intervalMs?: number;
  // Audit-row retention for the module's own store.
  retentionMs?: number;
  now?: () => number;
};

export type RosterController = { stop: () => void };

// The module's cycle: sync the config (creating boards idempotently — the
// board_create tool answers a same-creator repeat from state), observe
// member presence through peer_list, post the status summary when it
// changed. Timer-driven only: the DM event stream belongs to the module's
// delegation run loop (bus.events() has exactly one consumer).
export async function startRoster(bus: FactoryBus, configPath: string, opts: RosterOptions = {}): Promise<RosterController> {
  const store = openStore(dataDir());
  const interval = opts.intervalMs ?? 30_000;
  const retention = opts.retentionMs ?? 30 * 24 * 60 * 60 * 1000;
  const now = opts.now ?? (() => Date.now());
  let stopped = false;
  let configMtime = -1;

  let closed = false;
  const fail = (e: unknown): void => {
    if (!closed) store.log("error", `cycle failed: ${e instanceof Error ? e.message : String(e)}`, now());
  };

  const cycle = async (): Promise<void> => {
    if (stopped) return;
    store.prune(retention, now());
    const st = statSync(configPath, { throwIfNoEntry: false });
    if (!st) return;
    if (st.mtimeMs !== configMtime) {
      configMtime = st.mtimeMs;
      await syncFromConfig(bus, store, loadConfig(configPath), now());
    }
    let changed = false;
    for (const fleet of store.fleets()) {
      if (await observePresence(bus, store, fleet.name, now())) changed = true;
    }
    if (changed) await postSummaries(bus, store, now());
  };

  await cycle().catch(fail);
  const timer = setInterval(() => {
    void cycle().catch(fail);
  }, interval);
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      closed = true;
      clearInterval(timer);
      store.close();
    },
  };
}

// Ensure the fleet's boards and membership match the config. Idempotent:
// the board_create tool answers a same-creator repeat from state (#254's
// lost-answer semantics), and member adds are INSERT OR IGNORE.
export async function syncFromConfig(bus: FactoryBus, store: Store, cfg: FactoryConfig, now = Date.now()): Promise<void> {
  const wanted = new Set(cfg.fleets.map((f) => f.name));
  for (const f of store.fleets()) {
    if (!wanted.has(f.name)) {
      store.removeFleet(f.name);
      store.log("fleet_removed", f.name, now);
    }
  }
  for (const f of cfg.fleets) {
    const { queueBoard, statusBoard } = boardsFor(f.name);
    // Awaited: a fire-and-forget op whose promise rejects (a close racing
    // the connect) would be an unhandled rejection; the cycle's own catch
    // owns these failures.
    await bus.boardCreate({ name: queueBoard, purpose: `the "${f.name}" fleet's task queue (one post, one member; #131/#124)`, kind: "queue", idempotencyKey: `board:${queueBoard}` });
    await bus.boardCreate({ name: statusBoard, purpose: `the "${f.name}" fleet's roster status, posted by the factory (#124/#293)`, idempotencyKey: `board:${statusBoard}` });
    store.addFleet({ name: f.name, queueBoard, statusBoard }, now);
    const known = new Set(store.members(f.name).map((m) => m.handle));
    for (const h of f.members) {
      if (!known.has(h)) {
        store.addMember(f.name, h, now);
        store.log("member_added", `${f.name} ${h}`, now);
      }
    }
    for (const m of store.members(f.name)) {
      if (!f.members.includes(m.handle)) {
        store.removeMember(f.name, m.handle);
        store.log("member_removed", `${f.name} ${m.handle}`, now);
      }
    }
  }
}

// Observe member presence through the public surface and update the store.
// Returns whether anything changed since the last observation.
export async function observePresence(bus: FactoryBus, store: Store, fleet: string, now = Date.now()): Promise<boolean> {
  const peers = await bus.peers();
  const online = new Set(peers.filter((p) => p.online).map((p) => p.handle));
  let changed = false;
  for (const m of store.members(fleet)) {
    const isOnline = online.has(m.handle);
    const prev = store.presence(fleet).find((p) => p.handle === m.handle);
    store.setPresence(fleet, m.handle, isOnline, now);
    if (!prev || prev.online !== (isOnline ? 1 : 0)) {
      changed = true;
      store.log("presence", `${fleet} ${m.handle} ${isOnline ? "online" : "offline"}`, now);
    }
  }
  return changed;
}

// The status summary: per-member online state, rendered for the fleet's
// status board. Posted only when it changes — the board is append-only
// (principle 5), so "updates" are new posts, and a changeless cycle must
// not spam the board.
export function statusSummary(store: Store, fleet: string): string {
  const rows = store.presence(fleet);
  const online = rows.filter((r) => r.online === 1).length;
  const lines = rows.map((r) => `  ${r.handle}: ${r.online === 1 ? "online" : "offline"}`);
  return [`[fleet ${fleet}] ${online}/${rows.length} members online`, ...lines].join("\n");
}

export async function postSummaries(bus: FactoryBus, store: Store, now = Date.now()): Promise<void> {
  for (const f of store.fleets()) {
    const summary = statusSummary(store, f.name);
    if (store.meta(`status:${f.name}`) === summary) continue;
    await bus.post({ board: f.status_board, body: summary, idempotencyKey: `status:${f.name}:${now}` });
    store.setMeta(`status:${f.name}`, summary);
    store.log("status_posted", f.name, now);
  }
}

// Hand a task to the fleet: it goes on the fleet's queue board, whose
// one-subscriber delivery (#131) puts it in front of exactly one member —
// the machinery spreads the work, not the roster. The result's `notified`
// names the member the machinery picked.
export async function dispatch(bus: FactoryBus, store: Store, fleet: string, taskBody: string, idempotencyKey: string, now = Date.now()): Promise<{ postId: number; board: string; picked: string | null }> {
  const f = store.fleets().find((x) => x.name === fleet);
  if (!f) throw new Error(`no fleet "${fleet}"`);
  const r = await bus.post({ board: f.queue_board, body: taskBody, idempotencyKey });
  store.log("dispatched", `${fleet} post ${r.postId} -> ${r.notified[0] ?? "nobody (no lane)"}`, now);
  return { postId: r.postId, board: r.board, picked: r.notified[0] ?? null };
}
