// What a harness contributes (docs/factory.md §5): its agent roster
// and a headless run of one agent on one request. The run loop is
// harness-neutral; a runner is the only per-harness code.
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Request } from "./delegate.ts";
import type { Place } from "./workdir.ts";

// `prompt` is the file's body; `tools` and `model` are its frontmatter fields
// of those names (tools as a comma list). A runner passes these and nothing
// else from the file, so a field like `permissionMode` can't widen a child.
export type Agent = { name: string; file: string; description?: string; prompt: string; tools?: string[]; model?: string };
export type Outcome = { ok: true; text: string } | { ok: false; error: string };
// What a child may do (#643): the tools it has (absent, the harness's
// restricted default) and those that run without a prompt. From the run's
// profile, else the config's global lists; never from the request.
export type Policy = { tools?: string[]; allowedTools: string[] };

export interface Runner {
  readonly harness: string;
  // The agents a persona may resolve to, read fresh each call (the files change).
  roster(): Agent[];
  // Where the roster comes from, for a decline's text.
  readonly rosterSource: string;
  // Runs `agent` on the request under `policy`, in `place` (#641), until it
  // ends or `signal` aborts (a timeout).
  run(agent: Agent, r: Request, signal: AbortSignal, policy: Policy, place: Place): Promise<Outcome>;
}

// Agent files: markdown with `name:` (and optionally `description:`) in YAML
// frontmatter; no frontmatter, not an agent. A name-less file is named by its
// filename. Later directories override earlier ones by name. A missing
// directory, or an entry that isn't a readable file (a dangling symlink, a
// directory named *.md), is skipped: one bad file can't empty the roster.
export function readAgents(dirs: string[]): Agent[] {
  const byName = new Map<string, Agent>();
  for (const dir of dirs) {
    let entries: string[];
    try { entries = readdirSync(dir).sort(); } catch { continue; }
    for (const e of entries) {
      if (!e.endsWith(".md")) continue;
      const file = join(dir, e);
      let text: string;
      try {
        if (!statSync(file).isFile()) continue;
        text = readFileSync(file, "utf8");
      } catch { continue; }
      const a = parseAgent(file, text);
      if (a) byName.set(a.name, a);
    }
  }
  return [...byName.values()];
}

export function parseAgent(file: string, text: string): Agent | null {
  if (!text.startsWith("---")) return null;
  const close = text.indexOf("\n---", 3);
  if (close < 0) return null;
  const fm = text.slice(3, close);
  const field = (k: string) => new RegExp(`^${k}:[ \\t]*(.+)$`, "m").exec(fm)?.[1]?.trim().replace(/^["']|["']$/g, "");
  const name = field("name") || (file.split("/").pop() ?? "").replace(/\.md$/i, "");
  if (!name) return null;
  const description = field("description"), model = field("model");
  const tools = field("tools")?.split(",").map((t) => t.trim()).filter(Boolean);
  const prompt = text.slice(close + 4).replace(/^[^\n]*\n/, "").trim();
  return { file, name, prompt, ...(description ? { description } : {}), ...(tools?.length ? { tools } : {}), ...(model ? { model } : {}) };
}

// Persona → agent: exact (case-insensitive), then without a leading article,
// then the agent's name as a whole word of the persona, then as a substring.
// The longest name wins within a rung, so "senior researcher" beats
// "researcher" for a persona naming both. No rung matches: null (a decline).
const ARTICLE = /^(a|an|the)\s+/;
export function resolvePersona(persona: string, agents: Agent[]): Agent | null {
  const p = persona.trim().toLowerCase();
  const bare = p.replace(ARTICLE, "");
  const rungs: ((n: string) => boolean)[] = [
    (n) => n === p,
    (n) => n.replace(ARTICLE, "") === bare,
    (n) => new RegExp(`(^|[^a-z0-9])${escape(n)}([^a-z0-9]|$)`).test(bare),
    (n) => bare.includes(n),
  ];
  for (const rung of rungs) {
    const hits = agents.filter((a) => rung(a.name.toLowerCase()));
    if (hits.length) return hits.reduce((a, b) => (b.name.length > a.name.length ? b : a));
  }
  return null;
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The child's prompt: the task, then the context under its own heading. The
// child is a fresh agent whose job is this task, so the task is its prompt.
export function prompt(r: Request): string {
  return r.context ? `${r.task}\n\n## Context\n\n${r.context}` : r.task;
}

export type Exec = { code: number | null; stdout: string; stderr: string; timedOut: boolean };

// Runs a child in its own process group, the prompt on stdin (never argv: a
// task starting with "-" would read as a flag). An abort kills the whole
// group, so a child's own children die with it.
export function execChild(cmd: string[], o: { cwd: string; env: Record<string, string>; input: string; signal: AbortSignal; graceMs?: number }): Promise<Exec> {
  return new Promise((done) => {
    const p = spawn(cmd[0]!, cmd.slice(1), { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let stdout = "", stderr = "", timedOut = false;
    p.stdout!.on("data", (c: Buffer) => (stdout += c.toString()));
    p.stderr!.on("data", (c: Buffer) => (stderr += c.toString()));
    p.stdin!.on("error", () => {});
    p.stdin!.end(o.input);
    const group = (sig: NodeJS.Signals) => { try { process.kill(-p.pid!, sig); } catch {} };
    let hard: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      timedOut = true;
      group("SIGTERM");
      hard = setTimeout(() => group("SIGKILL"), o.graceMs ?? 5000);
    };
    if (o.signal.aborted) abort();
    else o.signal.addEventListener("abort", abort, { once: true });
    p.on("error", (e) => { stderr += String(e); });
    p.on("close", (code) => {
      o.signal.removeEventListener("abort", abort);
      if (hard) clearTimeout(hard);
      group("SIGKILL"); // anything the child left behind in its group
      done({ code, stdout, stderr, timedOut });
    });
  });
}

export const tail = (s: string, n = 2000) => (s.length > n ? `…${s.slice(-n)}` : s).trim();
