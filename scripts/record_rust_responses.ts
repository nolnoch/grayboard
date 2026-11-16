// Records one real result per native tool from an in-process server into
// sdk/rust/schema/responses/<tool>.json: the raw CallToolResult hosted MCP
// answers, as the Rust SDK reads it. No tool declares an outputSchema, so these
// are the Rust response structs' only contract: the crate's test
// `every_recorded_response_reads` deserializes each through its typed reader,
// and tests/integration/rust_responses.test.ts re-records under `bun test` and
// fails when a committed copy drifts (#929; docs/sdk-rust.md §3). Values that
// vary per run are replaced with stand-ins of the same type (`normalizer`),
// so drift means a changed shape or text.
//
//   bun scripts/record_rust_responses.ts          rewrite the fixtures
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TestServer } from "../tests/support/server.ts";

export const RESPONSES_DIR = join(import.meta.dir, "../sdk/rust/schema/responses");

export type Recorded = Record<string, unknown>;

const EMAIL = "you@example.com";
const ISO_TIME = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g;
const SESSION_ID = /id:[0-9a-z]{13}/g;
// A fixed epoch-ms stand-in: still a number, so the Rust readers see the type the server sends.
const EPOCH_MS = 1_700_000_000_000;

// What varies per run becomes a stable stand-in of the same JSON type: wall-clock times (ISO text or epoch ms),
// session IDs (numbered by first appearance, as `id:#n`, which SESSION_ID can't match again) and the server's
// version. bind's and unbind's instruction lines and prose are the server's instruction text, which edits move
// freely: each string line becomes a placeholder (anything else is walked, so a line turned object is drift) and
// the prose one placeholder, so only their shape is pinned. Each value is walked once.
function normalizer() {
  const ids = new Map<string, string>();
  const id = (raw: string) => {
    if (!ids.has(raw)) ids.set(raw, `id:#${ids.size + 1}`);
    return ids.get(raw)!;
  };
  const walk = (value: unknown, key?: string): unknown => {
    if (typeof value === "string") return key === "version" ? "<version>" : value.replace(ISO_TIME, "<time>").replace(SESSION_ID, id);
    if (typeof value === "number") return value > 1_000_000_000_000 ? EPOCH_MS : value;
    if (Array.isArray(value) && key === "instructions") {
      // A run of string lines is one placeholder, so adding an instruction sentence isn't drift but a line's type changing is.
      const lines = value.map((v) => (typeof v === "string" ? "<instruction>" : walk(v)));
      return lines.filter((v, i) => !(v === "<instruction>" && lines[i - 1] === "<instruction>"));
    }
    if (Array.isArray(value)) return value.map((v) => walk(v));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k)]));
    return value;
  };
  // Text blocks are walked here, not by walk(result): a JSON text as its value, other text as a string.
  const text = (tool: string, t: string) => (tool === "bind" || tool === "unbind" ? "<prose>" : jsonText(t, walk));
  return (tool: string, result: { content?: { type: string; text?: string }[] }) => {
    const block = (b: { type: string; text?: string }) =>
      Object.fromEntries(Object.entries(b).map(([k, v]) => [k, k === "text" && b.type === "text" && typeof v === "string" ? text(tool, v) : walk(v, k)]));
    return Object.fromEntries(Object.entries(result).map(([k, v]) => [k, k === "content" && Array.isArray(v) ? v.map(block) : walk(v, k)]));
  };
}

// A text block that is a JSON value (the server's JSON.stringify(_, null, 2)) is normalized as a value and written back the same way.
function jsonText(text: string, walk: (v: unknown) => unknown): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return walk(text) as string;
  }
  return parsed !== null && typeof parsed === "object" ? JSON.stringify(walk(parsed), null, 2) : (walk(text) as string);
}

export async function recordResponses(): Promise<Recorded> {
  const srv = new TestServer({ hostedRequestLimit: { burst: 10_000, perSec: 10_000 } });
  const out: Recorded = {};
  try {
    const a = await srv.hosted(EMAIL, null, { sessionId: "rec-session-a" });
    const b = await srv.hosted(EMAIL, "rec-b", { sessionId: "rec-session-b" });
    const launcher = await srv.connected(await srv.login(EMAIL), "rec-launcher", { launcher: true });
    const normalize = normalizer();
    const rec = async (tool: string, args: Record<string, unknown>, session = a) => {
      const result = await session.callRaw(tool, args);
      if (result.isError) throw new Error(`${tool} refused: ${JSON.stringify(result.content)}`);
      out[tool] = { arguments: args, result: normalize(tool, result) };
      return result;
    };
    await rec("bind", { name: "rec-a", create: true });
    await rec("whoami", {});
    await rec("peer_status", { text: "recording" });
    await rec("peer_list", {});
    await rec("board_create", { name: "rec", purpose: "recorded responses" });
    await rec("board_list", {});
    await rec("board_subscribe", { board: "rec", mode: "push" });
    await rec("board_post", { board: "rec", body: "a post" });
    await rec("board_read", { board: "rec" });
    await a.call("board_create", { name: "rec-old", purpose: "archived" });
    await rec("board_archive", { board: "rec-old" });
    await rec("claim_take", { key: "ticket:ENG-142", note: "recording", board: "rec" });
    await rec("claim_list", {});
    await rec("claim_watch", { key: "ticket:ENG-142" }, b);
    await rec("claim_release", { key: "ticket:ENG-142" });
    await rec("dm_send", { to: `${EMAIL}/rec-b`, body: "a message" });
    await rec("dm_inbox", {}, b);
    await rec("dm_history", { peer: `${EMAIL}/rec-b` });
    await rec("dm_thread", { thread: 1 }, b);
    await rec("dm_ack", { message_id: 1 }, b);
    await b.end();
    const second = await a.call<{ message_id: number }>("dm_send", { to: `${EMAIL}/rec-b`, body: "retracted" });
    await rec("dm_retract", { message_id: second.message_id });
    await rec("delegate", { persona: "reviewer", task: "review the recording", to: `${EMAIL}/rec-launcher` });
    await rec("unbind", { name: "rec-a" });
    return out;
  } finally {
    await srv.stop();
  }
}

export const serialize = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

if (import.meta.main) {
  const recorded = await recordResponses();
  rmSync(RESPONSES_DIR, { recursive: true, force: true });
  mkdirSync(RESPONSES_DIR, { recursive: true });
  for (const [tool, value] of Object.entries(recorded)) writeFileSync(join(RESPONSES_DIR, `${tool}.json`), serialize(value));
  console.log(`wrote ${readdirSync(RESPONSES_DIR).length} files to ${RESPONSES_DIR}`);
  process.exit(0);
}
