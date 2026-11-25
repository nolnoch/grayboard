// The SQLite store as a Slack-contract backend (slack.contract.ts), registered by db.test.ts: the Repo's slack group on
// a fixed clock, with the users rows and raw reads on its connection.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db.ts";
import { scratchDbPath } from "../../../tests/support/scratch_db.ts";
import type { SlackBackend, SlackHarness } from "./slack.contract.ts";
import { sqliteOf } from "./tx.ts";

export const sqliteSlackBackend: SlackBackend = {
  kind: "sqlite",
  async open(): Promise<SlackHarness> {
    let now = 0;
    const { repo } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")), now: () => now });
    return {
      slack: repo.slack,
      write: fn => repo.write(fn),
      read: repo.read,
      setNow: ms => { now = ms; },
      user: email => repo.write(async tx => sqliteOf(tx).query<{ id: number }, [string]>(
        "INSERT INTO users (email, created_at) VALUES (?, 0) RETURNING id").get(email)!.id),
      threadRows: async () => sqliteOf(repo.read).query<Awaited<ReturnType<SlackHarness["threadRows"]>>[number], []>(
        "SELECT user_id, thread_ts, kind, board, root_id, peer, last_id FROM slack_threads ORDER BY user_id, thread_ts").all(),
      progressRows: async () => sqliteOf(repo.read).query<{ user_id: number; ref: string }, []>(
        "SELECT user_id, ref FROM slack_progress ORDER BY user_id, ref").all(),
      close: () => repo.close(),
    };
  },
};
