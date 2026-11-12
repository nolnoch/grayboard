// Reading a delegation request off the public message shape (boards.md §13):
// the header line, then the four-backtick fenced JSON block the core builds
// (src/core/delegation.ts delegationBody). The core's parser isn't on the
// module's allowlist, so the module reads the bytes as an outside
// orchestrator would. Four backticks: a task carrying ordinary code fences
// still parses, and the core refuses payload text containing the marker.
// (Parser shape from PR #313, re-homed from #268.)
import type { Delivery } from "./bus.ts";

export type DelegationPayload = { requester: string; persona: string; task: string; context?: string };
// Where a request came from, which is also where its replies go: a DM
// (replies to its sender, in its thread) or a board post (replies in the
// post's thread). DM and post ids are separate sequences, so a request is
// keyed by (source, id), never id alone.
export type Route = { source: "dm" } | { source: "board"; board: string };
export type Key = { source: Route["source"]; id: number };
export type Request = DelegationPayload & { id: number } & Route;

export const DATA_FENCE = "````";
const HEADER = "[delegation request from ";

export function parseDelegation(body: string): DelegationPayload | null {
  if (!body.startsWith(HEADER)) return null;
  const at = body.indexOf(`\n${DATA_FENCE}json\n`);
  if (at < 0) return null;
  const start = at + 1 + DATA_FENCE.length + "json\n".length;
  const end = body.indexOf(`\n${DATA_FENCE}`, start);
  if (end < 0) return null;
  let data: unknown;
  try { data = JSON.parse(body.slice(start, end)); } catch { return null; }
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  const ok = (v: unknown) => typeof v === "string" && v.trim() !== "";
  if (!ok(d.requester) || !ok(d.persona) || !ok(d.task)) return null;
  if (d.context !== undefined && typeof d.context !== "string") return null;
  return { requester: d.requester as string, persona: d.persona as string, task: d.task as string, ...(d.context !== undefined ? { context: d.context as string } : {}) };
}

// Request authority (docs/factory.md §4): the header and payload are
// text anyone can write, so a delivery is a request only when the channel
// sender IS the payload's requester. Anything else gets no answer, so the
// module can't be made to send text to a third party.
export type Verdict = { request: Request } | { ignored: string } | null;

export function requestOf(d: Delivery): Verdict {
  if (d.kind !== "dm") return null;
  const p = parseDelegation(d.body);
  if (!p) return null;
  if (p.requester !== d.from) return { ignored: `message ${d.id}: payload names requester ${JSON.stringify(p.requester)} but was sent by ${d.from}` };
  return { request: { ...p, id: d.id, source: "dm" } };
}

// One line: a persona inside a reply must not forge reply lines.
export const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();
