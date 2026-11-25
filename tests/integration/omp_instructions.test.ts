// Local and hosted omp's shared per-request instructions refresh (#441, #552): which
// action a request gets, and the in-place payload rewrite on the shapes omp's
// providers build (pi-ai providers: anthropic system blocks, openai-responses
// `instructions` and openai-completions' system message joined with "\n\n",
// google's systemInstruction parts, Cursor's prompt encoded in blobs).
import { describe, expect, test } from "bun:test";
import { instructionHooks, modelName, plan, replaceText } from "../../adapters/pi-family/omp-instructions.ts";

// Newlines and quotes, as the server's instructions have.
const STALE = 'You have no bus name yet.\nCall "bind" first.';
const FRESH = 'You are "be" on grayboard.\nDirect messages arrive as <channel>.';
const BASE = "You are omp, a coding agent.";

describe("plan", () => {
  test("rewrites only a stale element the last prompt appended", () => {
    expect(plan([BASE, STALE], STALE, FRESH)).toEqual({ kind: "replace", from: STALE, to: FRESH });
    expect(plan([BASE, FRESH], FRESH, FRESH)).toEqual({ kind: "none" });
  });
  test("adds the instructions when the prompt holds no grayboard element", () => {
    // A base rebuild (/resume, /new, /fork) dropped it, or nothing was ever appended.
    expect(plan([BASE], STALE, FRESH)).toEqual({ kind: "inject", text: FRESH });
    expect(plan([BASE], undefined, FRESH)).toEqual({ kind: "inject", text: FRESH });
  });
  test("leaves the request alone without current instructions", () => {
    expect(plan([BASE, STALE], STALE, undefined)).toEqual({ kind: "none" });
    expect(plan([BASE], undefined, undefined)).toEqual({ kind: "none" });
  });
});

