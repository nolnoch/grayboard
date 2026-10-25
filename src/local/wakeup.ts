import { existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { sockDir } from "../shared/sockdir.ts";

const SOCK_DIR = sockDir();

function sockPath(identity: string, dir = SOCK_DIR): string {
  return `${dir}/sock.${identity}`;
}

export type WakeupHandler = () => void;

/**
 * Listen on `identity`'s wakeup socket. The caller must own the name (its
 * bindings row holds it, binding.ts): ownership is decided there, inside a
 * write transaction, never by probing this socket (#80). So a file already
 * at the path is a dead holder's and is replaced.
 *
 * Bun's stop() unlinks the path it listened on, whatever is there by then, so
 * listening on the real path would let a stop after a rebind delete the next
 * holder's socket. Instead it listens on a path of its own and renames that
 * into place (atomic, and replaces a dead holder's file); the returned stop
 * removes the real path only while it's still this listener's.
 */
export function listenForWakeup(identity: string, onWake: WakeupHandler): () => void {
  if (!existsSync(SOCK_DIR)) mkdirSync(SOCK_DIR, { recursive: true });
  const path = sockPath(identity);
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

/**
 * After a transaction that ended sessions commits: their sockets go (an
 * ended ID never listens again, and a stale socket costs every probe the
 * retry ladder), and the addresses the end gave mail or posts are woken.
 */
export async function deliverEnded(e: { ended: string[]; wake: string[] }, dir = SOCK_DIR): Promise<void> {
  for (const id of e.ended) {
    try {
      unlinkSync(sockPath(id, dir));
    } catch {}
  }
  await Promise.all(e.wake.map((h) => poke(h, dir)));
}

export async function poke(identity: string, dir = SOCK_DIR): Promise<boolean> {
  return canConnect(sockPath(identity, dir));
}

// Connecting is the wakeup: the listener drains on open, so a probe also
// nudges the owner, which is harmless (drain is idempotent).
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
