// The Claude Code runner (docs/factory.md §5, #264): a headless
// `claude -p` running the resolved agent. The agent file pins model, tools
// and prompt; the operator's config pins the working directory and the tool
// lists (a profile's, #643); permission prompts nothing answers are denied (`--permission-
// prompts none`), so an unattended child can't wait on a person.
//
// `--restricted --strict-mcp-config`: the child ignores the operator's user,
// project and local settings (allow rules, hooks), and every MCP server.
// Without it a user rule allowing Bash reaches the child (measured on the
// pinned Claude Code). Restricted mode also hides user agents, so the agent
// goes inline (`--agents`), built from the fields the factory read.
import { closeSync, fchmodSync, openSync, rmSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Request } from "../delegate.ts";
import { execChild, prompt, readAgents, tail, type Agent, type Outcome, type Policy, type Resume, type Runner, type RunMeta } from "../runner.ts";
import type { McpServer } from "../relay.ts";
import type { Place } from "../workdir.ts";

export type ClaudeOptions = {
  bin: string;                    // the claude executable
  cwd: string;                    // where the roster's project agents live (`.claude/agents`); a run's directory is its Place
  env: Record<string, string>;    // the children's env
};

export class ClaudeRunner implements Runner {
  readonly harness = "claude";
  constructor(private readonly o: ClaudeOptions) {}

  // Claude Code's own precedence: user agents, then the project's, which win on a name.
  private dirs(): string[] {
    const config = this.o.env.CLAUDE_CONFIG_DIR ?? join(this.o.env.HOME ?? homedir(), ".claude");
    return [join(config, "agents"), join(this.o.cwd, ".claude", "agents")];
  }

  get rosterSource(): string {
    return this.dirs().join(", ");
  }

  roster(): Agent[] {
    return readAgents(this.dirs());
  }

