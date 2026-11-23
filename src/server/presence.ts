// A held name's last_seen on a server (#1640, docs/handles.md §3): its holder's last request. A hosted request touches
// its root's hosted_sessions row (throttled, hosted.ts TOUCH_EVERY_MS), never the alias row, which moves at bind,
// unbind, and the holder's end or revocation (stamped with the row's last_seen_at then). So a read takes the later of the alias row's
// and the holder's live row's. No per-request write: the alias row isn't touched on activity.
import type { Repo } from "./db.ts";
import type { Read } from "./store/tx.ts";

// The live hosted rows' last_seen_at, by session ID, of the IDs given (a non-hosted ID has none).
export async function holderSight(repo: Repo, r: Read, ids: Iterable<string>): Promise<Map<string, number>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  return new Map((await repo.hosted.getMany(r, unique)).map((h) => [h.session_id, h.last_seen_at]));
}

// repo.bindings.lastSeen, with a held name's moved up to its holder's last request. The two reads are independent, so
// on Postgres they share one flight with whatever the caller runs beside them (dm_send's, #1537 C6).
export async function lastSeen(repo: Repo, r: Read, handles: string[]): Promise<Map<string, number>> {
  const [seen, sight] = await Promise.all([repo.bindings.lastSeen(r, handles), repo.hosted.heldSight(r, handles)]);
  for (const [address, at] of sight) if (at > (seen.get(address) ?? 0)) seen.set(address, at);
  return seen;
}
