// #807 P1b-4d: retention and the claim expiry timer write through the server's write queue (D4). One that starts
// while another body holds the queue waits behind it, instead of opening a transaction beside it.
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db.ts";
import { createApplication } from "./application.ts";
import { runRetention } from "./retention.ts";
import type { Config } from "./config.ts";
import { claim } from "../core/claims.ts";
import { queueFor } from "./store/queue.ts";
import { createBoard, openAccess, setAccess } from "../core/boards.ts";
import { until } from "../../tests/support/until.ts";
import { seed } from "../../tests/support/seed.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "gb-retq-"));
  const opened = openDatabase(join(dir, "db.sqlite"), { blobDir: join(dir, "blobs") });
  setAccess(opened.db, openAccess(opened.db)); // core seeds on a server database opt in to local mode's open Access
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => opened.db.close());
  return opened;
}

function hold(db: object): { release: () => void; done: Promise<void> } {
  let release!: () => void;
  const done = queueFor(db).run(() => new Promise<void>(r => { release = r; }));
  return { release, done };
}
const ticks = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const rows = (db: { query: (s: string) => { all: () => unknown[] } }) => (db.query("SELECT key FROM claims").all() as { key: string }[]).map(r => r.key);

test("#807: retention while another body holds the write queue waits, then prunes", async () => {
  const { db, repo } = setup();
  const m = await seed(repo, async tx => {
    const inserted = await repo.messages.insert(tx, "a@example.com/fe", "user", "b@example.com/be", "old", null);
    db.run("UPDATE messages SET created_at = 0 WHERE id = ?", [inserted.id]);
    return inserted;
  });
  const holder = hold(db);
  const ran = runRetention(repo, { messageRetentionDays: 1, auditRetentionDays: 1 } as Config);
  await ticks();
  expect((await repo.messages.getById(repo.read, m.id))).toBeDefined();
  holder.release();
  await holder.done;
  await ran;
  expect((await repo.messages.getById(repo.read, m.id))).toBeUndefined();
});

// #1207: the application's own timer, whose sweep is `repo.write(tx => sweepClaims(…, repo.now()))`: it waits behind a
// held queue, and its clock is read inside the queued body, after the queue frees (D4), so the expiry it logs is no
// earlier than the release.
test("#807: the application's claim expiry sweep waits behind a body holding the write queue, and reads the clock inside it", async () => {
  const { db, repo } = setup();
  const application = createApplication(repo);
  cleanups.push(() => application.stopExpiry());
  await seed(repo, async tx => {
    await repo.users.upsertByEmail(tx, "a@example.com", null);
    await repo.aliases.create(tx, { scope_kind: "person", scope_ref: "a@example.com", name: "be" }, "a@example.com");
    createBoard(db, "a@example.com/be", "e2e", "test");
    claim(db, "a@example.com/be", "soon", { board: "e2e", ttl_minutes: 0.001 });
  });
  const errors = spyOn(console, "error").mockImplementation(() => {});
  cleanups.push(() => errors.mockRestore());
  const writes = spyOn(repo, "write");
  cleanups.push(() => writes.mockRestore());
  const holder = hold(db);
  application.wake([]);
  await until(() => writes.mock.calls.length > 0, 2000, "the timer's sweep asked for the write queue");
  await ticks();
  // listClaims hides an expired claim: the row itself is what the sweep deletes.
  expect(rows(db)).toEqual(["soon"]);
  const fired = Date.now();
  while (Date.now() <= fired) { /* the next millisecond */ }
  const released = Date.now();
  holder.release();
  await holder.done;
  await until(() => rows(db).length === 0, 2000, "the expired claim was swept");
  const expired = db.query("SELECT at FROM claim_events WHERE event = 'expire'").all() as { at: number }[];
  expect(expired.length).toBe(1);
  expect(expired[0]!.at).toBeGreaterThanOrEqual(released);
  expect(errors.mock.calls.map(c => c.map(String).join(" ")).filter(m => m.includes("claim expiry"))).toEqual([]);
});
