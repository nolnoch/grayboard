// The IdP re-check (#930 A2, docs/server-offboarding.md). A user whose sign-in provider can answer a directory
// status query (IdentityProvider.status) is asked again once their IdP clock (users.idp_checked_at) is older than
// recheckHours: blocking on a refresh, in the background on a CLI token's use. An inactive answer disables them as
// admin disable-user does; an active one restamps the clock; anything else is transient and fails open until the
// clock is maxStaleHours old, when a refresh and a CLI token's use both answer 503 instead. A transient answer
// backs the user off for TRANSIENT_BACKOFF_MS: no status call and no audit row until it passes. Every other user stays on the GRAYBOARD_IDP_REAUTH_DAYS
// fallback (reauthDue). Nothing here runs inside a caller's transaction: the IdP call never holds the write queue.
import { reauthDue } from "./auth.ts";
import { writeAudit } from "./audit.ts";
import type { Repo, User } from "./db.ts";
import type { IdentityProvider } from "./idp.ts";
import { atSite } from "./store/queue.ts";

// A status call that hasn't answered by then is transient. Well inside hosted-core's 10 s refresh abort
// (adapters/hosted-core/src/login.ts), which a slow IdP plus a busy write queue must not reach.
export const IDP_STATUS_TIMEOUT_MS = 3_000;
// After a transient answer, how long that user's re-checks answer transient without asking the IdP again.
export const TRANSIENT_BACKOFF_MS = 5 * 60_000;
// Past this many backed-off users, expired entries are swept on the next insert.
const BACKOFF_SWEEP_AT = 1_000;
const HOUR = 3_600_000;
// At most one auth.reauth_required row per user and credential kind in this long (#1558): a client that retries a clock-refused refresh, or
// a CLI loop, writes one row, not one per attempt. Per process, as the other guards are.
export const REAUTH_ROW_MS = HOUR;

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
// What a CLI token's use does: work, 401 (the fallback clock ran out, or the user is now disabled), or answer 503
// temporarily_unavailable with the token untouched.
export type CliVerdict = RefreshVerdict;
type Outcome = "active" | "inactive" | "transient";

type Checked = Pick<User, "id" | "email" | "kind" | "idp_issuer" | "idp_subject" | "idp_checked_at">;

