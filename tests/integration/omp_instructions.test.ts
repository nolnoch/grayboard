// Local and hosted omp's shared per-request instructions refresh (#441, #552): which
// action a request gets, and the in-place payload rewrite on the shapes omp's
// providers build (pi-ai providers: anthropic system blocks, openai-responses
// `instructions` and openai-completions' system message joined with "\n\n",
// google's systemInstruction parts, Cursor's prompt encoded in blobs).
import { describe, expect, test } from "bun:test";
import { plan, replaceText } from "../../adapters/pi-family/omp-instructions.ts";

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
