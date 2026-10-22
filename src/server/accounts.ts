// Which grayboard user a verified sign-in is. The key is the provider's
// subject (auth_links), never the email alone: an IdP may vouch for an
// address it doesn't own, and that mustn't sign in as another provider's user.
import { LoginRefused, PROVIDER_LABEL, type VerifiedLogin } from "./auth.ts";
import { writeAudit } from "./audit.ts";
import type { Repo, User } from "./db.ts";

export type LoginEvent = "login" | "created" | "linked" | "relinked";

// Throws LoginRefused; the caller audits refusals.
export function resolveLogin(repo: Repo, v: VerifiedLogin): { user: User; event: LoginEvent } {
  const idp = PROVIDER_LABEL[v.provider];
  const known = repo.links.find(v.provider, v.subject);
  if (known) {
    const user = repo.users.findById(known.user_id)!;
    // Renaming a user changes every handle; it's an admin operation (#127), not a side effect of login.
    if (user.email !== v.email) {
      throw new LoginRefused(
        `this ${idp} account signs in as ${user.email} but now reports ${v.email}; ask an admin to unlink it (grayboard admin unlink --email ${user.email} --provider ${v.provider})`,
        v.email,
      );
    }
    refuseDisabled(user, v);
    repo.links.touch(v.provider, v.subject, Date.now());
    return { user: repo.users.upsertByEmail(v.email, v.displayName), event: "login" };
  }

  const existing = repo.users.findByEmail(v.email);
  if (!existing) {
    const user = repo.users.upsertByEmail(v.email, v.displayName);
    repo.links.link(user.id, v.provider, v.subject, v.email);
    writeAudit(repo, "auth.linked", v.email, v.email, { provider: v.provider, subject: v.subject, trust: "new_user" });
    return { user, event: "created" };
  }
  refuseDisabled(existing, v);

  const links = repo.links.forUser(existing.id);
  const prior = links.find(l => l.provider === v.provider);
  if (prior) {
    // Same provider, another subject: the domain owner recreated the account.
    if (!v.authoritative) {
      throw new LoginRefused(
        `${v.email} already signs in with a different ${idp} account; ask an admin to unlink it (grayboard admin unlink --email ${v.email} --provider ${v.provider})`,
        v.email,
      );
    }
    repo.links.link(existing.id, v.provider, v.subject, v.email);
    writeAudit(repo, "auth.relinked", v.email, v.email, { provider: v.provider, subject: v.subject, previous: prior.subject });
    return { user: repo.users.upsertByEmail(v.email, v.displayName), event: "relinked" };
  }

  // A provider that doesn't own the address binds it only on the user's
  // first sign-in (trust on first use), so it can't take over an account.
  if (!v.authoritative && links.length > 0) {
    throw new LoginRefused(
      `${idp} doesn't own ${v.email}'s domain, and ${v.email} already signs in with ${links.map(l => l.provider).join(", ")}; ask an admin to unlink it (grayboard admin unlink --email ${v.email})`,
      v.email,
    );
  }
  repo.links.link(existing.id, v.provider, v.subject, v.email);
  writeAudit(repo, "auth.linked", v.email, v.email, {
    provider: v.provider, subject: v.subject, trust: v.authoritative ? "provider" : "first_use",
  });
  return { user: repo.users.upsertByEmail(v.email, v.displayName), event: "linked" };
}

function refuseDisabled(user: User, v: VerifiedLogin): void {
  if (user.disabled_at !== null) throw new LoginRefused(`${user.email} is disabled on this server`, v.email);
}
