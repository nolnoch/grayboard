// `grayboard fleet list/disconnect`, local mode: the lanes table plus socket
// probes. Server mode goes over HTTP instead (src/server/http.ts), where the
// hub's connection registry is the liveness truth; locally the per-lane
// wakeup socket is. See docs/boards.md §3.
import { existsSync } from "node:fs";
import { localDbPath } from "../local/open.ts";
import { lanesFor, endLane, type LaneRow } from "../core/boards.ts";
import { isValidIdentityName } from "../shared/addressing.ts";
import { laneAlive, poke } from "../local/wakeup.ts";

type LocalLane = LaneRow & { live: boolean };

async function lanesOf(db: Awaited<ReturnType<typeof openDb>>, identity: string): Promise<LocalLane[]> {
  const rows = lanesFor(db, identity);
  const out: LocalLane[] = [];
  for (const r of rows) out.push({ ...r, live: await laneAlive(identity, r.lane) });
  return out;
}

// Importing src/local/db.ts opens this process's bus; keep it lazy so
// `fleet list` doesn't create ~/.claude-bus on a machine that never ran one.
async function openDb() {
  const { db } = await import("../local/db.ts");
  return db;
}

/** `grayboard fleet list [identity]`: lanes with liveness (socket probes). */
export async function fleetLocalList(identity?: string): Promise<LocalLane[] | { error: string }> {
  if (!existsSync(localDbPath())) return { error: "no local bus yet; run a session first (grayboard mcp)" };
  const db = await openDb();
  if (identity !== undefined) {
    const name = identity.toLowerCase();
    if (!isValidIdentityName(name)) return { error: `invalid identity "${identity}": 1–32 chars, a-z 0-9 _ -` };
    if (!lanesFor(db, name).length) {
      // Attach-not-create: name what exists rather than implying a fleet.
      const lanesAll = (db.prepare(`SELECT DISTINCT handle FROM lanes ORDER BY handle`).all() as { handle: string }[]).map((r) => r.handle);
      return { error: `no live lanes for "${name}"; live identities: ${lanesAll.length ? lanesAll.join(", ") : "none"}` };
    }
    return lanesOf(db, name);
  }
  const handles = (db.prepare(`SELECT DISTINCT handle FROM lanes ORDER BY handle`).all() as { handle: string }[]).map((r) => r.handle);
  const out: LocalLane[] = [];
  for (const h of handles) out.push(...(await lanesOf(db, h)));
  return out;
}

/**
 * `grayboard fleet disconnect <identity> <lane>`: end the lane's row and nudge
 * its socket (a live process drains on the poke). The row never comes back
 * (only a session start re-inserts one), but a live-but-ignoring process
 * keeps its socket and keeps draining, invisible to the roster — local mode
 * has no way to kill a process, so enforcement is observation, like the
 * server's). Bridge lanes (a human handle's) are refused: disconnect never
 * reaches human sessions.
 */
export async function fleetLocalDisconnect(identity: string, lane: string): Promise<{ ok: true } | { error: string }> {
  if (!existsSync(localDbPath())) return { error: "no local bus yet; run a session first (grayboard mcp)" };
  const name = identity.toLowerCase();
  if (!isValidIdentityName(name)) return { error: `invalid identity "${identity}": 1–32 chars, a-z 0-9 _ -` };
  const db = await openDb();
  const { isHuman } = await import("../core/boards.ts");
  if (isHuman(db, name)) return { error: `"${name}" is a human handle; disconnect never reaches human sessions` };
  const rows = lanesFor(db, name);
  if (!rows.length) {
    const lanesAll = (db.prepare(`SELECT DISTINCT handle FROM lanes ORDER BY handle`).all() as { handle: string }[]).map((r) => r.handle);
    return { error: `no live lanes for "${name}"; live identities: ${lanesAll.length ? lanesAll.join(", ") : "none"}` };
  }
  if (!rows.some((r) => r.lane === lane)) {
    return { error: `no lane "${lane}" on "${name}"; live lanes: ${rows.map((r) => r.lane).join(", ")}` };
  }
  endLane(db, name, lane);
  // Nudge the identity's sockets so a live process notices (poke fans out to
  // every lane of the identity).
  void poke(name);
  return { ok: true };
}
