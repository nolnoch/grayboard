// The server's ID end (src/server/session_end.ts endSessionServer) as the application runs it, for a test that ends a
// session in its own write body: a BoardAccess at `humanReach`, the id.ended row through writeAudit on the body's Tx.
// It wakes no one: the caller's `until` reads the rows.
import type { EndedSession } from "../../src/core/session_end.ts";
import { boardAccess } from "../../src/server/access.ts";
import { writeAudit } from "../../src/server/audit.ts";
import type { Repo } from "../../src/server/db.ts";
import type { HumanReach } from "../../src/server/policy.ts";
import { endSessionServer } from "../../src/server/session_end.ts";
import type { Tx } from "../../src/server/store/tx.ts";

export function endId(repo: Repo, tx: Tx, id: string, why: string, humanReach: HumanReach = "team"): Promise<EndedSession> {
  return endSessionServer(repo, boardAccess(repo, humanReach), tx, id, {
    why, now: Date.now(), audit: async (action, actor, target, detail) => writeAudit(repo, tx, action, actor, target, detail),
  });
}
