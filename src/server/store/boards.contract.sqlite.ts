// The SQLite store as a boards-contract backend (boards.contract.ts), registered by db.test.ts: the Repo's boards
// group (core's board SQL), with the harness's fixture writes and raw reads on its connection.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db.ts";
import { scratchDbPath } from "../../../tests/support/scratch_db.ts";
import type { BoardsBackend, BoardsHarness } from "./boards.contract.ts";
import { sqliteOf } from "./tx.ts";

type Arg = string | number | null;

export const sqliteBoardsBackend: BoardsBackend = {
  kind: "sqlite",
  async open(): Promise<BoardsHarness> {
    const { repo } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
    const run = (sql: string, args: Arg[]) => repo.write(async tx => { sqliteOf(tx).run(sql, args); });
    const all = <T>(sql: string, args: Arg[] = []) => sqliteOf(repo.read).query<T, Arg[]>(sql).all(...args);
    const bool = (v: number | null) => v === null ? null : v === 1;
    let blob = 0;
    return {
      boards: repo.boards,
      write: fn => repo.write(fn),
      read: repo.read,
      alias: (address, o = {}) => {
        const [ref, name] = [address.slice(0, address.lastIndexOf("/")), address.slice(address.lastIndexOf("/") + 1)];
        return run("INSERT INTO aliases (address, scope_kind, scope_ref, name, human, queue_off, created_at, last_seen) VALUES (?, 'person', ?, ?, ?, ?, 0, ?)",
          [address, ref, name, o.human ? 1 : null, o.queueOff ? 1 : null, o.lastSeen ?? null]);
      },
      session: (id, principal, o = {}) => run("INSERT INTO ids (id, principal, started_at, last_seen, ended_at, viewer, root_id, status, status_at) VALUES (?, ?, 0, 0, ?, ?, ?, ?, ?)",
        [id, principal, o.endedAt ?? null, o.viewer ? 1 : 0, o.rootId ?? null, o.status ?? null, o.status === undefined ? null : 1]),
      hold: (address, id, boundAt) => run("INSERT INTO alias_holds (address, id, bound_at) VALUES (?, ?, ?)", [address, id, boundAt]),
      claim: c => run("INSERT INTO claims (key, holder, note, board, acquired_at, expires_at, holder_user) VALUES (?, ?, 'held', ?, ?, ?, NULL)",
        [c.key, c.holder, c.board, c.at, c.at + 60_000]),
      claimEvent: e => run("INSERT INTO claim_events (key, handle, event, board, at, session_id) VALUES (?, ?, ?, ?, ?, ?)",
        [e.key, e.handle, e.event, e.board, e.at, e.session ?? null]),
      bindingEvent: e => run("INSERT INTO binding_events (session_id, name, event, at) VALUES (?, ?, ?, ?)", [e.session, e.name, e.event, e.at]),
      watch: (key, handle) => run("INSERT INTO claim_watches (key, handle) VALUES (?, ?)", [key, handle]),
      upload: (uploader, principal, size) => repo.write(async tx => {
        const db = sqliteOf(tx);
        const sha = `sha-${++blob}`;
        db.run("INSERT INTO attachment_blobs (sha256, size, created_at) VALUES (?, ?, 0)", [sha, size]);
        return db.query<{ id: number }, Arg[]>(
          "INSERT INTO attachments (sha256, filename, type, size, uploader, uploader_principal, created_at) VALUES (?, 'f.txt', 'text/plain', ?, ?, ?, 0) RETURNING id",
        ).get(sha, size, uploader, principal)!.id;
      }),
      subscription: async (board, handle) => all<{ mode: string; cursor: number; notified_id: number }>(
        "SELECT mode, cursor, notified_id FROM subscriptions WHERE board = ? AND handle = ?", [board, handle])[0],
      outboxRows: async () => all<{ handle: string; post_id: number; reason: string; wake: number; delivered: number }>(
        "SELECT handle, post_id, reason, wake, delivered_at IS NOT NULL AS delivered FROM outbox ORDER BY post_id, handle")
        .map(r => ({ ...r, wake: r.wake === 1, delivered: r.delivered === 1 })),
      muteRows: async () => all("SELECT handle, root_id FROM thread_mutes ORDER BY handle, root_id"),
      postRow: async id => all<{ parent_id: number | null; human: number | null }>("SELECT parent_id, human FROM posts WHERE id = ?", [id])
        .map(r => ({ parent_id: r.parent_id, human: bool(r.human) }))[0],
      claimRows: async () => all("SELECT key, holder, note, board, acquired_at, expires_at, holder_user FROM claims ORDER BY key"),
      eventRows: async () => all("SELECT key, handle, event, note, board, at FROM claim_events ORDER BY id"),
      watchRows: async () => all("SELECT key, handle FROM claim_watches ORDER BY key, handle"),
      holdRows: async () => all("SELECT address, id FROM alias_holds ORDER BY address"),
      bindingEventRows: async () => all("SELECT name, event, at FROM binding_events ORDER BY id"),
      attachmentRows: async () => all("SELECT id, post_id FROM attachments ORDER BY id"),
      close: () => repo.close(),
    };
  },
};
