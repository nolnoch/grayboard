// The OpenCode spawn translator (#265, under the factory module #293): maps
// the harness-neutral delegation payload to OpenCode's native Task surface.
//
// Harness facts (research: ~/llm/grayboard/delegation-research/opencode.md):
// the persona concept is OpenCode's named agent (project `.opencode/agents/`
// or user-level `~/.config/opencode/agents/`, frontmatter `description` used
// for matching); a Task child shares the server's MCP clients (so the child's
// own bus connection is a SERVER-session property, not a Task property —
// documented, not built, per the spec's follow-up note); per-agent
// `model: "provider/model-id"` and `reasoningEffort` are config properties of
// the agent itself, which the launcher session already runs — the directive
// does not restate them (stating a model here would smuggle harness-specific
// naming across the payload boundary, which principle 7 and the persona rule
// forbid: the agent file IS the persona).
//
// Isolation (#293): imports nothing from src/; the payload type is the
// module's own parse of the public message shape (delegate.ts).
import { readFileSync } from "node:fs";

// Where an OpenCode launcher's agents live, in precedence order. The
// launcher's project wins over the user-level dir, matching OpenCode's own
// config resolution.
export const AGENT_DIRS = [".opencode/agents", "agents"];

export type ResolvedAgent = {
  name: string;
  source: "project" | "user";
  path: string;
  model?: string;
  reasoningEffort?: string;
};

export type PersonaResolution =
  | { ok: true; agent: ResolvedAgent }
  | { ok: false; reason: "unknown-persona"; closest: string[] };

// Reads the agent file's frontmatter (name, description, model,
// reasoningEffort). OpenCode agent files are markdown with a YAML-ish
// frontmatter block; the fields the translator needs are line-oriented, so a
// line scanner is enough and stays dependency-free.
export function readAgentFile(path: string): { name?: string; description?: string; model?: string; reasoningEffort?: string } {
  let text: string;
  try {
    text = readTextFile(path);
  } catch {
    return {};
  }
  const out: ReturnType<typeof readAgentFile> = {};
  if (!text.startsWith("---")) return out;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return out;
  for (const line of text.slice(3, end).split("\n")) {
    const m = line.match(/^(\w[\w-]*):\s*(.+?)\s*$/);
    if (!m) continue;
    const key = m[1] as "name" | "description" | "model" | "reasoningEffort";
    if (key === "name" || key === "description" || key === "model" || key === "reasoningEffort") out[key] = m[2];
  }
  return out;
}

function readTextFile(path: string): string {
  return readFileSyncImpl(path);
}

let readFileSyncImpl: (p: string) => string = (p) => readFileSync(p, "utf8");

export function setReadFileSync(impl: (p: string) => string): void {
  readFileSyncImpl = impl;
}

// Strips the English article OpenCode descriptions usually carry, so "a
// researcher persona" resolves to an agent described as "researcher".
function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/^(the|a|an)\s+/, "").replace(/\s+persona$/, "").replace(/[^a-z0-9-_ ]/g, "").trim();
}

// The resolution table: exact name/article-stripped name/word-overlap on
// description, longest-substring as the last resort. Unknown personas
// decline — rotation (#242) or the human fallback proceeds, matching §13.
export function resolvePersona(
  persona: string,
  scan: (dir: string) => { file: string; name?: string; description?: string; model?: string; reasoningEffort?: string }[],
  dirSource: (dir: string) => "project" | "user",
): PersonaResolution {
  const want = normalize(persona);
  if (!want) return { ok: false, reason: "unknown-persona", closest: [] };
  const candidates: { agent: ResolvedAgent; description: string; score: number; tier: number }[] = [];
  for (const dir of AGENT_DIRS) {
    const source = dirSource(dir);
    for (const f of scan(dir)) {
      const nameNorm = f.name ? normalize(f.name) : "";
      const descNorm = f.description ? normalize(f.description) : "";
      let tier = 0;
      if (nameNorm === want) tier = 1;
      else if (descNorm === want) tier = 2;
      else if (nameNorm && (want.split(/\s+/).includes(nameNorm) || nameNorm.split(/\s+/).every((w) => want.includes(w)))) tier = 3;
      else if (descNorm && want.split(/\s+/).some((w) => w.length > 3 && descNorm.includes(w))) tier = 4;
      else if (nameNorm && (nameNorm.includes(want) || want.includes(nameNorm))) tier = 5;
      if (tier > 0) {
        candidates.push({
          agent: { name: f.name ?? fileBase(f.file), source, path: `${dir}/${f.file}`, ...(f.model ? { model: f.model } : {}), ...(f.reasoningEffort ? { reasoningEffort: f.reasoningEffort } : {}) },
          description: descNorm,
          score: tier,
          tier,
        });
      }
    }
  }
  if (candidates.length === 0) {
    // The refusal names the closest agents (the core's own refusal shape,
    // boards.md §3): derive from scan without dir duplication.
    const names: string[] = [];
    for (const dir of AGENT_DIRS) for (const f of scan(dir)) if (f.name) names.push(f.name);
    return { ok: false, reason: "unknown-persona", closest: names.slice(0, 5) };
  }
  candidates.sort((a, b) => a.score - b.score || b.description.length - a.description.length);
  return { ok: true, agent: candidates[0].agent };
}

function fileBase(file: string): string {
  return file.replace(/\.md$/, "");
}

// The native Task directive: what a launcher session running OpenCode reads
// to spawn the child. Deliberately no model/effort restatement (the agent
// file owns those — see the header note); the directive carries the task
// brief and the reply contract (the launcher relays the result in-thread —
// the relay floor, #246's item 9 shape). The brief is one JSON line
// (JSON.stringify has no raw newlines), so the task's own text can never
// close the fence or forge a trailer inside it.
export function taskDirective(p: { requester: string; persona: string; task: string; context?: string }, agent: ResolvedAgent): string {
  const lines = [
    `@${agent.name} — delegation request from ${p.requester} (factory module):`,
    "",
    "```json",
    JSON.stringify({ task: p.task, ...(p.context !== undefined ? { context: p.context } : {}) }),
    "```",
    "",
    "Reply in the delegation thread when done (the launcher relays to the requester).",
  ];
  return lines.join("\n");
}

// The translator the module registry holds: declines an unknown persona (the
// rotation/human-fallback path proceeds), renders the directive otherwise.
export function translate(p: { requester: string; persona: string; task: string; context?: string }, scan: (dir: string) => { file: string; name?: string; description?: string; model?: string; reasoningEffort?: string }[], dirSource: (dir: string) => "project" | "user"): { ok: true; body: string; agent: ResolvedAgent } | { ok: false; reason: string; closest: string[] } {
  const r = resolvePersona(p.persona, scan, dirSource);
  if (!r.ok) return { ok: false, reason: `no OpenCode agent matches persona "${p.persona}"`, closest: r.closest };
  return { ok: true, body: taskDirective(p, r.agent), agent: r.agent };
}
