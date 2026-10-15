import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";

const SOCK_DIR = process.env.BUS_SOCK_DIR ?? `${homedir()}/.claude-bus`;

function sockPath(identity: string): string {
  return `${SOCK_DIR}/sock.${identity}`;
}

export type WakeupHandler = () => void;

export async function listenForWakeup(
  identity: string,
  onWake: WakeupHandler,
): Promise<() => void> {
  if (!existsSync(SOCK_DIR)) mkdirSync(SOCK_DIR, { recursive: true });
  const path = sockPath(identity);
  await assertIdentityFree(identity);
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {}

  const server = Bun.listen({
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

  return () => {
    try {
      server.stop(true);
      if (existsSync(path)) unlinkSync(path);
    } catch {}
  };
}

// A live listener means another session already owns this identity. Taking
// the socket over would silently steal its pushes and share its cursor.
export async function assertIdentityFree(identity: string): Promise<void> {
  if (await canConnect(sockPath(identity))) {
    throw new Error(
      `grayboard: identity "${identity}" is already in use by a live session. ` +
        `Give this session a different BUS_IDENTITY or don't load grayboard here.`,
    );
  }
}

export async function poke(identity: string): Promise<boolean> {
  return canConnect(sockPath(identity));
}

// Connecting is the wakeup: the listener drains on open, so a probe also
// nudges the owner, which is harmless (drain is idempotent).
async function canConnect(path: string): Promise<boolean> {
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
    return false;
  }
}
