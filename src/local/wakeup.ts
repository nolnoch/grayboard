import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { sockDir } from "../shared/sockdir.ts";

const SOCK_DIR = sockDir();

// One wakeup socket per lane: sock.<identity>.<lane>. Identities and lanes
// are both [a-z0-9_-], so the first dot after the identity is the separator.
function sockPath(identity: string, lane = "main"): string {
  return `${SOCK_DIR}/sock.${identity}.${lane}`;
}

// The pre-lanes shape was sock.<identity> (no lane). A session still on the
// old binary binds that path, and this code never looks at it: its pokes and
// its lane guard pass the old session by until it restarts. Cheap detection:
// the old file exists → say so once.
function warnOldSocketShape(identity: string): void {
  const old = `${SOCK_DIR}/sock.${identity}`;
  if (existsSync(old)) {
    console.error(
      `[grayboard] ${old} exists: a session on an older grayboard is running this identity. ` +
        `It is invisible to this version's pokes and lane guard until it restarts.`,
    );
  }
}

export type WakeupHandler = () => void;

/**
 * Listen on this lane's wakeup socket. The caller must own the name (its
 * bindings row holds it, binding.ts): ownership is decided there, inside a
 * write transaction, never by probing this socket (#80). The lane guard
 * (`assertLaneFree`) only refuses a same-lane collision. So a file already
 * at the path is a dead holder's and is replaced.
 *
 * Bun's stop() unlinks the path it listened on, whatever is there by then, so
 * listening on the real path would let a stop after a rebind delete the next
 * holder's socket. Instead it listens on a path of its own and renames that
 * into place (atomic, and replaces a dead holder's file); the returned stop
 * removes the real path only while it's still this listener's.
 */
export function listenForWakeup(identity: string, lane: string, onWake: WakeupHandler): () => void {
  if (!existsSync(SOCK_DIR)) mkdirSync(SOCK_DIR, { recursive: true });
  warnOldSocketShape(identity);
  const path = sockPath(identity, lane);
  // Short: a unix socket path has a ~104-byte limit, and test dirs are deep.
  const own = `${SOCK_DIR}/.w${process.pid}.${Math.random().toString(36).slice(2, 8)}`;

  const server = Bun.listen({
    unix: own,
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
  let ino: number;
  try {
    ino = statSync(own).ino;
    renameSync(own, path);
  } catch (e) {
    server.stop(true);
    try {
      unlinkSync(own);
    } catch {}
    throw e;
  }

  return () => {
    try {
      server.stop(true);
      if (existsSync(path) && statSync(path).ino === ino) unlinkSync(path);
    } catch {}
  };
}

// A live listener on this lane means another session already holds it. Taking
// the socket over would silently steal its pushes and share its cursor. The
// name's ownership is decided in binding.ts; this is the same-lane guard.
export async function assertLaneFree(identity: string, lane: string): Promise<void> {
  if (await canConnect(sockPath(identity, lane))) {
    throw new Error(
      `grayboard: identity "${identity}" lane "${lane}" is already in use by a live session. ` +
        `Give this session a different BUS_LANE or BUS_IDENTITY.`,
    );
  }
}

// Connecting is the wakeup: every live lane listener of the identity drains
// on open, so a probe also nudges them — each lane claims what it delivers
// (dm_claims), so a probe-woken sibling competes for messages, never
// duplicates one. The pre-lanes shape (sock.<identity>, no lane) is probed
// too: a session still on an older binary is the identity's live delivery
// owner until it exits, and both the liveness probe (binding.ts's sockLive,
// which refuses a bind) and a DM's delivery must reach it.
export async function poke(identity: string, dir = SOCK_DIR): Promise<boolean> {
  return (await pokeLanes(identity, dir)).any;
}

// The counted form of poke: how many of the identity's lane sockets answered
// (the local-mode counterpart of the server's live_lanes). Probing is still a
// wakeup for each lane it reaches.
export async function pokeLanes(identity: string, dir = SOCK_DIR): Promise<{ live: number; any: boolean }> {
  let live = 0;
  for (const path of laneSocketPaths(identity, dir)) {
    if (await canConnect(path)) live++;
  }
  if (await canConnect(legacySocketPath(identity, dir))) live++;
  return { live, any: live > 0 };
}

// Every socket path of the identity's lanes. "sock.<identity>." can't bleed
// into another identity: identities are [a-z0-9_-] (no dots), so the dot
// after the name is the separator.
function laneSocketPaths(identity: string, dir = SOCK_DIR): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.startsWith(`sock.${identity}.`))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

// The pre-lanes shape: exactly sock.<identity>, no lane suffix. A session on
// an older binary listens there and owns the identity's delivery until it
// exits; the probe and the acquire guard must see it (the pre-upgrade
// guarantee: the old holder keeps the name, a new bind refuses).
function legacySocketPath(identity: string, dir = SOCK_DIR): string {
  return join(dir, `sock.${identity}`);
}

/** Whether one lane's wakeup socket answers (liveness, and a nudge). */
export async function laneAlive(identity: string, lane: string): Promise<boolean> {
  return canConnect(sockPath(identity, lane));
}

// Connecting is the wakeup: the listener drains on open, so a probe also
// nudges the owner — which competes for claims, never duplicates a message
// (dm_claims).
//
// A refused connect doesn't prove the owner is gone: a live listener whose
// process is busy can refuse too. Treating that as "dead" would let a second
// session believe a live identity is free, or skip a wakeup. So retry briefly; a
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
