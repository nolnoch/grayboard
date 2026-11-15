// #807 P1b-4c: the CLI's HTTP routes and the session touch write through the server's write queue (D4). A request
// that arrives while another body holds the queue waits behind it, instead of opening a transaction beside it.
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db.ts";
import { createTouchQueue, hashToken, verifySessionToken } from "./auth.ts";
import { queueFor } from "./store/queue.ts";
import { TestServer } from "../../tests/support/server.ts";
import { until } from "../../tests/support/until.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

function hold(db: object): { release: () => void; done: Promise<void> } {
  let release!: () => void;
  const done = queueFor(db).run(() => new Promise<void>(r => { release = r; }));
  return { release, done };
}

test("#807: a session touch that fires while another body holds the write queue waits behind it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-touch-"));
  const { db, repo } = openDatabase(join(dir, "db.sqlite"), { blobDir: join(dir, "blobs") });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => db.close());
  const touches = createTouchQueue();
  cleanups.push(() => touches.cancelAll());
  const session = repo.writeNow(() => {
    const user = repo.users.upsertByEmail("you@example.com", null);
    return repo.sessions.create(user.id, hashToken("raw-token"), "test");
  });
  const before = repo.sessions.findById(session.id)!.last_used_at;
  const lastUsed = () => repo.sessions.findById(session.id)!.last_used_at;
  const touched = spyOn(repo.sessions, "touch");
  const holder = hold(db);
  expect(verifySessionToken("raw-token", repo, touches, 0)).not.toBeNull();
  await new Promise(r => setImmediate(r)); // the scheduled touch fires
  await new Promise(r => setImmediate(r));
  expect(touched).not.toHaveBeenCalled();
  holder.release();
  await holder.done;
  await until(() => touched.mock.calls.length > 0, 5000, "the touch ran after the holder released");
  expect(lastUsed()).toBeGreaterThanOrEqual(before);
  touched.mockRestore();
});

test("#807: a team route that arrives while another body holds the write queue waits, then writes in its own transaction", async () => {
  const srv = new TestServer();
  cleanups.push(() => srv.stop());
  const token = await srv.login("you@example.com");
  const write = spyOn(srv.app.repo, "write");
  const holder = hold(srv.app.db);
  const created = srv.api(token, "POST", "/api/teams", { name: "core" });
  await until(() => write.mock.calls.length > 0, 5000, "the team route reached the write queue");
  expect(srv.app.repo.teams.findByName("core")).toBeFalsy();
  holder.release();
  await holder.done;
  expect(await created).toMatchObject({ status: 201, body: { name: "core" } });
  expect(srv.app.repo.teams.findByName("core")).toBeTruthy();
  write.mockRestore();
});
