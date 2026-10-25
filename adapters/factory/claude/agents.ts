// The launcher's Claude Code agent roster (docs/future/factory.md §6): each
// agent is a markdown file with YAML frontmatter naming it. Only `name` (and
// `description`, for the decline text) matter here — the spawn directive
// carries the subagent_type, and Claude Code resolves the rest (model,
// tools, effort) from the same file at spawn time.
//
// The roster directory is the user's ~/.claude/agents by default;
// FACTORY_AGENTS_DIR overrides it (the module's own knob — tests point it at
// a fixture, ops can point it at a shared roster). Only .md files count.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type AgentEntry = { file: string; name: string; description?: string };

export function agentsDir(): string {
  return process.env.FACTORY_AGENTS_DIR ?? join(process.env.HOME ?? "", ".claude", "agents");
}

// The frontmatter subset the roster needs: `name:` and optionally
// `description:` between --- fences. A file without a usable name falls
// back to its filename; a file with no frontmatter at all is skipped (it
// isn't an agent definition).
export function parseAgent(file: string, text: string): AgentEntry | null {
  if (!text.startsWith("---")) return null;
  const close = text.indexOf("\n---", 3);
  if (close < 0) return null;
  const fm = text.slice(3, close);
  const name = /^name:\s*(.+)$/m.exec(fm)?.[1]?.trim();
  const description = /^description:\s*(.+)$/m.exec(fm)?.[1]?.trim();
  const base = file.split("/").pop() ?? file;
  const fallback = base.replace(/\.md$/i, "");
  if (!name && fallback === "") return null;
  return { file, name: name ?? fallback, ...(description ? { description } : {}) };
}

export function listAgents(dir = agentsDir()): AgentEntry[] {
  if (!existsSync(dir)) return [];
  const out: AgentEntry[] = [];
  for (const e of readdirSync(dir)) {
    if (!e.endsWith(".md")) continue;
    const p = join(dir, e);
    const a = parseAgent(p, readFileSync(p, "utf8"));
    if (a) out.push(a);
  }
  return out;
}

// Persona → roster entry, mirroring the pi translator's resolution ladder:
// exact (case-insensitive) → article-stripped exact → whole-word containment
// → substring; the longest roster name wins ties, so "researcher" beats
// "researcher-v2" for a request for "researcher" only via exactness, and a
// request for "senior researcher" prefers a "senior researcher" entry over
// a bare "researcher" one by longest-name.
const ARTICLES = /^(a|an|the)\s+/i;

function score(persona: string, name: string): number {
  const p = persona.trim().toLowerCase();
  const n = name.toLowerCase();
  if (p === n) return 100;
  const ps = p.replace(ARTICLES, "");
  const ns = n.replace(ARTICLES, "");
  if (ps === ns) return 80;
  const word = new RegExp(`(^|\\\\W)${escapeRe(n)}(\\\\W|$)`);
  if (word.test(p)) return 60;
  return p.includes(ns) ? 40 : 0;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function resolvePersona(persona: string, agents: AgentEntry[]): AgentEntry | null {
  let best: AgentEntry | null = null;
  let bestScore = 0;
  for (const a of agents) {
    const s = score(persona, a.name);
    if (s > bestScore || (s > 0 && s === bestScore && best !== null && a.name.length > best.name.length)) {
      best = a;
      bestScore = s;
    }
  }
  return best;
}
