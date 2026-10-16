// The authorization seam. All message sends route through here.
import type { Repo } from "./db.ts";

export type SendContext = {
  db: Repo;
  now: number;
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
  _sender: SendPrincipal,
  _target: SendTarget,
  _ctx: SendContext,
): SendDecision {
  // v1: allow all sends between authenticated users.
  // Future policy lives here. Do not add caller-side bypasses.
  return { allow: true };
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
