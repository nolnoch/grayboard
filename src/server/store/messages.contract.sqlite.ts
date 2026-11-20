// The SQLite store as a messages-contract backend (messages.contract.ts), registered by db.test.ts: the Repo's messages
// group on a fixed clock and the contract's attachment caps, with the harness's fixture writes and raw reads on its
// connection.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db.ts";
import { scratchDbPath } from "../../../tests/support/scratch_db.ts";
import { MESSAGE_LIMITS, type MessagesBackend, type MessagesHarness } from "./messages.contract.ts";
import { sqliteOf } from "./tx.ts";

export const sqliteMessagesBackend: MessagesBackend = {
  kind: "sqlite",
  async open(): Promise<MessagesHarness> {
    let now = 0;
    const { repo } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")), now: () => now, attachmentLimits: MESSAGE_LIMITS });
    const run = (sql: string, args: (string | number | null)[]) => repo.write(async tx => { sqliteOf(tx).run(sql, args); });
    const one = <T>(sql: string, args: (string | number | null)[]) => repo.write(async tx => sqliteOf(tx).query<T, (string | number | null)[]>(sql).get(...args)!);
    let blob = 0;
    return {
      messages: repo.messages,
      write: fn => repo.write(fn),
      read: repo.read,
      setNow: ms => { now = ms; },
      upload: (uploader, principal, size) => repo.write(async tx => {
        const db = sqliteOf(tx);
        const sha = `sha-${++blob}`;
        db.run("INSERT INTO attachment_blobs (sha256, size, created_at) VALUES (?, ?, 0)", [sha, size]);
        return db.query<{ id: number }, [string, number, string, string | null]>(
          "INSERT INTO attachments (sha256, filename, type, size, uploader, uploader_principal, created_at) VALUES (?, 'f.txt', 'text/plain', ?, ?, ?, 0) RETURNING id",
        ).get(sha, size, uploader, principal)!.id;
      }),
      cursor: (address, lastSeenId) =>
        run("INSERT INTO mailbox_cursors (address, stream_type, stream_ref, last_seen_id) VALUES (?, 'direct', ?, ?)", [address, address, lastSeenId]),
      post: async (board, scope, author, authorUser) => {
        await run("INSERT OR IGNORE INTO boards (name, purpose, scope, created_by, created_at) VALUES (?, '', ?, ?, 0)", [board, scope, author]);
        return (await one<{ id: number }>("INSERT INTO posts (board, author, body, created_at, author_user) VALUES (?, ?, 'p', 0, ?) RETURNING id", [board, author, authorUser])).id;
      },
      delegation: (target, at, messageId) =>
        run("INSERT INTO access_log (at, actor, action, target, detail) VALUES (?, NULL, 'delegation.requested', ?, ?)", [at, target, JSON.stringify({ message_id: messageId })]),
      bounce: async (sender, recipient, parentId, at) => (await one<{ id: number }>(
        "INSERT INTO messages (sender, recipient_type, recipient, body, parent_id, created_at, kind) VALUES (?, 'user', ?, 'bounced', ?, ?, 'bounce') RETURNING id",
        [sender, recipient, parentId, at])).id,
      humanRows: async () => sqliteOf(repo.read).query<{ id: number; human: number | null }, []>("SELECT id, human FROM messages ORDER BY id").all()
        .map(r => ({ id: r.id, human: r.human === null ? null : r.human === 1 })),
      messageRows: async () => sqliteOf(repo.read).query<{ id: number; parent_id: number | null }, []>("SELECT id, parent_id FROM messages ORDER BY id").all(),
      ackRows: async () => sqliteOf(repo.read).query<{ reader: string; message_id: number }, []>("SELECT reader, message_id FROM dm_acks ORDER BY message_id, reader").all(),
      attachmentRows: async () => sqliteOf(repo.read).query<{ id: number; message_id: number | null }, []>("SELECT id, message_id FROM attachments ORDER BY id").all(),
      audits: async action => sqliteOf(repo.read).query<{ actor: string | null; target: string | null; detail: string | null; detail_type: string | null }, [string]>(
        "SELECT actor, target, detail, json_type(detail) AS detail_type FROM access_log WHERE action = ? ORDER BY id").all(action)
        .map(r => ({ ...r, detail: r.detail === null ? null : JSON.parse(r.detail) })),
      close: () => repo.close(),
    };
  },
};
