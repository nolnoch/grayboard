// pi's agent directory, resolved as pi itself resolves it (getAgentDir and
// normalizePath, pi 1.4.0 dist/config.js and dist/utils/paths.js): a
// non-empty PI_CODING_AGENT_DIR, with a leading `~` expanded and a file:// URL
// converted, else ~/.pi/agent. `grayboard setup` installs pi's adapter there
// and the hosted extension keeps its state there, so both must name the
// directory pi loads extensions from: an empty variable is unset to pi, never
// the current directory. Runs under Node too: the pi bundle imports it.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function piAgentDir(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  const dir = env.PI_CODING_AGENT_DIR;
  if (!dir) return join(home, ".pi", "agent");
  if (dir === "~") return home;
  if (dir.startsWith("~/")) return join(home, dir.slice(2));
  if (dir.startsWith("file://")) return fileURLToPath(dir);
  return dir;
}

// omp's profile name rule (normalizeProfileName, @oh-my-pi/pi-utils 18.14
// src/dirs.ts): blank or "default" is the default profile. omp resolves its
// directories from an invalid name as the default too, then refuses to start.
const OMP_PROFILE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i;
function ompProfile(value: string | undefined): string | undefined {
  const name = value?.trim();
  if (!name || name === "default" || name.endsWith(".") || !OMP_PROFILE_NAME.test(name) || WINDOWS_RESERVED.test(name)) return undefined;
  return name;
}

/**
 * omp's agent directory, resolved as omp's getAgentDir() resolves it at
 * startup (@oh-my-pi/pi-utils 18.14 src/dirs.ts): the config root is
 * ~/<PI_CONFIG_DIR or .omp>; a named profile (OMP_PROFILE, or PI_PROFILE when
 * OMP_PROFILE is unset) uses <root>/profiles/<name>/agent; the default
 * profile uses PI_CODING_AGENT_DIR, path-resolved with no `~` expansion,
 * unless it's PI_PROFILE's own agent dir, else <root>/agent. A value set only
 * in an omp `.env` file isn't seen. The omp adapters read getAgentDir(), so
 * `grayboard setup` must install where it points (#439).
 */
export function ompAgentDir(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  const root = join(home, env.PI_CONFIG_DIR || ".omp");
  const profile = ompProfile(env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE);
  if (profile) return join(root, "profiles", profile, "agent");
  const dir = env.PI_CODING_AGENT_DIR;
  const piProfile = ompProfile(env.PI_PROFILE);
  if (!dir || (piProfile && dir === join(root, "profiles", piProfile, "agent"))) return join(root, "agent");
  return resolve(dir);
}
