import assert from "node:assert/strict";
import { Database } from "bun:sqlite";

export function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

export async function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]); }
  finally { clearTimeout(timer); }
}

export function sessionStates(path: string) {
  const db = new Database(path, { readonly: true });
  try { return db.query("SELECT id, time_suspended FROM session_v2 ORDER BY id").all() as { id: string; time_suspended: number | null }[]; }
  finally { db.close(); }
}

// Enumerate the owned database, including children, siblings and archived sessions; no list-page defaults.
export async function drainSessions(path: string, wait: (id: string) => Promise<unknown>, exclude?: string) {
  for (let pass = 0; pass < 20; pass++) {
    const before = sessionStates(path).filter(s => s.id !== exclude);
    for (const s of before) await wait(s.id);
    const after = sessionStates(path).filter(s => s.id !== exclude);
    if (JSON.stringify(before.map(s => s.id)) !== JSON.stringify(after.map(s => s.id))) continue;
    assert(after.every(s => s.time_suspended === null), "Every globally counted session must be unsuspended after actual wait");
    return after.map(s => s.id);
  }
  throw new Error("Owned session enumeration did not settle");
}

export function assertStable(path: string, input: { id?: string | null; sessionID: string; text: string; metadata?: unknown }) {
  assert(input.id);
  const db = new Database(path, { readonly: true });
  try {
    const rows = db.query("SELECT session_id, type, data FROM session_message WHERE id = ?").all(input.id) as { session_id: string; type: string; data: string }[];
    assert.equal(rows.length, 1, "Stable payload exists globally exactly once");
    assert.equal(rows[0]!.session_id, input.sessionID);
    assert.equal(rows[0]!.type, "synthetic");
    const data = JSON.parse(rows[0]!.data);
    assert.equal(data.text, input.text); assert.deepEqual(data.metadata, input.metadata);
    assert.equal((db.query("SELECT count(*) AS n FROM session_inbox WHERE id = ?").get(input.id) as { n: number }).n, 0, "No pending copy of the stable payload");
  } finally { db.close(); }
}

// These contracts validate fixture files, not SDK authority or production input.
type SavedInput = { sessionID: string; id: string; text: string; delivery: "queue"; resume: boolean; metadata: { source: "grayboard" } };
type CommonBootstrap = { pid: number; location: { directory: string }; expectedRoots: Set<string> };
export type WorkerBootstrap = CommonBootstrap & (
  { kind: "hold"; mode: "hold-before" | "hold-after"; sessionID: string } |
  { kind: "replay"; mode: "replay" | "suspended-resume"; input: SavedInput; digestInput?: SavedInput; settled?: boolean; uncommitted?: boolean }
);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function rootID(value: unknown): asserts value is string {
  assert(typeof value === "string" && /^ses_[a-zA-Z0-9]+$/.test(value), "Fixture requires an exact SDK session ID");
}
export function savedInput(value: unknown): asserts value is SavedInput {
  assert(record(value), "Fixture requires a complete saved input");
  rootID(value.sessionID);
  assert(typeof value.id === "string" && /^msg_[a-zA-Z0-9_]+$/.test(value.id), "Fixture requires a stable SDK message ID");
  assert(typeof value.text === "string" && value.text.length > 0, "Fixture requires the original payload text");
  assert.equal(value.delivery, "queue"); assert.equal(typeof value.resume, "boolean");
  assert(record(value.metadata) && value.metadata.source === "grayboard", "Fixture requires original delivery metadata");
  // The saved handoff must survive JSON serialization without changing the input.
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value, "Saved input must be losslessly serializable");
}
export function workerBootstrap(mode: unknown, value: unknown): WorkerBootstrap {
  assert(mode === "hold-before" || mode === "hold-after" || mode === "replay" || mode === "suspended-resume", "Unsupported worker mode");
  assert(record(value), "Missing worker bootstrap");
  assert(Number.isSafeInteger(value.pid) && (value.pid as number) > 0, "Missing parent PID");
  assert(record(value.location) && typeof value.location.directory === "string" && value.location.directory.startsWith("/"), "Missing fixture location");
  const common = { pid: value.pid as number, location: { directory: value.location.directory } };
  if (mode === "hold-before" || mode === "hold-after") {
    rootID(value.sessionID);
    assert(!("input" in value) && !("digestInput" in value) && !("settled" in value) && !("uncommitted" in value), "Hold bootstrap must precede delivery input");
    return { ...common, kind: "hold", mode, sessionID: value.sessionID, expectedRoots: new Set([value.sessionID]) };
  }
  savedInput(value.input); assert.equal(value.input.resume, true, "Action input must be actionable");
  if ("sessionID" in value) assert.equal(value.sessionID, value.input.sessionID, "Extra root contradicts action input");
  if ("digestInput" in value) {
    savedInput(value.digestInput); assert.equal(value.digestInput.resume, false, "Digest must remain idle");
    assert.notEqual(value.digestInput.id, value.input.id, "Action and digest identities must differ");
  }
  for (const flag of ["settled", "uncommitted"]) if (flag in value) assert.equal(typeof value[flag], "boolean");
  assert(!(value.settled && value.uncommitted), "Settled input cannot be uncommitted");
  assert(mode !== "suspended-resume" || (!value.settled && !value.uncommitted), "Suspended replay has its own completion contract");
  const digestInput = value.digestInput as SavedInput | undefined;
  return { ...common, kind: "replay", mode, input: value.input, digestInput, settled: value.settled as boolean | undefined, uncommitted: value.uncommitted as boolean | undefined,
    expectedRoots: new Set([value.input.sessionID, ...(digestInput ? [digestInput.sessionID] : [])]) };
}
export function heldInput(bootstrap: WorkerBootstrap, input: unknown) {
  assert.equal(bootstrap.kind, "hold"); savedInput(input);
  assert(bootstrap.kind === "hold"); assert.equal(input.sessionID, bootstrap.sessionID, "Captured hold input belongs to the exact bootstrap root");
  assert.equal(input.resume, true, "Crash hold requires the actual action input");
  return input;
}
export function committedRoots(expected: ReadonlySet<string>, committed: ReadonlySet<string>) {
  assert(expected.size > 0, "Receipt roots cannot be empty");
  return [...expected].every(id => committed.has(id));
}
