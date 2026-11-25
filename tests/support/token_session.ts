import type { AuthedUser } from "../../src/server/auth.ts";
import type { Repo } from "../../src/server/db.ts";
import type { Tx } from "../../src/server/store/tx.ts";

let n = 0;

// A WSS hello is refused unless its token session is live (#351), and an
// OAuth principal's authed has none (session_id 0). This gives a test's
// in-process WSS session a sign-in of its own user, written inside a seed()
// body, which holds the write queue: tx is that body's handle.
export async function tokenSessionIn(repo: Repo, tx: Tx, authed: Pick<AuthedUser, "user_id" | "user_email" | "kind">): Promise<AuthedUser> {
  const session = await repo.sessions.create(tx, authed.user_id, `test-token-${process.pid}-${++n}-${Math.random()}`, "test");
  return { user_id: authed.user_id, user_email: authed.user_email, kind: authed.kind, session_id: session.id };
}
