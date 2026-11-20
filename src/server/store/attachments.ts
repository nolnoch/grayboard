// The attachments store's group interface, upload side (#807 P3 C10c, docs/future/postgres-server.md D2): uploads and
// the blob catalog, which Repo (db.ts) composes and the Postgres store (pg/attachments.ts) implements. Messages'
// attachments stay inside the messages store and posts' go with the board writes (pg/attachment_rows.ts on Postgres).
// The row types are core's (src/core/attachments.ts), whose SQL the SQLite store runs. Type-only imports, so a module
// under pg/ may import it (pg/isolation.test.ts); db.ts re-exports the interface.
import type { AttachmentRow, NewUpload, Uploader, UploadQuota } from "../../core/attachments.ts";
import type { Read, Tx } from "./tx_base.ts";

export type { AttachmentRow, NewUpload, Uploader, UploadQuota };

// Uploads and the blob catalog (#807 P3 B3), on the caller's handle. The flows over these (store, release, sweep) are
// the server's (src/server/attachments.ts).
export interface AttachmentsStore {
  get(r: Read, id: number): Promise<AttachmentRow | undefined>;
  // The blob digests of `from`'s unsent uploads `ids`, in call order; rejects with CoreError on an id that isn't one.
  unsentDigests(r: Read, ids: number[], from: Uploader): Promise<string[]>;
  // Deletes `from`'s unsent uploads among `ids`, returning them by id. One that a send has just bound stays.
  dropUnsent(tx: Tx, ids: number[], from: Uploader): Promise<AttachmentRow[]>;
  // Deletes the uploads left unbound since before `olderThanMs`; returns how many. Postgres skips a row a send holds
  // locked to bind it (SKIP LOCKED), so a prune never waits on a send: that row is bound, or left for the next prune.
  pruneUnbound(tx: Tx, olderThanMs: number): Promise<number>;
  // Prunes, checks the quota (rejects with TooLargeError), and inserts the catalog entry, if the blob has none, and the
  // row (core insertUpload). On Postgres the quota check holds the principal's lock (D3), taken first.
  insertUpload(tx: Tx, upload: NewUpload): Promise<{ row: AttachmentRow; pruned: boolean }>;
  remove(tx: Tx, id: number): Promise<void>;
  // The catalog's blobs no attachment names; whether one is named; its entry dropped while unnamed (0 or 1). A drop
  // that meets an upload naming the blob, committed or committing, answers 0 and leaves the entry, never failing the
  // caller's transaction. Bytes are the caller's: one process runs a blob's put and sweep one at a time (core withBlob);
  // across processes that is #808's.
  unnamedBlobs(r: Read): Promise<string[]>;
  named(r: Read, sha256: string): Promise<boolean>;
  dropBlobEntry(tx: Tx, sha256: string): Promise<number>;
}