describe("replaceText", () => {
  test("anthropic: rewrites the block's text in place, keeping objects and key order", () => {
    const blocks = [
      { type: "text", text: BASE, cache_control: { type: "ephemeral" } },
      { type: "text", text: STALE, cache_control: { type: "ephemeral" } },
    ];
    const second = blocks[1]!;
    const payload = { model: "claude", system: blocks, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] };
    expect(replaceText(payload, [BASE, STALE], STALE, FRESH)).toBe(1);
    expect(payload.system).toBe(blocks);
    expect(payload.system[1]).toBe(second);
    expect(Object.keys(second)).toEqual(["type", "text", "cache_control"]);
    expect(payload.system.map(b => b.text)).toEqual([BASE, FRESH]);
  });

  test("google: rewrites the matching part", () => {
    const parts = [{ text: BASE }, { text: STALE }];
    const payload = { contents: [], systemInstruction: { parts } };
    expect(replaceText(payload, [BASE, STALE], STALE, FRESH)).toBe(1);
    expect(payload.systemInstruction.parts).toBe(parts);
    expect(parts.map(p => p.text)).toEqual([BASE, FRESH]);
  });

  test("openai-responses and openai-completions: rewrites the joined prompt", () => {
    const responses = { model: "gpt", instructions: `${BASE}\n\n${STALE}`, input: [] };
    expect(replaceText(responses, [BASE, STALE], STALE, FRESH)).toBe(1);
    expect(responses.instructions).toBe(`${BASE}\n\n${FRESH}`);

    const system = { role: "developer", content: `${BASE}\n\n${STALE}` };
    const completions = { model: "gpt", messages: [system, { role: "user", content: "hi" }] };
    expect(replaceText(completions, [BASE, STALE], STALE, FRESH)).toBe(1);
    expect(completions.messages[0]).toBe(system);
    expect(system.content).toBe(`${BASE}\n\n${FRESH}`);
  });

  test("the joined prompt skips blank elements, as pi-ai's join does", () => {
    const payload = { instructions: `${BASE}\n\n${STALE}` };
    expect(replaceText(payload, [BASE, "  ", STALE], STALE, FRESH)).toBe(1);
    expect(payload.instructions).toBe(`${BASE}\n\n${FRESH}`);
  });

  test("a message quoting the stale text stays, beside an exact element or a joined prompt", () => {
    // A peer's message or a tool result isn't the system prompt.
    const quoted = `<channel source="grayboard">the prompt said: ${STALE}</channel>`;
    const exact = { system: [{ type: "text", text: STALE }], messages: [{ role: "user", content: quoted }] };
    expect(replaceText(exact, [STALE], STALE, FRESH)).toBe(1);
    expect(exact.system[0]!.text).toBe(FRESH);
    expect(exact.messages[0]!.content).toBe(quoted);

    const joined = { instructions: `${BASE}\n\n${STALE}`, input: [{ role: "user", content: quoted }, { type: "function_call_output", output: `${BASE}\n\n${STALE} and more` }] };
    expect(replaceText(joined, [BASE, STALE], STALE, FRESH)).toBe(1);
    expect(joined.instructions).toBe(`${BASE}\n\n${FRESH}`);
    expect(joined.input[0]!.content).toBe(quoted);
    expect(joined.input[1]!.output).toBe(`${BASE}\n\n${STALE} and more`);
  });

  test("Cursor: a prompt encoded in blobs is a counted miss, payload unchanged", () => {
    const blob = new TextEncoder().encode(JSON.stringify({ role: "system", content: `${BASE}\n\n${STALE}` }));
    const payload = { request: { blobs: [{ id: "b1", value: blob }], conversation: [{ text: "hi" }] } };
    expect(replaceText(payload, [BASE, STALE], STALE, FRESH)).toBe(0);
    expect(payload.request.blobs[0]!.value).toBe(blob);
    expect(new TextDecoder().decode(blob)).toContain("You have no bus name yet.");
  });

  test("survives cycles and skips binary buffers", () => {
    const payload: Record<string, unknown> = { system: STALE, bytes: new Uint8Array([1, 2, 3]) };
    payload.self = payload;
    expect(replaceText(payload, [STALE], STALE, FRESH)).toBe(1);
    expect(payload.system).toBe(FRESH);
    expect(payload.bytes).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe("local and hosted omp instruction hooks", () => {
  test("a missing stale payload warns once on screen for main only, while logging every main miss", async () => {
    let fresh = STALE;
    let systemPrompt = [BASE];
    const context = { getSystemPrompt: () => systemPrompt, model: { provider: "cursor", id: "encoded" } };
    const warnings: string[] = [];
    const notices: string[] = [];
    const hooks = instructionHooks({
      instructions: () => fresh,
      logger: { debug: () => {}, warn: message => { warnings.push(message); } },
      show: (message, shownContext) => { expect(shownContext).toBe(context); notices.push(message); },
    });
    systemPrompt = (await hooks.beforeAgentStart({ systemPrompt }))!.systemPrompt;
    fresh = FRESH;
    const blob = new TextEncoder().encode(JSON.stringify({ system: systemPrompt }));
    const encoded = { payload: { blobs: [blob] } };

    // Advisors invoke the provider hook without context: a miss never warns.
    await hooks.beforeProviderRequest(encoded, context);
    expect(warnings).toEqual([]);
    expect(notices).toEqual([]);

    // Main invokes context on each request. A repeated stale prompt logs
    // every miss but shows the warning only once for that stale text.
    for (let request = 0; request < 2; request++) {
      expect(await hooks.context({ messages: [] }, context)).toBeUndefined();
      await hooks.beforeProviderRequest(encoded, context);
    }
    expect(warnings).toEqual(Array(2).fill("grayboard: couldn't refresh the instructions in a request to cursor/encoded; it carries the ones from the last prompt"));
    expect(notices).toEqual(["grayboard: this turn's model (cursor/encoded) may still see the instructions from before the last bind; send a prompt to refresh them"]);
    expect(encoded.payload.blobs[0]).toBe(blob);

    // The main/advisor marker must be consumed, not left set by the miss.
    await hooks.beforeProviderRequest(encoded, context);
    expect(warnings).toHaveLength(2);
    expect(notices).toHaveLength(1);

    // Advisors still get the same rewrite when their payload is accessible.
    const plain = { payload: { instructions: systemPrompt.join("\n\n") } };
    await hooks.beforeProviderRequest(plain, context);
    expect(plain.payload.instructions).toBe(`${BASE}\n\n${FRESH}`);
    expect(warnings).toHaveLength(2);
    expect(notices).toHaveLength(1);
  });

  test("main reuses its context fetch and rewrites in place without a warning", async () => {
    let fresh = STALE;
    let fetched = 0;
    let systemPrompt = [BASE];
    const context = { getSystemPrompt: () => systemPrompt };
    const warnings: string[] = [];
    const hooks = instructionHooks({
      instructions: async () => { fetched++; return fresh; },
      logger: { debug: () => {}, warn: message => { warnings.push(message); } },
      show: message => { warnings.push(message); },
    });
    systemPrompt = (await hooks.beforeAgentStart({ systemPrompt }))!.systemPrompt;
    fresh = FRESH;
    await hooks.context({ messages: [] }, context);
    expect(fetched).toBe(2);
    // Instructions changing after context must not change this request's snapshot.
    fresh = "the next request's instructions";
    const event = { payload: { instructions: systemPrompt.join("\n\n") } };
    await hooks.beforeProviderRequest(event, context);
    expect(fetched).toBe(2);
    expect(event.payload.instructions).toBe(`${BASE}\n\n${FRESH}`);
    expect(warnings).toEqual([]);
  });

  test("a rebuilt prompt gets fresh instructions last as a hidden per-call message", async () => {
    const hooks = instructionHooks({
      instructions: () => FRESH,
      logger: { debug: () => {}, warn: () => {} },
      show: () => {},
    });
    await hooks.beforeAgentStart({ systemPrompt: [BASE] });
    const message = { role: "user", content: "hi" };
    const messages = [message];
    const result = await hooks.context({ messages }, { getSystemPrompt: () => [BASE] });
    expect(messages).toEqual([message]);
    expect(result!.messages[0]).toBe(message);
    expect(result!.messages[1]).toMatchObject({ role: "custom", customType: "grayboard-instructions", content: FRESH, display: false, attribution: "agent" });
  });

  test("model names retain the provider/id contract", () => {
    expect(modelName({ provider: "openai", id: "gpt-6" })).toBe("openai/gpt-6");
  });
});
