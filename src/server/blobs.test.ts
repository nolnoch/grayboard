import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { releaseUpload, storeAttachment, sweepBlobs, type BlobStore } from "../core/attachments.ts";
import { initCoreSchema } from "../core/schema.ts";
import { sha256Hex } from "../shared/attachments.ts";
import { DiskBlobs } from "./blobs.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gb-blobs-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const bytes = (s: string) => new TextEncoder().encode(s);

test("bytes are files under their sha256's first two digits, private to the server", async () => {
  const blobs = new DiskBlobs(dir);
  const sha = sha256Hex(bytes("hello"));
  await blobs.put(sha, bytes("hello"));
  await blobs.put(sha, bytes("hello"));
  const path = join(dir, sha.slice(0, 2), sha);
  expect(new TextDecoder().decode(await blobs.get(sha))).toBe("hello");
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(readdirSync(join(dir, "tmp"))).toEqual([]);
  await blobs.delete(sha);
  await blobs.delete(sha);
  expect(existsSync(path)).toBe(false);
  await expect(blobs.get(sha)).rejects.toThrow(`attachment bytes ${sha} are missing`);
});

test("a key that isn't a sha256 never becomes a path", async () => {
  const blobs = new DiskBlobs(dir);
  for (const bad of ["../../etc/passwd", "ab", "A".repeat(64)]) {
    await expect(blobs.put(bad, bytes("x"))).rejects.toThrow("not a sha256");
    await expect(blobs.get(bad)).rejects.toThrow("not a sha256");
  }
});

test("temp files a crash left are dropped at startup", () => {
  mkdirSync(join(dir, "tmp"));
  writeFileSync(join(dir, "tmp", "half-written"), "x");
  new DiskBlobs(dir);
  expect(existsSync(join(dir, "tmp"))).toBe(false);
});

test("an upload during a sweep of the same bytes keeps them", async () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT, recipient TEXT)`);
  initCoreSchema(db);
  const disk = new DiskBlobs(dir);
  // A slow disk: without the per-sha256 lock, the upload's put lands while
  // the sweep's delete waits, and the delete then takes the new bytes.
  const slow: BlobStore = {
    put: (s, d) => disk.put(s, d),
    get: (s) => disk.get(s),
    delete: async (s) => {
      await Bun.sleep(30);
      await disk.delete(s);
    },
  };
  const file = { filename: "f.txt", type: "text/plain", data: bytes("again") };
  const first = await storeAttachment(db, slow, "be", file);
  db.prepare(`DELETE FROM attachments WHERE id = ?`).run(first.id);
  const [, again] = await Promise.all([sweepBlobs(db, slow), Bun.sleep(5).then(() => storeAttachment(db, slow, "fe", file))]);
  expect(new TextDecoder().decode(await disk.get(again.sha256))).toBe("again");
  expect(await releaseUpload(db, slow, again.id, "fe")).toMatchObject({ id: again.id });
  await expect(disk.get(again.sha256)).rejects.toThrow("are missing");
});
