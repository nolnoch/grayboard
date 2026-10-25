import { homedir } from "node:os";

/** Where a bus's wakeup sockets and name records live. Both modes use it. */
export function sockDir(env: Record<string, string | undefined> = process.env): string {
  return env.BUS_SOCK_DIR ?? `${homedir()}/.claude-bus`;
}
