// The IdP re-check (#930 A2, docs/server-offboarding.md). A user whose sign-in provider can answer a directory
// status query (IdentityProvider.status) is asked again once their IdP clock (users.idp_checked_at) is older than
// recheckHours: blocking on a refresh, in the background on a CLI token's use. An inactive answer disables them as
// admin disable-user does; an active one restamps the clock; anything else is transient and fails open until the
// clock is maxStaleHours old, when a refresh answers 503 instead. Every other user stays on the GRAYBOARD_IDP_REAUTH_DAYS
// fallback (reauthDue). Nothing here runs inside a caller's transaction: the IdP call never holds the write queue.
import { reauthDue } from "./auth.ts";
import { writeAudit } from "./audit.ts";
import type { Repo, User } from "./db.ts";
import type { IdentityProvider } from "./idp.ts";

// A status call that hasn't answered by then is transient.
export const IDP_STATUS_TIMEOUT_MS = 5_000;
const HOUR = 3_600_000;

export type RecheckConfig = { recheckHours: number; maxStaleHours: number; disableLimit: number; reauthDays: number };
export type RecheckHooks = {
  // End the user's hosted sessions after the disable commits (application.disconnectUser).
  disconnectUser(userId: number): void;
  // The Slack bridge's re-read of the user, as disable-user's (SlackLinker.userChanged).
  userChanged(userId: number): Promise<void> | void;
  // Run work nobody awaits, tracked so shutdown waits for it (app.ts `background`).
  background(what: string, run: () => Promise<unknown>): void;
};
// What a refresh does: rotate, refuse with invalid_grant (the user is now disabled), or answer 503
// temporarily_unavailable with the refresh token unspent.
export type RefreshVerdict = "ok" | "refuse" | "unavailable";
type Outcome = "active" | "inactive" | "transient";

type Checked = Pick<User, "id" | "email" | "kind" | "idp_issuer" | "idp_subject" | "idp_checked_at">;

export type IdpRecheck = {
  // Before a refresh's rotation, for the user behind an unspent refresh token (oauth.findRefreshUser).
  beforeRefresh(userId: number): Promise<RefreshVerdict>;
  // On a CLI token's use: true refuses it (the fallback clock ran out). A stale user with a status provider is
  // checked in the background instead, and the token works meanwhile.
  cliRefused(user: Checked): boolean;
  // Inside a refresh's rotation: the fallback, for a user no status provider covers.
  fallbackDue(user: Checked): boolean;
};

// now: the clock the refresh path reads (OAuthOptions.now), so the fallback and the rotation agree on the time.
export function createIdpRecheck(
  repo: Repo, providers: readonly IdentityProvider[], config: RecheckConfig, hooks: RecheckHooks, now: () => number = () => Date.now(),
): IdpRecheck {
  // The providers that have answered "active" in this process: a negative counts only after its provider proved,
  // with a positive, that its credential and its subject mapping work (a misconfigured one answering 404 for
  // everyone disables nobody).
  const confirmed = new Set<IdentityProvider>();
  const inflight = new Map<number, Promise<Outcome>>();
  const disables: number[] = [];
  let tripped = false;

  const providerFor = (u: Checked) => u.kind === "user" && u.idp_issuer !== null && u.idp_subject !== null
    ? providers.find(p => p.status && p.issuer === u.idp_issuer) : undefined;
  // A null clock (a row a release without the column linked) is infinitely old.
  const olderThan = (u: Checked, hours: number) => u.idp_checked_at === null || u.idp_checked_at < now() - hours * HOUR;
  const failed = (p: IdentityProvider, u: Checked, error_class: string) =>
    writeAudit(repo, repo.read, "auth.idp_check_failed", null, u.email, { provider: p.id, error_class, level: "warning" });

  // Disables as admin disable-user does, unless the user changed since the read the check started from: a sign-in
  // meanwhile restamped the clock (the IdP vouched again), or someone else disabled or unlinked them.
  async function disable(u: Checked, p: IdentityProvider): Promise<boolean> {
    const done = await repo.write(async tx => {
      const cur = await repo.users.findById(tx, u.id);
      if (!cur || cur.disabled_at !== null || cur.idp_checked_at !== u.idp_checked_at || cur.idp_issuer !== u.idp_issuer || cur.idp_subject !== u.idp_subject) return null;
      await repo.users.setDisabled(tx, cur.id, true);
      const orphaned = await repo.services.orphanedBy(tx, cur.id);
      writeAudit(repo, tx, "auth.idp_disabled", null, cur.email,
        { provider: p.id, issuer: p.issuer, reason: "inactive", ...(orphaned.length ? { orphaned_services: orphaned } : {}) });
      return cur;
    }, cur => { if (cur) hooks.disconnectUser(cur.id); return cur; });
    if (!done) return false;
    try { await hooks.userChanged(done.id); } catch (e) { console.error("[grayboard] IdP disable: Slack user update failed:", e); }
    return true;
  }

  async function ask(u: Checked, p: IdentityProvider): Promise<Outcome> {
    let answer: "active" | "inactive";
    try {
      const signal = AbortSignal.timeout(IDP_STATUS_TIMEOUT_MS);
      answer = await Promise.race([
        p.status!(u.idp_subject!, signal),
        new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true })),
      ]);
    } catch (e) {
      failed(p, u, (e as Error).message === "timeout" ? "timeout" : (e as Error).name || "Error");
      return "transient";
    }
    if (answer === "active") {
      confirmed.add(p);
      await repo.write(tx => repo.users.stampIdpChecked(tx, u.id));
      return "active";
    }
    if (!confirmed.has(p)) { failed(p, u, "unconfirmed_inactive"); return "transient"; }
    const t = now();
    while (disables.length && disables[0]! <= t - HOUR) disables.shift();
    if (tripped || disables.length >= config.disableLimit) {
      if (!tripped) {
        tripped = true;
        writeAudit(repo, repo.read, "auth.idp_recheck_tripped", null, u.email, { provider: p.id, limit: config.disableLimit, level: "error" });
        console.error(`[grayboard] IdP re-check: more than ${config.disableLimit} automatic disables in an hour; automatic disables are off until restart`);
      }
      return "transient";
    }
    // Counted before the write, so concurrent checks of different users can't each pass the limit.
    disables.push(t);
    return await disable(u, p) ? "inactive" : "active";
  }

  // One status call per user at a time in this process; a second caller shares the first's answer.
  function check(u: Checked, p: IdentityProvider): Promise<Outcome> {
    const running = inflight.get(u.id);
    if (running) return running;
    const next = ask(u, p).finally(() => inflight.delete(u.id));
    inflight.set(u.id, next);
    return next;
  }

  return {
    async beforeRefresh(userId) {
      const u = await repo.users.findById(repo.read, userId);
      if (!u) return "ok";
      const p = providerFor(u);
      if (!p || !olderThan(u, config.recheckHours)) return "ok";
      const out = await check(u, p);
      if (out === "inactive") return "refuse";
      if (out === "active") return "ok";
      return olderThan(u, config.maxStaleHours) ? "unavailable" : "ok";
    },
    cliRefused(u) {
      const p = providerFor(u);
      if (!p) return reauthDue(u, now(), config.reauthDays);
      if (olderThan(u, config.recheckHours)) hooks.background("IdP re-check", () => check(u, p));
      return false;
    },
    fallbackDue(u) {
      return !providerFor(u) && reauthDue(u, now(), config.reauthDays);
    },
  };
}
