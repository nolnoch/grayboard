// The authorization seam. All message sends route through here.
import { HUMAN_NAME } from "../shared/addressing.ts";
import type { Repo } from "./db.ts";

// Who besides you can reach your human (your phone, through the Slack
// bridge): people who share a team with you, or everyone signed in.
export type HumanReach = "team" | "all";

export type SendContext = {
  db: Repo;
  now: number;
  humanReach: HumanReach;
};

export type SendPrincipal = {
  user_id: number;
  user_email: string;
  identity_id: number;
  identity_name: string;
  identity_full: string;
};

export type SendTarget = { kind: "user"; address: string };

export type SendDecision =
  | { allow: true }
  | { allow: false; code: "forbidden" | "not_found"; reason: string };

export function canSend(
  sender: SendPrincipal,
  target: SendTarget,
  ctx: SendContext,
): SendDecision {
  // Future policy lives here. Do not add caller-side bypasses.
  if (!reachesHuman(ctx.db, ctx.humanReach, sender.user_email, target.address)) {
    return { allow: false, code: "forbidden", reason: `${target.address} is a person's phone, reachable only by their teammates' agents` };
  }
  return { allow: true };
}

// Whether a handle owned by fromEmail may wake `to` when `to` is a human. Your
// own human is always reachable. Board mentions and thread replies go through
// this too (access.ts), so a post can't reach a phone a DM can't.
export function reachesHuman(repo: Repo, reach: HumanReach, fromEmail: string, to: string): boolean {
  const slash = to.lastIndexOf("/");
  if (to.slice(slash + 1) !== HUMAN_NAME) return true;
  const toEmail = to.slice(0, slash);
  if (reach === "all" || toEmail === fromEmail) return true;
  const a = repo.users.findByEmail(fromEmail);
  const b = repo.users.findByEmail(toEmail);
  if (!a || !b) return false;
  const theirs = new Set(repo.teams.listForUser(b.id).map((t) => t.id));
  return repo.teams.listForUser(a.id).some((t) => theirs.has(t.id));
}

// Admins are the emails in GRAYBOARD_ADMINS. All admin actions are audited.
export function canAdmin(principal: SendPrincipal, admins: readonly string[]): SendDecision {
  if (admins.includes(principal.user_email.toLowerCase())) return { allow: true };
  return {
    allow: false,
    code: "forbidden",
    reason: admins.length === 0
      ? "no admins are configured on this server (GRAYBOARD_ADMINS)"
      : `${principal.user_email} is not an admin`,
  };
}
