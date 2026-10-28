import type { AuthedUser } from "../../src/server/auth.ts";
import type { Repo } from "../../src/server/db.ts";

let n = 0;

// A WSS hello is refused unless its token session is live (#351), and an
// OAuth principal's authed has none (session_id 0). This gives a test's
// in-process WSS session a sign-in of its own user.
export function tokenSession(repo: Repo, authed: Pick<AuthedUser, "user_id" | "user_email">): AuthedUser {
  const session = repo.sessions.create(authed.user_id, `test-token-${process.pid}-${++n}-${Math.random()}`, "test");
  return { user_id: authed.user_id, user_email: authed.user_email, session_id: session.id };
}
