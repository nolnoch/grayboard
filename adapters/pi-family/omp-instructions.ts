// Keeps a hosted omp main session's model calls on grayboard's current
// instructions (#441). omp runs `before_agent_start` only for a user-authored
// prompt, so a push-started turn keeps the instructions the last prompt
// appended (stale after a bind), and a base rebuild (/resume, /new, /fork)
// drops them. Per request, the entry either rewrites the stale text in the
// provider payload or, when the system prompt holds no grayboard element,
// adds the current text as a hidden message.

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
// is, every string containing it (providers that join the prompt's elements).
// Returns the number of strings rewritten. Never rebuilds an object: Cursor's
// payload is a protobuf message, and Anthropic's billing patch depends on
// `system[0]`'s key order.
export function replaceText(payload: unknown, from: string, to: string): number {
  if (from === "") return 0;
  const exact = walk(payload, value => value === from ? to : undefined);
  return exact || walk(payload, value => value.includes(from) ? value.replaceAll(from, () => to) : undefined);
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
