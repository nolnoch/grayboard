// #942: classify a load test's undelivered DMs against its kept database.
// Usage: bun scripts/loadtest_classify.ts <run dir with lost-dms.json> <grayboard.db> (a run with --keep-db, which logs "database kept: <path>")
// absent  = no message row with that body: an acknowledged write was dropped (durability bug).
// unread  = stored, id above the recipient's read point: late (delivery would resume).
// read    = stored, at or below the read point, never receipted by its recipient (delivered_at unset): counted read without the
//           client seeing it (consumed into a void), or a later receipt moved the cursor past it.
// read(receipted) = at or below the read point and receipted (delivered_at set): the client was handed it; a miss is client-side.
// unread(no cursor) = stored, the recipient has no read point: never read, or its alias was removed (which drops the cursor; see aliasRow).
// duplicate = more than one row with that body.
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [runDir, dbPath] = process.argv.slice(2);
if (!runDir || !dbPath) throw new Error("usage: bun scripts/loadtest_classify.ts <run dir> <db>");
const lost: string[] = JSON.parse(readFileSync(join(runDir, "lost-dms.json"), "utf8"));
const db = new Database(dbPath, { readonly: true });
const cols = (db.query("PRAGMA table_info(messages)").all() as { name: string }[]).map(c => c.name);
const pick = ["id", "sender", "recipient", "kind", "pending", "created_at"].concat(cols.includes("delivered_at") ? ["delivered_at"] : []);
const byBody = db.query(`SELECT ${pick.join(", ")} FROM messages WHERE body LIKE ?1`);
const cursor = db.query("SELECT last_seen_id FROM mailbox_cursors WHERE address = ?1 AND stream_type = 'direct' AND stream_ref = ?1");
const alias = db.query("SELECT address FROM aliases WHERE address = ?1");
const counts: Record<string, number> = {};
const samples: Record<string, unknown[]> = {};
const rows: unknown[] = [];
for (const id of lost) {
  const [from, seq] = id.split(":");
  const found = byBody.all(`lt|dm|${from}|${seq}|%`) as Record<string, number | string | null>[];
  let cls: string;
  let detail: Record<string, unknown> = { id };
  if (!found.length) cls = "absent";
  else {
    const m = found[0]!;
    const c = (cursor.get(m.recipient as string) as { last_seen_id: number } | null)?.last_seen_id ?? null;
    const held = !!alias.get(m.recipient as string);
    cls = found.length > 1 ? "duplicate" : c === null ? "unread(no cursor)" : (m.id as number) > c ? "unread" : m.delivered_at == null ? "read" : "read(receipted)";
    detail = { id, ...m, cursor: c, aliasRow: held };
  }
  counts[cls] = (counts[cls] ?? 0) + 1;
  (samples[cls] ??= []).length < 5 && samples[cls]!.push(detail);
  rows.push({ cls, ...detail });
}
console.log(JSON.stringify({ lost: lost.length, counts, samples }, null, 2));
await Bun.write(join(runDir, "classified.json"), JSON.stringify(rows, null, 1));