export type IdpRecheck = {
  // Before a refresh's rotation, for the user behind an unspent refresh token (oauth.findRefreshUser).
  beforeRefresh(userId: number): Promise<RefreshVerdict>;
  // On a CLI token's use. With no status provider, the fallback clock decides. A user with one is checked in the
  // background once stale, and the token works meanwhile; past maxStaleHours the check blocks, as a refresh's does:
  // active lets the token through, inactive refuses it, and anything else answers "unavailable", so a directory
  // that stops answering bounds CLI tokens as it bounds refresh without signing anyone out.
  cliVerdict(user: Checked): Promise<CliVerdict>;
  // Inside a refresh's rotation: the fallback, for a user no status provider covers.
  fallbackDue(user: Checked): boolean;
  // After the fallback refused a credential (cliVerdict calls it itself; the refresh path once its rotation has rolled
  // back): audits auth.reauth_required with the user as target, at most once per user and credential per REAUTH_ROW_MS.
  reauthRefused(user: Pick<User, "id" | "email">, credential: "refresh" | "cli", clientId?: string): void;
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
  // userId → when its backoff ends.
  const backoff = new Map<number, number>();
  const disables: number[] = [];
  let tripped = false;
  // "<userId>:<credential>" → when its last auth.reauth_required row was written.
  const reauthRows = new Map<string, number>();

  const providerFor = (u: Checked) => u.kind === "user" && u.idp_issuer !== null && u.idp_subject !== null
    ? providers.find(p => p.status && p.issuer === u.idp_issuer) : undefined;
  // A null clock (a row a release without the column linked) is infinitely old.
  const olderThan = (u: Checked, hours: number) => u.idp_checked_at === null || u.idp_checked_at < now() - hours * HOUR;
  const failed = (p: IdentityProvider, u: Checked, error_class: string) =>
    writeAudit(repo, repo.read, "auth.idp_check_failed", null, u.email, { provider: p.id, error_class, level: "warning" });

  // Disables as admin disable-user does, unless the user changed since the read the check started from: a sign-in
  // meanwhile restamped the clock (the IdP vouched again), or someone else disabled or unlinked them. The re-read
  // locks the row, so on a multi-writer store a sign-in's restamp can't commit between it and the disable.
  async function disable(u: Checked, p: IdentityProvider): Promise<boolean> {
    const done = await atSite("idp", () => repo.write(async tx => {
      const cur = await repo.users.lockById(tx, u.id);
      if (!cur || cur.disabled_at !== null || cur.idp_checked_at !== u.idp_checked_at || cur.idp_issuer !== u.idp_issuer || cur.idp_subject !== u.idp_subject) return null;
      await repo.users.setDisabled(tx, cur.id, true);
      const orphaned = await repo.services.orphanedBy(tx, cur.id);
      writeAudit(repo, tx, "auth.idp_disabled", null, cur.email,
        { provider: p.id, issuer: p.issuer, reason: "inactive", ...(orphaned.length ? { orphaned_services: orphaned } : {}) });
      return cur;
    }, cur => { if (cur) hooks.disconnectUser(cur.id); return cur; }));
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
      await atSite("idp", () => repo.write(tx => repo.users.stampIdpChecked(tx, u.id)));
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
      failed(p, u, "breaker_tripped");
      return "transient";
    }
    // Counted before the write, so concurrent checks of different users can't each pass the limit; uncounted when
    // the disable turned out a no-op.
    disables.push(t);
    if (await disable(u, p)) return "inactive";
    const i = disables.indexOf(t);
    if (i >= 0) disables.splice(i, 1);
    return "active";
  }

  // One status call per user at a time in this process; a second caller shares the first's answer. A user backed
  // off after a transient answer is transient again without a call.
  function check(u: Checked, p: IdentityProvider): Promise<Outcome> {
    const running = inflight.get(u.id);
    if (running) return running;
    const until = backoff.get(u.id);
    if (until !== undefined) {
      if (until > now()) return Promise.resolve("transient");
      backoff.delete(u.id);
    }
    const next = ask(u, p).then(out => {
      if (out !== "transient") return out;
      if (backoff.size >= BACKOFF_SWEEP_AT) { const t = now(); for (const [id, end] of backoff) if (end <= t) backoff.delete(id); }
      backoff.set(u.id, now() + TRANSIENT_BACKOFF_MS);
      return out;
    }).finally(() => inflight.delete(u.id));
    inflight.set(u.id, next);
    return next;
  }

  function reauthRefused(u: Pick<User, "id" | "email">, credential: "refresh" | "cli", clientId?: string): void {
    const t = now(), key = `${u.id}:${credential}`, last = reauthRows.get(key);
    if (last !== undefined && t - last < REAUTH_ROW_MS) return;
    // Re-inserted, so the map stays in write order and the expired entries are a prefix: a re-auth wave (every clock
    // started on one day) sweeps in amortized constant time, not a scan of the map per refusal.
    reauthRows.delete(key);
    for (const [k, at] of reauthRows) { if (t - at < REAUTH_ROW_MS) break; reauthRows.delete(k); }
    reauthRows.set(key, t);
    writeAudit(repo, repo.read, "auth.reauth_required", null, u.email, { credential, ...(clientId ? { client_id: clientId } : {}) });
  }

  return {
    reauthRefused,
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
    async cliVerdict(u) {
      const p = providerFor(u);
      if (!p) {
        if (!reauthDue(u, now(), config.reauthDays)) return "ok";
        reauthRefused(u, "cli");
        return "refuse";
      }
      if (olderThan(u, config.maxStaleHours)) {
        const out = await check(u, p);
        return out === "active" ? "ok" : out === "inactive" ? "refuse" : "unavailable";
      }
      if (olderThan(u, config.recheckHours)) hooks.background("IdP re-check", () => check(u, p));
      return "ok";
    },
    fallbackDue(u) {
      return !providerFor(u) && reauthDue(u, now(), config.reauthDays);
    },
  };
}
