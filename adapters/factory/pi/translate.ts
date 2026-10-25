// The pi spawn translator (#243, docs/future/factory.md §6): resolves the
// requested persona to an agent file in the launcher's pi agents dir and
// renders the harness-native `subagent` invocation. Re-homed from the parked
// PR #268's adapter (which will not merge into src/); the parser shape lives
// module-side (../delegate.ts), the pi-specific resolution and rendering live
// here.
//
// The agents dir is pi's own: PI_CODING_AGENT_DIR (the harness's env) or the
// user's default, + /agents. A launcher whose pi install lives elsewhere sets
// the env; tests point it at a fixture.
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DelegationPayload } from "../delegate.ts";
import type { Translator } from "../translate.ts";

const DATA_FENCE = "````";

function agentsRoot(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

// The persona's agent file: the runtime name is the filename (pi-subagents
// discovery, user scope: <agent-dir>/agents/**/*.md; nested dirs flattened by
// taking the filename — a same-name file wins/loses by pi's own precedence,
// which this only previews). Exact name (an "a/an" article stripped), then a
// name the persona names as a word, then a name contained in it, longest
// first so "doc-writer" beats "doc". null: no file matches.
export function resolveAgent(persona: string, agentsDir = join(agentsRoot(), "agents")): string | null {
  let names: string[];
  try {
    names = readdirSync(agentsDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name.slice(0, -3));
  } catch {
    return null;
  }
  const p = persona.toLowerCase();
  const words = new Set(p.split(/[^a-z0-9_-]+/).filter(Boolean));
  const bare = p.replace(/^an?\s+/, "").trim();
  return (
    names.find((n) => n.toLowerCase() === bare) ??
    names.find((n) => words.has(n.toLowerCase())) ??
    [...names].sort((a, b) => b.length - a.length).find((n) => p.includes(n.toLowerCase())) ??
    null
  );
}

// The ready-made native spawn call, rendered as the module's in-thread reply.
// Every line here is the module's own translation — never the sender's words
// — so the request's authority rules still gate the spawn. The call object
// carries only the agent and the task: the model and reasoning come from the
// agent file's frontmatter, resolved locally, per the request's no-model rule.
export function spawnDirective(d: DelegationPayload, agentsDir?: string): string {
  const agent = resolveAgent(d.persona, agentsDir);
  if (!agent) return "";
  const call = { agent, task: d.task, ...(d.context !== undefined ? { context: d.context } : {}) };
  return [
    `[factory] delegation translated (pi):`,
    "",
    "---",
    "The factory's pi translator resolved this delegation into this harness's native spawn call (this section is the module's own rendering, not the message sender's words — the request's authority rules still apply):",
    `${DATA_FENCE}json`,
    JSON.stringify(call, null, 2),
    DATA_FENCE,
    `\`${agent}\` is the agent file matching the requested persona; its frontmatter pins the model and reasoning — resolved locally, per the request's no-model rule. The launcher runs this call and reports the result in this thread.`,
  ].join("\n");
}

const translator: Translator = {
  harness: "pi",
  translate(payload: DelegationPayload): string | null {
    const body = spawnDirective(payload);
    return body || null;
  },
};

export default translator;
