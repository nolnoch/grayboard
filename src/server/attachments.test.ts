import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db.ts";
import { storeUpload } from "./attachments.ts";
import { checkFile } from "../shared/attachments.ts";

// Guarded callers must not turn cleanup persistence failures into auth refusals.
test("guarded upload cleanup errors propagate instead of returning the refusal", async () => {
  const blobDir = mkdtempSync(join(tmpdir(), "gb-upload-guard-"));
  const { db, repo } = openDatabase(":memory:", { blobDir });
  const blobs = new Map<string, Uint8Array>();
  repo.blobs.put = async (hash, data) => { blobs.set(hash, data); };
  repo.blobs.delete = async hash => { blobs.delete(hash); };
  const refusal = new Error("refused");
  try {
    db.exec("CREATE TRIGGER fail_release BEFORE DELETE ON attachments BEGIN SELECT RAISE(ABORT, 'cleanup failed'); END");
    let checks = 0;
    await expect(storeUpload(repo, db, "alice@example.com", "alice@example.com/be", checkFile("file report.txt", "report.txt", new TextEncoder().encode("file")), {}, () => { if (++checks > 1) throw refusal; })).rejects.toThrow("cleanup failed");
    expect((db.query("SELECT COUNT(*) AS n FROM attachments").get() as { n: number }).n).toBe(1);
  } finally { db.close(); rmSync(blobDir, { recursive: true, force: true }); }
});
