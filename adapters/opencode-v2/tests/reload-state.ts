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
