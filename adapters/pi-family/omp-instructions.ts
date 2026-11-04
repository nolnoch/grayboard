// Keeps an omp main session's model calls on grayboard's current
// instructions (#441). omp runs `before_agent_start` only for a user-authored
// prompt, so a push-started turn keeps the instructions the last prompt
// appended (stale after a bind), and a base rebuild (/resume, /new, /fork)
// drops them. Per request, the entry either rewrites the stale text in the
// provider payload or, when the system prompt holds no grayboard element,
// adds the current text as a hidden message.

// A harness model as the bus names it: `provider/id`. Keep this leaf free of
// hosted runtime imports: local omp bundles it without the hosted MCP client.
export const modelName = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;

type InstructionContext = {
  getSystemPrompt(): readonly string[];
  model?: { provider: string; id: string };
};

// Both omp entries use these hooks. The caller admits only main's runtime;
// advisors skip context but share its provider hook, so only a request with
// a context fetch warns when a stale-text rewrite misses (#441).
export function instructionHooks<Context extends InstructionContext>({ instructions, logger, show }: {
  instructions(): string | undefined | Promise<string | undefined>;
  logger: { debug(message: string): void; warn(message: string): void };
  show(message: string, context: Context): void;
}) {
  // Outlives a session switch: compare against the element the last user
  // prompt appended, even after omp rebuilt its base prompt without it.
  let injected: string | undefined;
  let fetched: Promise<string | undefined> | undefined;
  const warned = new Set<string>();

  return {
    async beforeAgentStart(event: { systemPrompt: readonly string[] }) {
      const text = await instructions();
      injected = text || undefined;
      return text ? { systemPrompt: [...event.systemPrompt, text] } : undefined;
    },
    async context<Message>(event: { messages: Message[] }, context: Context) {
      const fetching = Promise.resolve(instructions());
      fetched = fetching;
      const next = plan(context.getSystemPrompt(), injected, await fetching);
      logger.debug(`grayboard: instructions plan for a main request: ${next.kind}`);
      if (next.kind !== "inject") return undefined;
      // Last: Anthropic's cache boundary precedes context-added messages.
      const message = { role: "custom", customType: "grayboard-instructions", content: next.text, display: false, attribution: "agent", timestamp: Date.now() } as const;
      return { messages: [...event.messages, message] };
    },
    async beforeProviderRequest(event: { payload: unknown }, context: Context) {
      const main = fetched !== undefined;
      const fetching = fetched ?? Promise.resolve(instructions());
      fetched = undefined;
      const systemPrompt = context.getSystemPrompt();
      const next = plan(systemPrompt, injected, await fetching);
      if (next.kind !== "replace") return undefined;
      const rewritten = replaceText(event.payload, systemPrompt, next.from, next.to);
      logger.debug(`grayboard: rewrote ${rewritten} payload strings to the current instructions`);
      if (rewritten > 0 || !main) return undefined;
      // Cursor's encoded prompt or credential redaction can hide the text.
      const model = context.model ? modelName(context.model) : "an unknown model";
      logger.warn(`grayboard: couldn't refresh the instructions in a request to ${model}; it carries the ones from the last prompt`);
      if (!warned.has(next.from)) {
        warned.add(next.from);
        show(`grayboard: this turn's model (${model}) may still see the instructions from before the last bind; send a prompt to refresh them`, context);
      }
      return undefined;
    },
  };
}

export type Plan =
  | { kind: "none" }
  | { kind: "replace"; from: string; to: string }
  | { kind: "inject"; text: string };

// `injected` is the text `before_agent_start` last appended; `fresh` the
// current instructions, undefined when there are none to give.
export function plan(systemPrompt: readonly string[], injected: string | undefined, fresh: string | undefined): Plan {
  if (fresh === undefined) return { kind: "none" };
  if (injected !== undefined && systemPrompt.includes(injected)) {
    return injected === fresh ? { kind: "none" } : { kind: "replace", from: injected, to: fresh };
  }
  return { kind: "inject", text: fresh };
}

// Rewrites, in place, every string in `payload` equal to `from`; when none
// is, every string equal to the whole system prompt joined as pi-ai's
// `normalizeSystemPrompts` joins it (providers that send one system string),
// rewritten to the same join with `from` replaced. Never a substring: a peer
// message or tool result quoting the stale text stays as it was. Returns the
// number of strings rewritten. Never rebuilds an object: Cursor's payload is
// a protobuf message, and Anthropic's billing patch depends on `system[0]`'s
// key order.
export function replaceText(payload: unknown, systemPrompt: readonly string[], from: string, to: string): number {
  const exact = walk(payload, value => value === from ? to : undefined);
  if (exact) return exact;
  const joined = join(systemPrompt);
  const rewritten = join(systemPrompt.map(element => element === from ? to : element));
  return walk(payload, value => value === joined ? rewritten : undefined);
}

// pi-ai's normalizeSystemPrompts, less its credential redaction: a prompt
// omp redacted no longer equals the join, so the rewrite misses and warns.
function join(systemPrompt: readonly string[]): string {
  return systemPrompt.map(element => element.toWellFormed()).filter(element => element.trim().length > 0).join("\n\n");
}

function walk(root: unknown, rewrite: (value: string) => string | undefined): number {
  const seen = new WeakSet<object>();
  let count = 0;
  const visit = (node: unknown) => {
    if (typeof node !== "object" || node === null || seen.has(node) || ArrayBuffer.isView(node)) return;
    seen.add(node);
    for (const key of Object.keys(node)) {
      const value: unknown = Reflect.get(node, key);
      if (typeof value === "string") {
        const next = rewrite(value);
        if (next !== undefined && Reflect.set(node, key, next)) count++;
      } else visit(value);
    }
  };
  visit(root);
  return count;
}
