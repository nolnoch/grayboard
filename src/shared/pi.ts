// pi's agent directory, resolved as pi itself resolves it (getAgentDir and
// normalizePath, pi 1.4.0 dist/config.js and dist/utils/paths.js): a
// non-empty PI_CODING_AGENT_DIR, with a leading `~` expanded and a file:// URL
// converted, else ~/.pi/agent. `grayboard setup` installs pi's adapter there
// and the hosted extension keeps its state there, so both must name the
// directory pi loads extensions from: an empty variable is unset to pi, never
// the current directory. Runs under Node too: the pi bundle imports it.
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
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
  const profile = ompProfileDir(env, home);
  if (profile) return profile;
  const dir = env.PI_CODING_AGENT_DIR;
  const piProfile = ompProfile(env.PI_PROFILE);
  if (!dir || (piProfile && dir === join(root, "profiles", piProfile, "agent"))) return join(root, "agent");
  return resolve(dir);
}

// The active named omp profile's agent dir (OMP_PROFILE, else PI_PROFILE), or
// undefined in the default profile.
function ompProfileDir(env: Record<string, string | undefined>, home: string): string | undefined {
  const profile = ompProfile(env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE);
  return profile ? join(home, env.PI_CONFIG_DIR || ".omp", "profiles", profile, "agent") : undefined;
}

/**
 * pi's agent directory as `grayboard setup` and `refresh-adapters` must see
 * it. A named omp profile exports its own agent dir as PI_CODING_AGENT_DIR to
 * every child process (omp's setProfile), so in a shell an omp profile session
 * started, that value is omp's, not a pi setting: pi's is then its default
 * (#439). pi's own runtime keeps piAgentDir, since a pi started in that shell
 * does load from it.
 */
export function piSetupAgentDir(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  const profile = ompProfileDir(env, home);
  return piAgentDir(profile && env.PI_CODING_AGENT_DIR === profile ? { ...env, PI_CODING_AGENT_DIR: undefined } : env, home);
}

/**
 * Why setup can't install omp's adapter, or undefined when it can. omp's
 * default profile path-resolves PI_CODING_AGENT_DIR against the directory omp
 * starts in, with no `~` expansion, so a relative value names no one place;
 * and an agent dir that is also pi's would load each harness's adapter in the
 * other (#439).
 */
export function ompSetupRefusal(env: Record<string, string | undefined> = process.env, home = homedir(), piDir = piSetupAgentDir(env, home)): string | undefined {
  const dir = env.PI_CODING_AGENT_DIR;
  const fix = "Run omp under a profile (OMP_PROFILE, as `OMP_PROFILE=<name> grayboard setup` for omp's --profile), or set PI_CODING_AGENT_DIR to an absolute path omp doesn't share with pi, then rerun setup";
  if (!ompProfileDir(env, home) && dir && !isAbsolute(dir))
    return `omp resolves PI_CODING_AGENT_DIR (${dir}) against the directory omp starts in, without expanding ~, so setup can't tell where omp loads extensions from, and nothing was changed for omp. ${fix}`;
  const omp = ompAgentDir(env, home);
  if (resolve(omp) !== resolve(piDir)) return undefined;
  const cause = !ompProfileDir(env, home) && dir ? "omp reads PI_CODING_AGENT_DIR too" : `PI_CONFIG_DIR=${env.PI_CONFIG_DIR} puts omp's root where pi's is`;
  return `omp's agent directory is pi's (${omp}: ${cause}), and pi would load omp's adapter from it, so nothing was changed for omp. ${fix}`;
}
