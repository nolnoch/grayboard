// The authorization seam. All message sends route through here.
import { addressParts } from "../core/addresses.ts";
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

export type SendTarget = { kind: "user"; address: string };

export type SendDecision =
  | { allow: true }
  | { allow: false; code: "forbidden" | "not_found"; reason: string };

// `from`: the sending address (an alias or an ID).
export function canSend(
  from: string,
  target: SendTarget,
  ctx: SendContext,
): SendDecision {
  // Future policy lives here. Do not add caller-side bypasses.
  if (!reachesHuman(ctx.db, ctx.humanReach, from, target.address)) {
    return { allow: false, code: "forbidden", reason: `${target.address} is a person's phone, reachable only by their teammates' agents` };
  }
  return { allow: true };
}

// Whether the address `from` may wake `to` when `to` is a human
// (`<email>/human`). A person reaches their own human, and a teammate's
// (reach "team"); a team alias reaches a member's (#284 S12), the analogue
// of sharing a team. Board mentions and thread replies go through this too
// (access.ts), so a post can't reach a phone a DM can't.
export function reachesHuman(repo: Repo, reach: HumanReach, from: string, to: string): boolean {
  const t = addressParts(to);
  if (t?.kind !== "alias" || t.name !== HUMAN_NAME) return true;
  if (reach === "all") return true;
  const f = repo.resolver.principalOf(from);
  const them = t.scopeKind === "person" ? repo.users.findByEmail(t.scope) : undefined;
  if (!f || !them) return false;
  if (f.kind === "team") {
    const team = repo.teams.findByName(f.name);
    return !!team && repo.teams.isMember(team.id, them.id);
  }
  if (f.kind !== "user") return false;
  if (f.name === them.email) return true;
  const me = repo.users.findByEmail(f.name);
  if (!me) return false;
  const theirs = new Set(repo.teams.listForUser(them.id).map((x) => x.id));
  return repo.teams.listForUser(me.id).some((x) => theirs.has(x.id));
}

// Admins are the emails in GRAYBOARD_ADMINS. All admin actions are audited.
export function canAdmin(email: string, admins: readonly string[]): SendDecision {
  if (admins.includes(email.toLowerCase())) return { allow: true };
  return {
    allow: false,
    code: "forbidden",
    reason: admins.length === 0
      ? "no admins are configured on this server (GRAYBOARD_ADMINS)"
      : `${email} is not an admin`,
  };
}
