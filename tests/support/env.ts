import { mkdirSync } from "node:fs";
import { join } from "node:path";

// Variables a developer's shell (or a grayboard-launched session) may carry
// that would point a test's child at real state or a real identity: every
// grayboard, bus and Slack setting, and the config-directory overrides that
// would send `setup` and the hooks past the temp HOME. And CI's GitHub token,
// which the test process uses to list releases and no child needs (they
// include old release binaries, install.sh and pi's npm dependencies). And
// what Claude Code exports to its children, which the channel rule reads
// (src/shared/claude_channels.ts): a test sets those itself.
const INHERITED = /^(BUS|GRAYBOARD|SLACK|CLAUDE_CODE)_/;
const DROPPED = ["CLAUDE_CONFIG_DIR", "CLAUDECODE", "ANTHROPIC_API_KEY", "XDG_CONFIG_HOME", "PI_CODING_AGENT_DIR", "GITHUB_TOKEN", "GH_TOKEN"];

// This process's env without those, plus `extra`.
export function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !INHERITED.test(k) && !DROPPED.includes(k)) env[k] = v;
  }
  return { ...env, ...extra };
}

// A temp HOME under `dir`, not `dir` itself, so a session whose cwd is `dir`
// isn't in its home directory (which would bar attaching from it).
function home(dir: string): Record<string, string> {
  const h = join(dir, "home");
  mkdirSync(h, { recursive: true });
  return { HOME: h, GRAYBOARD_ATTACHMENTS_DIR: join(dir, "saved") };
}

// A local-mode child whose state all lives in `dir`. No credentials file
// exists there, so `grayboard mcp` picks local mode.
export function localEnv(dir: string, identity?: string, extra: Record<string, string> = {}): Record<string, string> {
  return cleanEnv({
    ...home(dir),
    BUS_DB_PATH: join(dir, "bus.db"),
    BUS_SOCK_DIR: dir,
    GRAYBOARD_CREDENTIALS: join(dir, "credentials"),
    ...(identity ? { BUS_IDENTITY: identity } : {}),
    ...extra,
  });
}

// A server-mode child signed in with `token`, whose files live in `dir`: its
// home, its saved attachments, and the one root it may attach from. A null
// identity sets no BUS_IDENTITY: the session starts unbound (#182).
export function serverEnv(
  dir: string, base: string, token: string, identity: string | null, extra: Record<string, string> = {},
): Record<string, string> {
  return cleanEnv({
    ...home(dir),
    GRAYBOARD_TOKEN: token,
    GRAYBOARD_SERVER: base,
    ...(identity ? { BUS_IDENTITY: identity } : {}),
    BUS_ATTACH_ROOTS: dir,
    ...extra,
  });
}
