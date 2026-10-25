// A scriptable fake LLM serving OpenAI chat completions, streamed (pi; omp and
// OpenCode use the same API). A script is a list of rules tried in order; the
// first that answers a request decides the reply, else the model says it has
// nothing to do. Every completion request is recorded, so a test asserts on
// what the harness sent. Any other route gets a 404 and lands in `unhandled`,
// so a harness calling a route the fake doesn't serve fails visibly. The
// Anthropic Messages side (Claude Code) lands with the Claude Code harness
// tests, after probe P1 measures which routes it calls.

export type ChatMessage = { role: string; content?: unknown; tool_calls?: unknown };
export type ChatRequest = { messages: ChatMessage[]; tools?: { function: { name: string } }[] };
export type Recorded<B> = { method: string; path: string; body: B };
export type Reply = { text: string } | { tool: string; args: Record<string, unknown> };
export type Rule = (req: ChatRequest) => Reply | undefined;

export const messageText = (m: ChatMessage): string =>
  typeof m.content === "string"
    ? m.content
    : Array.isArray(m.content)
      ? m.content.map((p: { text?: string }) => p.text ?? "").join("")
      : "";

// Answers the latest grayboard <channel> DM from `from` with a tool call,
// unless the model already acted after it. A context-only message (a digest)
// can land after the tool result, mid-turn; that isn't a new DM to answer. A
// DM delivered twice still gets two replies.
export function onChannelDm(from: string, reply: (messageId: number) => Reply): Rule {
  const dm = new RegExp(`<channel source="grayboard" message_id="(\\d+)" from="${RegExp.escape(from)}"`);
  return (req) => {
    const at = req.messages.findLastIndex((m) => dm.test(messageText(m)));
    if (at < 0 || req.messages.slice(at + 1).some((m) => m.role === "assistant")) return undefined;
    return reply(Number(dm.exec(messageText(req.messages[at]!))![1]));
  };
}

export type FakeModel = { port: number; requests: Recorded<ChatRequest>[]; unhandled: Recorded<string>[]; stop: () => void };

export function startFakeModel(rules: Rule[]): FakeModel {
  const requests: Recorded<ChatRequest>[] = [];
  const unhandled: Recorded<string>[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const { pathname: path } = new URL(req.url);
      if (req.method !== "POST" || !path.endsWith("/chat/completions")) {
        unhandled.push({ method: req.method, path, body: await req.text() });
        console.error(`[fake model] unhandled ${req.method} ${path}`);
        return new Response("not served by the fake model", { status: 404 });
      }
      const body = (await req.json()) as ChatRequest;
      requests.push({ method: req.method, path, body });
      const reply = rules.reduce<Reply | undefined>((r, rule) => r ?? rule(body), undefined) ?? { text: "nothing to do" };
      return "text" in reply
        ? sse({ content: reply.text }, "stop")
        : sse(
            { content: null, tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function", function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }] },
            "tool_calls",
          );
    },
  });
  return { port: server.port!, requests, unhandled, stop: () => server.stop(true) };
}

function sse(delta: Record<string, unknown>, finish: string): Response {
  const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) =>
    `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "fake-1", choices, ...extra })}\n\n`;
  const body =
    chunk([{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }]) +
    chunk([{ index: 0, delta: {}, finish_reason: finish }]) +
    chunk([], { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) +
    "data: [DONE]\n\n";
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}
