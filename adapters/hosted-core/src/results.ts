import type { CallToolResult } from "@modelcontextprotocol/client";

// The tool's parsed result for host output and afterCall: structuredContent,
// else the single text content parsed as JSON (or as is when it isn't JSON).
export function outputOf(result: CallToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const only = result.content.length === 1 ? result.content[0] : undefined;
  if (only?.type !== "text") return undefined;
  try { return JSON.parse(only.text); } catch { return only.text; }
}

// A refused call's code and reason, for a diagnostic line: the reason is the
// structured output's message, else the result's text when it is plain prose
// (an input-schema refusal's structuredContent carries only its code, the
// SDK's reason being in the text, #1220), else "no reason given". A JSON text
// is a domain refusal's full payload, unsanitized: never shown.
export function refusalOf(result: CallToolResult): { code?: string; why: string } {
  const output = outputOf(result) as { code?: unknown; message?: unknown } | string | undefined;
  const code = typeof output === "object" && typeof output?.code === "string" ? output.code : undefined;
  if (typeof output === "object" && typeof output?.message === "string") return { code, why: output.message };
  const text = typeof output === "string" ? output : result.content.find(c => c.type === "text")?.text;
  return { code, why: text && !isJson(text) ? text.replace(/^error: /, "") : "no reason given" };
}

function isJson(text: string): boolean {
  try { JSON.parse(text); return true; } catch { return false; }
}
