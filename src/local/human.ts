// `grayboard human` and `grayboard announce`: the human's own commands on the
// local bus. They run in the human's terminal (or as `! grayboard announce …`
// inside a session), never through an agent's tools.
import { db } from "./db.ts";
import { poke } from "./wakeup.ts";
import { ANNOUNCE_BOARD, CoreError, declareHuman, humanHandles, isViewer, post, rosterHandles } from "../core/boards.ts";
import { isValidIdentityName } from "../shared/addressing.ts";

const MAX_TTL_MS = 7 * 86_400_000;

/** "45m", "2h", "3d" → milliseconds; at most 7 days. */
export function parseTtl(text: string): number {
  const m = /^(\d+)\s*([mhd])$/i.exec(text.trim());
  const ms = m ? Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]!.toLowerCase() as "m" | "h" | "d"] : 0;
  if (!(ms > 0) || ms > MAX_TTL_MS) throw new CoreError(`--ttl must be like 45m, 2h or 3d, at most 7d; got "${text}"`);
  return ms;
}

/** Show the declared human handle, or declare `handle` as it. */
export function runHuman(handle?: string): void {
  if (handle === undefined) {
    const humans = humanHandles(db);
    console.log(humans.length ? humans.join("\n") : "No human handle declared. Declare yours: grayboard human <handle>");
    return;
  }
  const h = handle.toLowerCase();
  if (!isValidIdentityName(h)) throw new CoreError(`invalid handle "${handle}": 1–32 chars, a-z 0-9 _ -`);
  declareHuman(db, h);
  console.log(`"${h}" is the human handle. Agent sessions can no longer use it; the Slack bridge and grayboard announce speak as it.`);
}

/** The declared human, for commands that speak as it. */
export function declaredHuman(): string {
  const humans = humanHandles(db);
  if (humans.length === 0) throw new CoreError("no human handle declared; run: grayboard human <handle>");
  return humans[0]!;
}

/** Post an announcement as the human to every live session. */
export async function runAnnounce(body: string, ttl?: string): Promise<void> {
  const human = declaredHuman();
  const ttl_ms = ttl === undefined ? undefined : parseTtl(ttl);
  // Probing a socket also wakes its session; it drains nothing until the post lands.
  const others = rosterHandles(db).filter((h) => h !== human && !isViewer(h));
  const alive = await Promise.all(others.map((h) => poke(h)));
  const live = new Set(others.filter((_, i) => alive[i]));
  const r = post(db, human, ANNOUNCE_BOARD, body, null, { online: (h) => live.has(h), ttl_ms });
  await Promise.all(r.wake.map((h) => poke(h)));
  const reached = r.wake.filter((h) => !isViewer(h));
  console.log(
    reached.length
      ? `#${ANNOUNCE_BOARD} post ${r.post.id} reached: ${reached.join(", ")}`
      : `#${ANNOUNCE_BOARD} post ${r.post.id}: no live sessions to reach`,
  );
  if (r.post.expires_at) console.log(`New sessions see it until ${new Date(r.post.expires_at).toLocaleString()}.`);
}
