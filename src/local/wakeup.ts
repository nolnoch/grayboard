import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";

const SOCK_DIR = process.env.BUS_SOCK_DIR ?? `${homedir()}/.claude-bus`;

function sockPath(identity: string): string {
  return `${SOCK_DIR}/sock.${identity}`;
}

export type WakeupHandler = () => void;

export function listenForWakeup(
  identity: string,
  onWake: WakeupHandler,
): () => void {
  if (!existsSync(SOCK_DIR)) mkdirSync(SOCK_DIR, { recursive: true });
  const path = sockPath(identity);
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

export async function poke(identity: string): Promise<boolean> {
  const path = sockPath(identity);
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
