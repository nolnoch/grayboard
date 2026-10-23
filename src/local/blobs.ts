// Local mode's BlobStore: the bytes in the bus's own SQLite file, by the
// content hash attachment_blobs catalogs.
import type { Database } from "bun:sqlite";

import type { BlobStore } from "../core/attachments.ts";
import { BlobMissing } from "../core/errors.ts";

export class SqliteBlobs implements BlobStore {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS attachment_bytes (sha256 TEXT PRIMARY KEY, data BLOB NOT NULL)`);
  }

  async put(sha256: string, data: Uint8Array): Promise<void> {
    this.db.prepare(`INSERT OR REPLACE INTO attachment_bytes (sha256, data) VALUES (?, ?)`).run(sha256, data);
  }

  async get(sha256: string): Promise<Uint8Array> {
    const row = this.db.prepare(`SELECT data FROM attachment_bytes WHERE sha256 = ?`).get(sha256) as { data: Uint8Array } | null;
    if (!row) throw new BlobMissing(sha256);
    return row.data;
  }

  // Other sessions' processes share this file, and their uploads commit the
  // attachment row before putting the bytes: never delete bytes a row names.
  async delete(sha256: string): Promise<void> {
    this.db.prepare(`DELETE FROM attachment_bytes WHERE sha256 = ? AND NOT EXISTS (SELECT 1 FROM attachments WHERE sha256 = ?)`).run(sha256, sha256);
  }
}
