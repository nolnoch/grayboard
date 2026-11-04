// A scriptable fake Anthropic Messages API for Claude Code (#281), the
// counterpart of fake_model.ts's OpenAI fake. A script is a list of rules
// tried in order; the first that answers a request decides the reply, else
// the model ends its turn with text. Every request is recorded. Real Claude
// Code 2.1.316 under ANTHROPIC_BASE_URL with CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
// calls only `POST /v1/messages` (streamed); any other route gets a 404 and
// lands in `unhandled`, so a new route fails visibly.
//
// A channel message that arrives mid-turn reaches the model in that turn's
// next request (2.1.316: a system-role "A message arrived … while you were
// working" block; earlier, folded into the tool results' user message), so a
// rule decides whether it already acted by its tool-use id (derived from what
// it answers), not by message roles.

export type Block = { type: string; text?: string; id?: string; name?: string; input?: unknown; content?: unknown; tool_use_id?: string };
export type Message = { role: string; content: string | Block[] };
export type MessagesRequest = { model: string; stream?: boolean; system?: string | Block[]; messages: Message[]; tools?: { name: string }[] };
export type Recorded<B> = { method: string; path: string; body: B };
/** A text reply ends the turn; a tool reply calls `tool` under the tool-use id `id`. */
export type Reply = { text: string } | { tool: string; id: string; input: Record<string, unknown> };
export type Rule = (req: MessagesRequest) => Reply | undefined;

const blocks = (m: Message): Block[] => (typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content);
/** The text blocks of every user message, newest last. */
export const userTexts = (req: MessagesRequest): string[] =>
  req.messages.filter((m) => m.role === "user").flatMap((m) => blocks(m).filter((b) => b.type === "text").map((b) => b.text ?? ""));
/** The actual system guidance sent to Anthropic, independent of persisted transcript text. */
export const systemText = (req: MessagesRequest): string => typeof req.system === "string" ? req.system : (req.system ?? []).map(block => block.text ?? "").join("\n");
/** The text blocks of every message the model didn't write (user and system), newest last: where a channel message can arrive. */
const inboundTexts = (req: MessagesRequest): string[] =>
  req.messages.filter((m) => m.role !== "assistant").flatMap((m) => blocks(m).filter((b) => b.type === "text").map((b) => b.text ?? ""));
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
 * Makes the tool calls `steps` in order, one per request, in a conversation
 * whose user messages contain `trigger`, under the tool-use ids
 * `toolu_<trigger>_<i>`. Like onUserText, it waits for `server` first. A
 * subagent's conversation is its own: its user message is the prompt it was
 * given, so a trigger in that prompt scripts the subagent.
 */
export function onUserSteps(trigger: string, server: string, steps: { tool: string; input: Record<string, unknown> }[]): Rule {
  const base = `toolu_${trigger.replace(/\W/g, "_")}`;
  return (req) => {
    if (!userTexts(req).some((t) => t.includes(trigger))) return undefined;
    const i = steps.findIndex((_, i) => !called(req, `${base}_${i}`));
    if (i < 0) return undefined;
    const { tool, input } = steps[i]!;
    if (toolNames(req).includes(tool)) return { tool, id: `${base}_${i}`, input };
    if (!toolNames(req).includes(WAIT)) return undefined;
    return { tool: WAIT, id: `${base}_${i}_wait_${req.messages.length}`, input: { servers: [server] } };
  };
}

/** The text of each tool_result the model was sent for the tool_use `id`. */
export const toolResults = (model: FakeAnthropic, id: string): string[] =>
  model.requests.flatMap((r) => r.body.messages.flatMap((m) => typeof m.content === "string" ? [] : m.content))
    .filter((b) => b.type === "tool_result" && b.tool_use_id === id)
    .map((b) => typeof b.content === "string" ? b.content : JSON.stringify(b.content));

/**
 * Answers each Claude Code channel DM from a handle ending in `/from` once, with
 * the tool call `reply` makes from its message id and body. `source` is the
 * channel's server name (`plugin:grayboard:grayboard` for the plugin).
 */
export function onChannelDm(source: string, from: string, reply: (messageId: number, body: string) => { tool: string; input: Record<string, unknown> }): Rule {
  const dm = new RegExp(`<channel source="${RegExp.escape(source)}" message_id="(\\d+)" from="[^"]*/${RegExp.escape(from)}"[^>]*>\\n?([\\s\\S]*?)\\n?</channel>`, "g");
  return (req) => {
    for (const text of inboundTexts(req)) {
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
