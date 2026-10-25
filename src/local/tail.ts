// `grayboard tail <board>`: a read-only human view of a local board.
//
// Event-driven like any agent: tail holds a push subscription under a
// per-process handle and listens on its own wakeup socket, so posters poke it.
// It never posts, never registers in `handles` (so it can't be @mentioned),
// and only moves its own cursor.
import { db } from "./db.ts";
import { listenForWakeup, poke } from "./wakeup.ts";
import { normalizeBoard, subscribe, type Post } from "../core/boards.ts";
import { CoreError } from "../core/errors.ts";
import { withAttachments } from "../core/attachments.ts";
import { formatAttachmentsMeta } from "../shared/attachments.ts";

const PREFIX = "~tail-";

function fmt(p: Post): string {
  const t = new Date(p.created_at).toTimeString().slice(0, 8);
  const reply = p.parent_id !== null ? ` ↳${p.parent_id}` : "";
  const body = p.body.replace(/\n/g, "\n    ");
  const files = p.attachments ? `\n    attachments: ${formatAttachmentsMeta(p.attachments)}` : "";
  return `${t} [${p.id}${reply}] ${p.author}: ${body}${files}`;
}

// A tail that was killed hard leaves a subscription nobody answers. Clear any
// whose socket is dead so outbox rows don't pile up for them.
async function sweepStale(): Promise<void> {
  const rows = db
    .prepare(`SELECT DISTINCT handle FROM subscriptions WHERE handle LIKE ?`)
    .all(`${PREFIX}%`) as { handle: string }[];
  for (const { handle } of rows) {
    if (await poke(handle)) continue;
    db.prepare(`DELETE FROM subscriptions WHERE handle = ?`).run(handle);
    db.prepare(`DELETE FROM outbox WHERE handle = ?`).run(handle);
  }
}

export async function runTail(boardInput: string, backlog: number): Promise<void> {
  const board = normalizeBoard(boardInput);
  const handle = `${PREFIX}${process.pid}`;
  await sweepStale();

  try {
    subscribe(db, handle, board, "push");
  } catch (e) {
    if (e instanceof CoreError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }

  const recent = (
    db
      .prepare(`SELECT * FROM posts WHERE board = ? ORDER BY id DESC LIMIT ?`)
      .all(board, Math.max(backlog, 0)) as Post[]
  ).reverse();
  for (const p of withAttachments(db, "post", recent)) console.log(fmt(p));
  let last = (db.prepare(`SELECT MAX(id) AS id FROM posts WHERE board = ?`).get(board) as {
    id: number | null;
  }).id ?? 0;

  const drain = () => {
    const posts = db
      .prepare(`SELECT * FROM posts WHERE board = ? AND id > ? ORDER BY id ASC`)
      .all(board, last) as Post[];
    for (const p of withAttachments(db, "post", posts)) console.log(fmt(p));
    if (posts.length) last = posts[posts.length - 1]!.id;
    db.prepare(`UPDATE subscriptions SET cursor = ?, notified_id = ? WHERE board = ? AND handle = ?`)
      .run(last, last, board, handle);
    db.prepare(`DELETE FROM outbox WHERE handle = ?`).run(handle);
  };

  const stopListening = listenForWakeup(handle, drain);
  console.error(`-- tailing #${board} (ctrl-c to stop)`);
  drain(); // anything posted between the backlog query and the listener

  const shutdown = () => {
    stopListening();
    db.prepare(`DELETE FROM subscriptions WHERE handle = ?`).run(handle);
    db.prepare(`DELETE FROM outbox WHERE handle = ?`).run(handle);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