  // policy.tools → --tools (absent: restricted mode's default, no shell, no
  // WebFetch); policy.allowedTools → --allowedTools (empty: none);
  // policy.budgetUsd → --max-budget-usd. The child runs in place.cwd;
  // place.addDirs → --add-dir, which restricted mode's file confinement
  // includes.
  //
  // stream-json (#649; under -p it needs --verbose, measured on 2.1.316):
  // every event goes to the transcript as it arrives, and the last `result`
  // event carries the reply (`result`, on success only), `session_id`,
  // `num_turns` and `total_cost_usd`. A budget stop exits 1 with subtype
  // `error_max_budget_usd` and the reason in `errors`; the check runs after
  // a turn, so a run can pass its budget by up to one turn.
  //
  // mcp (#669) → --mcp-config, a 0600 file beside the transcript (its env
  // carries the run's token, which argv would show every local process),
  // removed when the run ends; its tools join --allowedTools as
  // mcp__<server>__<tool>. Never --tools: on 2.1.316 that list filters only
  // built-ins (MCP tools pass it either way), so naming them there would
  // only cut a default-tools child down to them. Absent, the command is as
  // before, byte for byte.
  async run(agent: Agent, r: Request, signal: AbortSignal, policy: Policy, place: Place, transcript: string, resume?: Resume, mcp?: McpServer): Promise<Outcome> {
    const def = { description: agent.description ?? agent.name, prompt: agent.prompt, ...(agent.tools ? { tools: agent.tools } : {}), ...(agent.model ? { model: agent.model } : {}) };
    const cmd = [this.o.bin, "-p", "--restricted", "--strict-mcp-config", "--agents", JSON.stringify({ [agent.name]: def }), "--agent", agent.name, "--output-format", "stream-json", "--verbose", "--permission-prompts", "none"];
    if (resume) cmd.push("--resume", resume.session);
    if (policy.tools) cmd.push("--tools", policy.tools.join(","));
    const mcpFile = mcp ? `${transcript}.mcp.json` : null;
    if (mcpFile) cmd.push("--mcp-config", mcpFile);
    const allowed = [...policy.allowedTools, ...(mcp ? mcp.tools.map((t) => `mcp__${mcp.name}__${t}`) : [])];
    if (allowed.length) cmd.push("--allowedTools", ...allowed);
    if (policy.budgetUsd !== undefined) cmd.push("--max-budget-usd", String(policy.budgetUsd));
    if (place.addDirs.length) cmd.push("--add-dir", ...place.addDirs);
    const fd = openSync(transcript, "w", 0o600);
    let x: Awaited<ReturnType<typeof execChild>>;
    const events = new Lines();
    try {
      fchmodSync(fd, 0o600); // a file left by an earlier store keeps its mode under "w"
      if (mcp && mcpFile) {
        const m = openSync(mcpFile, "w", 0o600);
        try {
          fchmodSync(m, 0o600);
          writeSync(m, JSON.stringify({ mcpServers: { [mcp.name]: { type: "stdio", command: mcp.command, args: mcp.args, env: mcp.env } } }));
        } finally {
          closeSync(m);
        }
      }
      x = await execChild(cmd, { cwd: place.cwd, env: this.o.env, input: resume ? resume.input : prompt(r), signal, onStdout: (c) => { writeSync(fd, c); events.push(c); } });
    } finally {
      closeSync(fd);
      if (mcpFile) rmSync(mcpFile, { force: true });
    }
    events.end();
    const res = events.result;
    // A resumed session's total_cost_usd includes its earlier runs (measured
    // on the pinned Claude Code); this run's share is what's past them.
    const cost = typeof res?.total_cost_usd === "number" ? Math.max(0, res.total_cost_usd - (resume?.priorUsd ?? 0)) : undefined;
    const meta: RunMeta = { code: x.code, ...(typeof res?.session_id === "string" ? { session: res.session_id } : {}), ...(typeof res?.num_turns === "number" ? { turns: res.num_turns } : {}), ...(cost !== undefined ? { costUsd: cost } : {}) };
    if (x.timedOut) return { ok: false, error: "the child ran past the factory's timeout and was stopped", run: { ...meta, stop: "timeout" } };
    if (x.code === 0 && res && res.is_error !== true && typeof res.result === "string") return { ok: true, text: res.result, run: meta };
    if (res?.subtype === "error_max_budget_usd") return { ok: false, error: `stopped at its budget of $${policy.budgetUsd} after ${meta.turns ?? "?"} turn(s), $${meta.costUsd?.toFixed(4) ?? "?"} spent`, run: { ...meta, stop: "budget" } };
    const errors = Array.isArray(res?.errors) ? res.errors.filter((e): e is string => typeof e === "string").join("; ") : "";
    const why = typeof res?.result === "string" && res.result ? res.result : errors || (typeof res?.subtype === "string" ? res.subtype : tail(x.stderr || events.last) || "no output");
    return { ok: false, error: `claude exited ${x.code}: ${why}`, run: meta };
  }
}

type ResultEvent = { type: "result"; result?: unknown; is_error?: unknown; subtype?: unknown; errors?: unknown; session_id?: unknown; num_turns?: unknown; total_cost_usd?: unknown };

// Newline-delimited JSON as it arrives: keeps the last `result` event and the
// last line (for a failure's text), nothing else.
class Lines {
  result: ResultEvent | null = null;
  last = "";
  private part = "";
  private readonly dec = new TextDecoder();
  push(c: Buffer): void {
    const lines = (this.part + this.dec.decode(c, { stream: true })).split("\n");
    this.part = lines.pop()!;
    for (const l of lines) this.line(l);
  }
  end(): void {
    this.line(this.part + this.dec.decode());
    this.part = "";
  }
  private line(l: string): void {
    if (!l.trim()) return;
    this.last = l;
    if (!l.includes('"result"')) return;
    try {
      const e = JSON.parse(l) as { type?: unknown };
      if (e && e.type === "result") this.result = e as ResultEvent;
    } catch {}
  }
}
