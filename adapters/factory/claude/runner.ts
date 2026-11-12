// The Claude Code runner (docs/factory.md §5, #264): a headless
// `claude -p` running the resolved agent. The agent file pins model, tools
// and prompt; the operator's config pins the working directory and the tool
// allowlist; permission prompts nothing answers are denied (`--permission-
// prompts none`), so an unattended child can't wait on a person.
import { homedir } from "node:os";
import { join } from "node:path";
import type { Request } from "../delegate.ts";
import { execChild, prompt, readAgents, tail, type Agent, type Outcome, type Runner } from "../runner.ts";

export type ClaudeOptions = {
  bin: string;                    // the claude executable
  cwd: string;                    // the children's working directory
  allowedTools: string[];         // --allowedTools; empty adds none beyond the agent's own
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

  async run(agent: Agent, r: Request, signal: AbortSignal): Promise<Outcome> {
    const cmd = [this.o.bin, "-p", "--agent", agent.name, "--output-format", "json", "--permission-prompts", "none"];
    if (this.o.allowedTools.length) cmd.push("--allowedTools", ...this.o.allowedTools);
    const x = await execChild(cmd, { cwd: this.o.cwd, env: this.o.env, input: prompt(r), signal });
    if (x.timedOut) return { ok: false, error: "the child ran past the factory's timeout and was stopped" };
    let out: { result?: unknown; is_error?: unknown; subtype?: unknown } | null = null;
    try { out = JSON.parse(x.stdout.trim().split("\n").pop() ?? ""); } catch {}
    if (x.code === 0 && out && out.is_error !== true && typeof out.result === "string") return { ok: true, text: out.result };
    const why = typeof out?.result === "string" && out.result ? out.result : typeof out?.subtype === "string" ? out.subtype : tail(x.stderr || x.stdout) || "no output";
    return { ok: false, error: `claude exited ${x.code}: ${why}` };
  }
}
