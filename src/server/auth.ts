import { createHash, randomBytes } from "node:crypto";
import type { Repo, User } from "./db.ts";
import { writeAudit } from "./audit.ts";
import type { GoogleIdentity } from "./idp_google.ts";

export type AuthedUser = {
  user_id: number;
  user_email: string;
  session_id: number;
};

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function mintToken(): string {
  return `gbrd_v1_${randomBytes(32).toString("base64url")}`;
}

// The deferred last-used touch below outlives the request that scheduled it.
// A touch that fires after stop() closed the database would be an unhandled
// crash (the CI failure this fixes), so stop() cancels what is pending. The
// queue is per-server: one startServer's stop() must not cancel a different
// live server's touches in the same process (two TestServers in one test run).
// cancelAll also closes the queue: a request still in flight when stop() runs
// (one awaiting the OAuth handler, say) can verify a token after the cancel,
// and its touch must not run against the closed database either (#385).
export type TouchQueue = {
  schedule(run: () => void): void;
  cancelAll(): void;
};

export function createTouchQueue(): TouchQueue {
  const pending = new Set<NodeJS.Immediate>();
  let closed = false;
  return {
    schedule(run: () => void): void {
      if (closed) return;
      const t = setImmediate(() => {
        pending.delete(t);
        run();
      });
      pending.add(t);
    },
    cancelAll(): void {
      closed = true;
      for (const t of pending) clearImmediate(t);
      pending.clear();
    },
  };
}

// idleDays: a token unused that long is refused (security audit F-14); 0 never
// expires one. Use, not age, so an agent that keeps working never loses its token.
export function verifySessionToken(raw: string, repo: Repo, touches: TouchQueue, idleDays: number): AuthedUser | null {
  const hash = hashToken(raw);
  const session = repo.sessions.findByTokenHash(hash);
  if (!session) return null;
  const user = repo.users.findById(session.user_id);
  if (session.revoked_at !== null || !user || user.disabled_at !== null) return null;
  if (idleDays > 0 && repo.now() - session.last_used_at > idleDays * 86_400_000) return null;
  // Off the request path: last-used is a stamp, not a result the caller waits on. Posted, so a touch that fires
  // while another body holds the write queue waits behind it (#807).
  touches.schedule(() => { repo.post(() => repo.sessions.touch(session.id, repo.now()), undefined, "session touch"); });
  return { user_id: session.user_id, user_email: user!.email, session_id: session.id };
}

// Resolves a Google sign-in to its user, subject first (security audit F-13),
// and audits a first link or a refusal. A refusal's text tells the person
// signing in what an admin can do; `detail` joins each audit row.
export function googleSignIn(repo: Repo, identity: GoogleIdentity, detail: Record<string, unknown> = {}): { user: User } | { refused: string } {
  const r = repo.users.signIn(identity.email, identity.subject, identity.displayName);
  if (r.status === "subject_mismatch") {
    writeAudit(repo, "auth.subject_refused", identity.email, null, { reason: r.status, ...detail });
    return { refused: `${identity.email} is linked to a different Google account. If this account should have it, an admin runs grayboard admin unlink-idp --email ${identity.email}` };
  }
  if (r.status === "email_changed") {
    writeAudit(repo, "auth.subject_refused", r.user.email, null, { reason: r.status, email: identity.email, ...detail });
    return { refused: `this Google account belongs to grayboard user ${r.user.email} but now reports ${identity.email}. To sign in as ${identity.email} (a new account), an admin runs grayboard admin unlink-idp --email ${r.user.email}` };
  }
  if (r.status === "ok" && r.linked) writeAudit(repo, "auth.subject_linked", r.user.email, null, detail);
  return { user: r.user };
}

export function extractBearer(req: Request): string | null {
  const auth = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  return auth.slice(7).trim() || null;
}
