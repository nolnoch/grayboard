// The claim holder's user rule (#855), apart from claims.ts so a module that may not reach SQLite (the Postgres claims
// store, src/server/store/pg/claims.ts) runs the same rule: it imports nothing that does.
import { addressParts } from "./addresses.ts";
import type { ClaimRow } from "./claims.ts";

// The user an announcement the system writes for a claim (its expiry, a session end's release) is recorded
// as written by (#855): the claimant's, or for a claim from before holder_user (or a queue delivery to an alias
// no session held then) an ID holder's principal, else the user of the session holding the alias now, else a
// person alias's person. A team alias nobody holds names no user. The rule is pure; both modes read its facts.
export function holderUserRule(c: ClaimRow, idPrincipal: string | null | undefined, heldPrincipal: string | null | undefined): string | undefined {
  if (c.holder_user) return c.holder_user;
  if (idPrincipal) return idPrincipal;
  if (heldPrincipal) return heldPrincipal;
  const p = addressParts(c.holder);
  return p?.kind === "alias" && p.scopeKind === "person" ? p.scope : undefined;
}
