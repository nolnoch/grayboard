import { createHash, randomBytes } from "node:crypto";
import type { Principal } from "../core/resolver.ts";
import type { Repo } from "./db.ts";
import type { User } from "./store/identity.ts";
import type { SignedIn } from "./policy.ts";

// The signed-in principal: its users row's id and name (an email, or a service's name), and its kind, read with the
// row (#270 D1). Every check that keys on "a user is a person" reads `kind`.
export type AuthedUser = {
  user_id: number;
  user_email: string;
  kind: "user" | "service";
  session_id: number;
};

// The signed-in principal, as a scope rule (actIn) and a user-keyed verb (admin, team.*) take it: kind from the row.
export const principalOfAuthed = (a: AuthedUser): Principal => ({ kind: a.kind, name: a.user_email });
export const signedIn = (a: AuthedUser): SignedIn => ({ id: a.user_id, email: a.user_email, kind: a.kind });

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

// reauthDue (#930): the IdP last vouched for the user more than `days` ago, so their grants and CLI tokens stop
// working until they sign in again. A user with no clock and no issuer (a dev login) has no IdP to go back to, and
// a service principal never signs in, so both are exempt; an unlinked user keeps its clock, so it isn't.
export function reauthDue(user: Pick<User, "kind" | "idp_issuer" | "idp_checked_at">, now: number, days: number): boolean {
  if (user.kind !== "user" || days <= 0) return false;
  return user.idp_checked_at !== null ? user.idp_checked_at < now - days * 86_400_000 : user.idp_issuer !== null;
}

// idleDays: a token unused that long is refused (security audit F-14); 0 never
// expires one. Use, not age, so an agent that keeps working never loses its token.
// reauthDays: see reauthDue.
export async function verifySessionToken(raw: string, repo: Repo, touches: TouchQueue, idleDays: number, reauthDays: number): Promise<AuthedUser | null> {
  const hash = hashToken(raw);
  const session = await repo.sessions.findByTokenHash(repo.read, hash);
  if (!session) return null;
  const user = await repo.users.findById(repo.read, session.user_id);
  if (session.revoked_at !== null || !user || user.disabled_at !== null) return null;
  if (idleDays > 0 && repo.now() - session.last_used_at > idleDays * 86_400_000) return null;
  if (reauthDue(user, repo.now(), reauthDays)) return null;
  // Off the request path: last-used is a stamp, not a result the caller waits on. Posted, so a touch that fires
  // while another body holds the write queue waits behind it (#807).
  touches.schedule(() => { repo.post(tx => repo.sessions.touch(tx, session.id, repo.now()), undefined, "session touch"); });
  return { user_id: session.user_id, user_email: user!.email, kind: user!.kind, session_id: session.id };
}

export function extractBearer(req: Request): string | null {
  const auth = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  return auth.slice(7).trim() || null;
}
