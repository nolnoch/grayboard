import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SOCK_DIR = process.env.BUS_SOCK_DIR ?? `${homedir()}/.claude-bus`;

// One wakeup socket per lane: sock.<identity>.<lane>. Identities and lanes
// are both [a-z0-9_-], so the first dot after the identity is the separator.
function sockPath(identity: string, lane = "main"): string {
  return `${SOCK_DIR}/sock.${identity}.${lane}`;
}

export type WakeupHandler = () => void;

export async function listenForWakeup(
  identity: string,
  lane: string,
  onWake: WakeupHandler,
): Promise<() => void> {
  if (!existsSync(SOCK_DIR)) mkdirSync(SOCK_DIR, { recursive: true });
  const path = sockPath(identity, lane);
  await assertLaneFree(identity, lane);
  const server = await bindWakeupSocket(path, identity, lane, onWake);

  return () => {
    try {
      server.stop(true);
      if (existsSync(path)) unlinkSync(path);
    } catch {}
  };
}

// Bind-first (#80's fix shape): try to bind without touching the path. Only a
// path that exists AND doesn't answer (a stale file from a crashed session)
// is unlinked, once, and the bind retried — a live lane's socket is never
// unlinked. A second bind failure after that means someone else won the freed
// path: refuse rather than shadow them.
async function bindWakeupSocket(
  path: string,
  identity: string,
  lane: string,
  onWake: WakeupHandler,
): Promise<ReturnType<typeof Bun.listen>> {
  for (let attempt = 0; ; attempt++) {
    try {
      return Bun.listen({
        unix: path,
        socket: {
          open(socket) {
            onWake();
            socket.end();
          },
          data() {},
          close() {},
          error() {},
        },
      });
    } catch (e) {
      if (attempt >= 1) {
        throw new Error(`grayboard: couldn't bind the wakeup socket for identity "${identity}" lane "${lane}": ${e}`);
      }
      if (await canConnect(path)) {
        throw new Error(
          `grayboard: identity "${identity}" lane "${lane}" is already in use by a live session. ` +
            `Give this session a different BUS_LANE or BUS_IDENTITY.`,
        );
      }
      // Stale file from a crashed session: remove it and retry the bind. The
      // gap between removal and bind is #80's remaining window; a session
      // that lands in it fails the retry and refuses instead of shadowing.
      try { unlinkSync(path); } catch {}
    }
  }
}

// A live listener on this lane means another session already holds it. Taking
// the socket over would silently steal its pushes and share its cursor.
export async function assertLaneFree(identity: string, lane: string): Promise<void> {
  if (await canConnect(sockPath(identity, lane))) {
    throw new Error(
      `grayboard: identity "${identity}" lane "${lane}" is already in use by a live session. ` +
        `Give this session a different BUS_LANE or BUS_IDENTITY.`,
    );
  }
}

// Connecting is the wakeup: every live lane listener of the identity drains
// on open, so a probe also nudges them, which is harmless (drain is
// idempotent). True when any lane answered.
export async function poke(identity: string): Promise<boolean> {
  return (await pokeLanes(identity)).any;
}

// The counted form of poke: how many of the identity's lanes answered (the
// local-mode counterpart of the server's live_lanes). Probing is still a
// wakeup for each lane it reaches.
export async function pokeLanes(identity: string): Promise<{ live: number; any: boolean }> {
  let live = 0;
  for (const path of laneSocketPaths(identity)) {
    if (await canConnect(path)) live++;
  }
  return { live, any: live > 0 };
}

// Every socket path of the identity's lanes. "sock.<identity>." can't bleed
// into another identity: identities are [a-z0-9_-] (no dots), so the dot
// after the name is the separator.
function laneSocketPaths(identity: string): string[] {
  try {
    return readdirSync(SOCK_DIR)
      .filter((f) => f.startsWith(`sock.${identity}.`))
      .map((f) => join(SOCK_DIR, f));
  } catch {
    return [];
  }
}

/** Whether one lane's wakeup socket answers (liveness, and a nudge). */
export async function laneAlive(identity: string, lane: string): Promise<boolean> {
  return canConnect(sockPath(identity, lane));
}

// Connecting is the wakeup: the listener drains on open, so a probe also
// nudges the owner, which is harmless (drain is idempotent).
//
// A refused connect doesn't prove the owner is gone: a live listener whose
// process is busy can refuse too. Treating that as "dead" would let a second
// session take over a live identity, or skip a wakeup. So retry briefly; a
// stale socket file from a crashed session costs the full ~150ms.
const RETRY_MS = [25, 50, 75];

async function canConnect(path: string): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    if (!existsSync(path)) return false;
    try {
      await Bun.connect({
        unix: path,
        socket: {
          open(socket) {
            socket.end();
          },
          data() {},
          close() {},
          error() {},
        },
      });
      return true;
    } catch {
      if (attempt >= RETRY_MS.length) return false;
      await Bun.sleep(RETRY_MS[attempt]!);
    }
  }
}
