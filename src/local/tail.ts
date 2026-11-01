// `grayboard tail <board>`: a read-only human view of a local board.
//
// Event-driven like any agent: tail is a viewer session (#284 S9), its own
// ID with ids.viewer set, holding a push subscription and listening on its
// ID's wakeup socket, so posters poke it. It never posts, never becomes an
// alias, isn't listed or addressable, and only moves its own cursor. A tail
// killed hard is ended, subscription and all, by the next process to open
// the bus.
import { db, openEnded } from "./db.ts";
import { endLocalSession, registerSession, thisSession } from "./binding.ts";
import { deliverEnded, listenForWakeup } from "./wakeup.ts";
import { idAddress, mintSessionKey } from "../core/bindings.ts";
import { normalizeBoard, subscribe } from "../core/boards.ts";
import type { Post } from "../shared/notifications.ts";
import { CoreError } from "../core/errors.ts";
import { withAttachments } from "../core/attachments.ts";
import { formatAttachmentsMeta } from "../shared/attachments.ts";

function fmt(p: Post): string {
  const t = new Date(p.created_at).toTimeString().slice(0, 8);
  const reply = p.parent_id !== null ? ` ↳${p.parent_id}` : "";
  const body = p.body.replace(/\n/g, "\n    ");
  const files = p.attachments ? `\n    attachments: ${formatAttachmentsMeta(p.attachments)}` : "";
  return `${t} [${p.id}${reply}] ${p.author}: ${body}${files}`;
}

export async function runTail(boardInput: string, backlog: number): Promise<void> {
  await deliverEnded(db, openEnded);
  const board = normalizeBoard(boardInput);
  const handle = idAddress(mintSessionKey());
  registerSession(db, thisSession(handle), { viewer: true });
  // Ending it drops its subscription and pushes with every other trace.
  const end = () => deliverEnded(db, endLocalSession(db, handle));

  try {
    subscribe(db, handle, board, "push");
  } catch (e) {
    if (e instanceof CoreError) {
      console.error(e.message);
      await end();
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

  const shutdown = async () => {
    stopListening();
    await end();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
