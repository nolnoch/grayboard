// #807 P1b-4d: retention and the claim expiry timer write through the server's write queue (D4). One that starts
// while another body holds the queue waits behind it, instead of opening a transaction beside it.
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, queuedTx } from "./db.ts";
import { runRetention } from "./retention.ts";
import type { Config } from "./config.ts";
import { claim, claimExpiryTimer } from "../core/claims.ts";
import { queueFor } from "./store/queue.ts";
import { createBoard } from "../core/boards.ts";
import { until } from "../../tests/support/until.ts";
import { seed } from "../../tests/support/seed.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "gb-retq-"));
  const opened = openDatabase(join(dir, "db.sqlite"), { blobDir: join(dir, "blobs") });
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
  const m = await seed(repo, () => {
    const inserted = repo.messages.insert("a@example.com/fe", "user", "b@example.com/be", "old", null);
    db.run("UPDATE messages SET created_at = 0 WHERE id = ?", [inserted.id]);
    return inserted;
  });
  const holder = hold(db);
  const ran = runRetention(repo, db, { messageRetentionDays: 1, auditRetentionDays: 1 } as Config);
  await ticks();
  expect(repo.messages.getById(m.id)).toBeDefined();
  holder.release();
  await holder.done;
  await ran;
  expect(repo.messages.getById(m.id)).toBeUndefined();
});

test("#807: a server claim expiry timer's sweep waits behind another body holding the write queue", async () => {
  const { db, repo } = setup();
  const woken: string[][] = [];
  const timer = claimExpiryTimer(db, h => { woken.push(h); }, undefined, queuedTx(repo));
  cleanups.push(() => timer.stop());
  await seed(repo, () => {
    repo.users.upsertByEmail("a@example.com", null);
    repo.aliases.create({ scope_kind: "person", scope_ref: "a@example.com", name: "be" }, "a@example.com");
    createBoard(db, "a@example.com/be", "e2e", "test");
    claim(db, "a@example.com/be", "soon", { board: "e2e", ttl_minutes: 0.001 });
  });
  // The old sync sweep would hit the queue's top-level guard and retry 5s later: a failure is a test failure.
  const errors = spyOn(console, "error").mockImplementation(() => {});
  cleanups.push(() => errors.mockRestore());
  const holder = hold(db);
  timer.arm();
  await Bun.sleep(150);
  await ticks();
  // listClaims hides an expired claim: the row itself is what the sweep deletes.
  expect(rows(db)).toEqual(["soon"]);
  holder.release();
  await holder.done;
  await until(() => rows(db).length === 0, 2000, "the expired claim was swept");
  expect(errors.mock.calls.map(c => c.map(String).join(" ")).filter(m => m.includes("claim expiry"))).toEqual([]);
});
