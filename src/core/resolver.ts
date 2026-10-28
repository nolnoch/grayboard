// Who an address acts for (#284 decision 15). Access, reach and send checks
// ask this rather than reading an address's text: an ID carries no email,
// and a scope with no `@` is a team or a service, not a person.
//
//   id:…       → the principal that registered the ID (ids.principal)
//   email/name → the user with that email
//   team/name  → the team (or service) named by the scope
//   team:name  → the team
import { addressParts } from "./addresses.ts";

/** A scope owner: a user (name = email), a team or a service principal. */
export type Principal = { kind: "user" | "team" | "service"; name: string };

export interface Resolver {
  /** The principal `address` acts for, or null when it names none (malformed, unknown, or a bare local name). */
  principalOf(address: string): Principal | null;
}

/**
 * The scope a bare name means first for `address`: an alias's own scope, or
 * the principal an ID acts for. Null for an address with neither.
 */
export function ownScope(r: Resolver, address: string): string | null {
  const a = addressParts(address);
  if (a?.kind === "alias") return a.scope;
  return a?.kind === "id" ? r.principalOf(address)?.name ?? null : null;
}
