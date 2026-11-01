// Real Claude Code for the claude-hosted e2e (#281): the pinned release from
// npm, cached in .e2e-cache/claude-code/<version>/, driven interactively in a
// pty (channels need an interactive session) against a fake Anthropic API
// (fake_anthropic.ts), with all of its state in a scratch dir.
//
// What makes a scratch session start straight into its prompt, measured on
// 2.1.316 (bumping CLAUDE_CODE_VERSION re-checks each, and the channel rule in
// src/shared/claude_channels.ts):
// - `.claude.json`: onboarding done, the fake key's last 20 characters
//   approved, the work dir trusted, and `tengu_harbor` cached on;
// - CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC keeps it off the network, which
//   also turns its feature flags off, so CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF
//   lets it read that cached `tengu_harbor`;
// - ENABLE_TOOL_SEARCH=false puts the MCP tools in every request instead of
//   behind ToolSearch, which the fake model doesn't drive;
// - the dev-channels warning is the one dialog; the driver confirms it.
// The prompt is typed once the plugin's MCP server is up: a prompt given on
// the command line goes to the model before MCP tools exist.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanEnv } from "./env.ts";
import { CACHE } from "./releases.ts";
import { until } from "./until.ts";

export const CLAUDE_CODE_VERSION = "2.1.316";
const FAKE_KEY = "sk-ant-api03-grayboard-e2e-fake-key-0000000000000000000000000000-AAAAAAAA";

/** The pinned Claude Code binary, installed from npm on first use. */
export function claudeCodeBin(): string {
  const dir = join(CACHE, "claude-code", CLAUDE_CODE_VERSION);
  const bin = join(dir, "node_modules", ".bin", "claude");
  if (!existsSync(bin)) {
    mkdirSync(dir, { recursive: true });
    const r = Bun.spawnSync(["npm", "install", "--prefix", dir, "--no-save", "--no-package-lock", "--no-audit", "--no-fund", `@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}`], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`npm install @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} failed: ${r.stderr.toString()}`);
  }
  const v = Bun.spawnSync([bin, "--version"], { stdout: "pipe", stderr: "pipe" });
  const out = v.stdout.toString().trim();
  if (v.exitCode !== 0 || !out.startsWith(CLAUDE_CODE_VERSION)) throw new Error(`${bin} --version said ${JSON.stringify(out)}, not ${CLAUDE_CODE_VERSION}`);
  return bin;
}

export type ClaudeHome = { dir: string; config: string; home: string; work: string; env: Record<string, string> };

/** A scratch Claude Code: config dir, HOME and a trusted work dir under `dir`, talking to `modelUrl`. */
export function claudeHome(dir: string, modelUrl: string, allow: string[] = []): ClaudeHome {
  const config = join(dir, "config"), home = join(dir, "home"), work = join(dir, "work");
  for (const d of [config, home, work]) mkdirSync(d, { recursive: true });
  writeFileSync(join(config, ".claude.json"), JSON.stringify({
    hasCompletedOnboarding: true,
    customApiKeyResponses: { approved: [FAKE_KEY.slice(-20)], rejected: [] },
    projects: { [work]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
    cachedGrowthBookFeatures: { tengu_harbor: true },
  }));
  writeFileSync(join(config, "settings.json"), JSON.stringify({ permissions: { allow } }));
  const env = cleanEnv({
    HOME: home,
    TERM: "xterm-256color",
    CLAUDE_CONFIG_DIR: config,
    ANTHROPIC_BASE_URL: modelUrl,
    ANTHROPIC_API_KEY: FAKE_KEY,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF: "1",
    ENABLE_TOOL_SEARCH: "false",
  });
  return { dir, config, home, work, env };
}

/** A non-interactive `claude <args>` in `h`; throws with its output unless it exits 0. */
export function claudeCli(bin: string, h: ClaudeHome, args: string[]): string {
  const r = Bun.spawnSync([bin, ...args], { cwd: h.work, env: h.env, stdout: "pipe", stderr: "pipe" });
  const out = r.stdout.toString() + r.stderr.toString();
  if (r.exitCode !== 0) throw new Error(`claude ${args.join(" ")} exited ${r.exitCode}: ${out}`);
  return out;
}

const ANSI = /\x1b\[[0-9;?<>=]*[a-zA-Z~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]/g;

export type ClaudeTty = {
  proc: Bun.Subprocess;
  /** Everything drawn so far, escape sequences and runs of whitespace as single spaces. */
  screen: () => string;
  /** Types `text` and submits it. */
  submit: (text: string) => Promise<void>;
  /** SIGTERM, then SIGKILL after 5 s; awaited. */
  stop: () => Promise<void>;
};

/** Interactive Claude Code in a pty, its raw output appended to `<dir>/screen.log`, its debug log at `<dir>/debug.log`. */
export function claudeTty(bin: string, h: ClaudeHome, args: string[]): ClaudeTty {
  const log = join(h.dir, "screen.log");
  let raw = "";
  const proc = Bun.spawn([bin, "--debug-file", join(h.dir, "debug.log"), ...args], {
    cwd: h.work,
    env: h.env,
    terminal: { cols: 160, rows: 50, data(_t, d) { raw += Buffer.from(d).toString("utf8"); appendFileSync(log, d); } },
  });
  // Ink moves the cursor between words, so an escape counts as a space.
  const screen = () => raw.replace(ANSI, " ").replace(/\s+/g, " ");
  // The dialog draws before Claude Code reads keys, so an Enter can be lost:
  // press it until the main screen (its version banner) draws after the dialog.
  const DIALOG = "I am using this for local development";
  const confirm = setInterval(() => {
    const s = screen(), at = s.indexOf(DIALOG);
    if (at < 0) return;
    if (s.indexOf(`v${CLAUDE_CODE_VERSION}`, at) >= 0 || proc.exitCode !== null) clearInterval(confirm);
    else proc.terminal!.write("\r");
  }, 750);
  void proc.exited.then(() => clearInterval(confirm));
  return {
    proc,
    screen,
    async submit(text) {
      proc.terminal!.write(text);
      await until(() => screen().includes(text), 10_000, `Claude Code to echo ${JSON.stringify(text)}`);
      proc.terminal!.write("\r");
    },
    async stop() {
      if (proc.exitCode !== null) return;
      proc.kill("SIGTERM");
      const killer = setTimeout(() => proc.kill("SIGKILL"), 5_000);
      await proc.exited;
      clearTimeout(killer);
    },
  };
}

/** Every live descendant of `pid`, as `[pid, command line]`. */
export function descendants(pid: number): [number, string][] {
  const rows = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid=,command="]).stdout.toString().trim().split("\n");
  const table = rows.map((r) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(r)).filter((m) => m !== null).map((m) => [Number(m[1]), Number(m[2]), m[3]!] as const);
  const out: [number, string][] = [];
  const walk = (p: number) => {
    for (const [c, pp, cmd] of table) if (pp === p) { out.push([c, cmd]); walk(c); }
  };
  walk(pid);
  return out;
}

/** The session's transcript lines (`<config>/projects/<work, slugged>/<session>.jsonl`), joined. */
export function transcript(h: ClaudeHome, session: string): string {
  const slug = h.work.replace(/[^A-Za-z0-9]/g, "-");
  const p = join(h.config, "projects", slug, `${session}.jsonl`);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}
