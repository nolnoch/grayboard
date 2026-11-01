// pi's agent directory, resolved as pi itself resolves it (getAgentDir and
// normalizePath, pi 1.4.0 dist/config.js and dist/utils/paths.js): a
// non-empty PI_CODING_AGENT_DIR, with a leading `~` expanded and a file:// URL
// converted, else ~/.pi/agent. `grayboard setup` installs pi's adapter there
// and the hosted extension keeps its state there, so both must name the
// directory pi loads extensions from: an empty variable is unset to pi, never
// the current directory. Runs under Node too: the pi bundle imports it.
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function piAgentDir(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  const dir = env.PI_CODING_AGENT_DIR;
  if (!dir) return join(home, ".pi", "agent");
  if (dir === "~") return home;
  if (dir.startsWith("~/")) return join(home, dir.slice(2));
  if (dir.startsWith("file://")) return fileURLToPath(dir);
  return dir;
}
