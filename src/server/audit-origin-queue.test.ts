// #1042: a write body queued behind another request's async body runs under its own enqueuing request's origin
// (security audit F-19), not the releasing holder's, and a detached caller's under none.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db.ts";
import { detached, inRequest } from "./request_context.ts";
import type { AuditAction } from "./audit.ts";

const cleanups: (() => unknown)[] = [];
afterEach(() => { for (const c of cleanups.splice(0).reverse()) c(); });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "gb-origq-"));
  const opened = openDatabase(join(dir, "db.sqlite"), { blobDir: join(dir, "blobs") });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => opened.db.close());
  return opened;
}

const a = { ip: "203.0.113.1", ua: "a" };
const b = { ip: "203.0.113.2", ua: "b", client_id: "client-b" };
const c = { ip: "203.0.113.3", ua: "c" };

test("#1042: bodies queued behind an async body write their own request's origin, a detached one none", async () => {
  const { db, repo } = setup();
  const row = (action: string) => ({ at: repo.now(), actor: null, action: action as AuditAction, target: null, detail: null });
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  // A holds the queue across an await, as a Postgres-era body will (#807 D4).
  const held = inRequest(a, () => repo.write(async () => { await gate; repo.audit.write(row("t.a")); }));
  // B's committed runs after its commit, still as B's work: its row too carries b.
  const wrote = inRequest(b, () => repo.write(() => { repo.audit.write(row("t.b")); }, () => repo.post(() => { repo.audit.write(row("t.b.committed")); })));
  expect(inRequest(c, () => repo.post(() => { repo.audit.write(row("t.c")); }))).toBe(false);
  expect(detached(() => repo.post(() => { repo.audit.write(row("t.none")); }))).toBe(false);
  release();
  await Promise.all([held, wrote]);
  await repo.write(() => undefined); // the posted bodies ran before this one
  const got = db.query("SELECT action, ip, ua, client_id FROM access_log WHERE action LIKE 't.%' ORDER BY id").all();
  expect(got).toEqual([
    { action: "t.a", ip: a.ip, ua: a.ua, client_id: null },
    { action: "t.b", ip: b.ip, ua: b.ua, client_id: b.client_id },
    { action: "t.b.committed", ip: b.ip, ua: b.ua, client_id: b.client_id },
    { action: "t.c", ip: c.ip, ua: c.ua, client_id: null },
    { action: "t.none", ip: null, ua: null, client_id: null },
  ]);
});
