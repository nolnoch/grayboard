// A scriptable fake Anthropic Messages API for Claude Code (#281), the
// counterpart of fake_model.ts's OpenAI fake. A script is a list of rules
// tried in order; the first that answers a request decides the reply, else
// the model ends its turn with text. Every request is recorded. Real Claude
// Code 2.1.316 under ANTHROPIC_BASE_URL with CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
// calls only `POST /v1/messages` (streamed); any other route gets a 404 and
// lands in `unhandled`, so a new route fails visibly.
//
// Claude Code folds a turn's tool results and a channel message that arrives
// mid-turn into one user message, so a rule decides whether it already acted
// by its tool-use id (derived from what it answers), not by message roles.

export type Block = { type: string; text?: string; id?: string; name?: string; input?: unknown; content?: unknown; tool_use_id?: string };
export type Message = { role: string; content: string | Block[] };
export type MessagesRequest = { model: string; stream?: boolean; messages: Message[]; tools?: { name: string }[] };
export type Recorded<B> = { method: string; path: string; body: B };
/** A text reply ends the turn; a tool reply calls `tool` under the tool-use id `id`. */
export type Reply = { text: string } | { tool: string; id: string; input: Record<string, unknown> };
export type Rule = (req: MessagesRequest) => Reply | undefined;

const blocks = (m: Message): Block[] => (typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content);
/** The text blocks of every user message, newest last. */
export const userTexts = (req: MessagesRequest): string[] =>
  req.messages.filter((m) => m.role === "user").flatMap((m) => blocks(m).filter((b) => b.type === "text").map((b) => b.text ?? ""));
const toolNames = (req: MessagesRequest): string[] => (req.tools ?? []).map((t) => t.name);
/** Whether an earlier assistant turn already made the tool call `id`. */
export const called = (req: MessagesRequest, id: string): boolean =>
  req.messages.some((m) => m.role === "assistant" && blocks(m).some((b) => b.type === "tool_use" && b.id === id));

/**
 * Calls `tool` once, when a user message contains `trigger`. While the tool's
 * MCP server (`server`) is still connecting, Claude Code leaves its tools out
 * and offers WaitForMcpServers instead; the rule calls that first, as a model
 * would, so a prompt typed right after the server starts still works.
 */
export function onUserText(trigger: string, server: string, tool: string, input: Record<string, unknown>): Rule {
  const id = `toolu_${trigger.replace(/\W/g, "_")}`;
  return (req) => {
    if (!userTexts(req).some((t) => t.includes(trigger)) || called(req, id)) return undefined;
    if (toolNames(req).includes(tool)) return { tool, id, input };
    if (!toolNames(req).includes(WAIT)) return undefined;
    const waitId = `${id}_wait_${req.messages.length}`;
    return { tool: WAIT, id: waitId, input: { servers: [server] } };
  };
}
const WAIT = "WaitForMcpServers";

/**
 * Answers each Claude Code channel DM from a handle ending in `/from` once, with
 * the tool call `reply` makes from its message id and body. `source` is the
 * channel's server name (`plugin:grayboard:grayboard` for the plugin).
 */
export function onChannelDm(source: string, from: string, reply: (messageId: number, body: string) => { tool: string; input: Record<string, unknown> }): Rule {
  const dm = new RegExp(`<channel source="${RegExp.escape(source)}" message_id="(\\d+)" from="[^"]*/${RegExp.escape(from)}"[^>]*>\\n?([\\s\\S]*?)\\n?</channel>`, "g");
  return (req) => {
    for (const text of userTexts(req)) {
      for (const [, id, body] of text.matchAll(dm)) {
        const useId = `toolu_dm_${id}`;
        if (!called(req, useId)) return { ...reply(Number(id), body!), id: useId };
      }
    }
    return undefined;
  };
}

export type FakeAnthropic = { url: string; requests: Recorded<MessagesRequest>[]; unhandled: Recorded<string>[]; stop: () => void };

export function startFakeAnthropic(rules: Rule[]): FakeAnthropic {
  const requests: Recorded<MessagesRequest>[] = [];
  const unhandled: Recorded<string>[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const { pathname: path } = new URL(req.url);
      if (req.method !== "POST" || path !== "/v1/messages") {
        unhandled.push({ method: req.method, path, body: await req.text() });
        console.error(`[fake anthropic] unhandled ${req.method} ${path}`);
        return new Response("not served by the fake Anthropic API", { status: 404 });
      }
      const body = (await req.json()) as MessagesRequest;
      requests.push({ method: req.method, path, body });
      const reply = rules.reduce<Reply | undefined>((r, rule) => r ?? rule(body), undefined) ?? { text: "nothing to do" };
      return respond(body, reply);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, requests, unhandled, stop: () => server.stop(true) };
}

function respond(req: MessagesRequest, reply: Reply): Response {
  const usage = { input_tokens: 1, output_tokens: 1 };
  const tool = "tool" in reply;
  const block = tool ? { type: "tool_use", id: reply.id, name: reply.tool, input: reply.input } : { type: "text", text: reply.text };
  const stop = tool ? "tool_use" : "end_turn";
  const message = { id: `msg_${crypto.randomUUID()}`, type: "message", role: "assistant", model: req.model, stop_sequence: null, usage };
  if (!req.stream) return Response.json({ ...message, content: [block], stop_reason: stop });
  const event = (name: string, data: Record<string, unknown>) => `event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`;
  const body = [
    event("message_start", { message: { ...message, content: [], stop_reason: null } }),
    event("content_block_start", { index: 0, content_block: tool ? { ...block, input: {} } : { type: "text", text: "" } }),
    event("content_block_delta", { index: 0, delta: tool ? { type: "input_json_delta", partial_json: JSON.stringify(reply.input) } : { type: "text_delta", text: reply.text } }),
    event("content_block_stop", { index: 0 }),
    event("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } }),
    event("message_stop", {}),
  ].join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}
