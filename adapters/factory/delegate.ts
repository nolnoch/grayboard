// Reading a delegation request off the public message shape (docs/boards.md
// §13): the header line, then the fenced JSON data block. An outside
// orchestrator sees the same bytes, so the module parses them the same way —
// the core's own parser (src/core/delegation.ts) is not part of the module's
// allowlisted surface, and mustn't become one.
//
// The data fence is FOUR backticks (the core builders' choice): a task
// carrying ordinary three-backtick code fences must still parse, so the
// closing-fence search can't stop at a fence inside the task. The builders
// refuse payload text containing the four-backtick marker itself, so the
// block is unambiguous. (#243; parser shape re-homed from the parked PR
// #268's adapter.)
export type DelegationPayload = { requester: string; persona: string; task: string; context?: string };

export const DATA_FENCE = "````";

export function isDelegationBody(body: string): boolean {
  return body.startsWith("[delegation request from ");
}

// The fenced block is DATA by the sender's own contract; a body without a
// well-formed block, or with fields missing or empty, is not a delegation.
export function parseDelegation(body: string): DelegationPayload | null {
  const at = body.indexOf(`\n${DATA_FENCE}json\n`);
  if (at < 0) return null;
  const start = at + 1 + DATA_FENCE.length + "json\n".length;
  const end = body.indexOf(`\n${DATA_FENCE}`, start);
  if (end < 0) return null;
  let data: unknown;
  try {
    data = JSON.parse(body.slice(start, end));
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.requester !== "string" || !d.requester) return null;
  if (typeof d.persona !== "string" || !d.persona) return null;
  if (typeof d.task !== "string" || !d.task) return null;
  if (d.context !== undefined && typeof d.context !== "string") return null;
  return { requester: d.requester, persona: d.persona, task: d.task, ...(d.context !== undefined ? { context: d.context } : {}) };
}

// The skeleton's in-thread receipt, reached when no translator matched the
// persona: the request is answered, and nothing was spawned.
export function receiptBody(p: DelegationPayload): string {
  return `[factory] received — no translator matched persona "${p.persona}" (translators: pi, and per-harness follow-ups #264–#266).`;
}
