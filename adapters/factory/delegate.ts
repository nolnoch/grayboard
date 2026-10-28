// Reading a delegation request off the public message shape (docs/boards.md
// §13): the header line, then the fenced JSON data block. An outside
// orchestrator sees the same bytes, so the module parses them the same way —
// the core's own parser (src/core/delegation.ts) is not part of the module's
// allowlisted surface, and mustn't become one.
export type DelegationPayload = { requester: string; persona: string; task: string; context?: string };

export function isDelegationBody(body: string): boolean {
  return body.startsWith("[delegation request from ");
}

// The fenced block is DATA by the sender's own contract; a body without a
// well-formed block, or with fields of the wrong shape, is not a delegation.
export function parseDelegation(body: string): DelegationPayload | null {
  const start = body.indexOf("```json\n");
  if (start < 0) return null;
  const end = body.indexOf("\n```", start + 8);
  if (end < 0) return null;
  let data: unknown;
  try {
    data = JSON.parse(body.slice(start + 8, end));
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.requester !== "string" || typeof d.persona !== "string" || typeof d.task !== "string") return null;
  if (d.context !== undefined && typeof d.context !== "string") return null;
  return { requester: d.requester, persona: d.persona, task: d.task, ...(d.context !== undefined ? { context: d.context } : {}) };
}

// The skeleton's in-thread receipt: translators (#243 and its follow-ups)
// replace this with a real spawn.
export function receiptBody(p: DelegationPayload): string {
  return `[factory] received — persona "${p.persona}" queued for translation (#293 skeleton; spawn translators land under #243/#264/#265/#266).`;
}
