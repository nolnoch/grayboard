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

export type SendTarget =
  | { kind: "user"; address: string }
  | { kind: "team"; team_id: number; name: string };

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

// v1: any authenticated user may execute admin commands. All admin actions are audited.
// NOTE: v1 — any authenticated employee can run admin commands. All admin actions are logged.
export function canAdmin(_principal: SendPrincipal): { allow: true } {
  return { allow: true };
}
