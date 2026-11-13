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
import { homedir } from "node:os";
import { join } from "node:path";
import type { Request } from "../delegate.ts";
import { execChild, prompt, readAgents, tail, type Agent, type Outcome, type Policy, type Runner } from "../runner.ts";

export type ClaudeOptions = {
  bin: string;                    // the claude executable
  cwd: string;                    // the children's working directory
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
  // WebFetch); policy.allowedTools → --allowedTools (empty: none).
  async run(agent: Agent, r: Request, signal: AbortSignal, policy: Policy): Promise<Outcome> {
    const def = { description: agent.description ?? agent.name, prompt: agent.prompt, ...(agent.tools ? { tools: agent.tools } : {}), ...(agent.model ? { model: agent.model } : {}) };
    const cmd = [this.o.bin, "-p", "--restricted", "--strict-mcp-config", "--agents", JSON.stringify({ [agent.name]: def }), "--agent", agent.name, "--output-format", "json", "--permission-prompts", "none"];
    if (policy.tools) cmd.push("--tools", policy.tools.join(","));
    if (policy.allowedTools.length) cmd.push("--allowedTools", ...policy.allowedTools);
    const x = await execChild(cmd, { cwd: this.o.cwd, env: this.o.env, input: prompt(r), signal });
    if (x.timedOut) return { ok: false, error: "the child ran past the factory's timeout and was stopped" };
    let out: { result?: unknown; is_error?: unknown; subtype?: unknown } | null = null;
    try { out = JSON.parse(x.stdout.trim().split("\n").pop() ?? ""); } catch {}
    if (x.code === 0 && out && out.is_error !== true && typeof out.result === "string") return { ok: true, text: out.result };
    const why = typeof out?.result === "string" && out.result ? out.result : typeof out?.subtype === "string" ? out.subtype : tail(x.stderr || x.stdout) || "no output";
    return { ok: false, error: `claude exited ${x.code}: ${why}` };
  }
}
