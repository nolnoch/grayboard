import type { Repo } from "./db.ts";
import type { Read } from "./store/tx.ts";
import type { ScopeKind } from "../core/addresses.ts";

// Names one scope (a user's, a team's) may hold (#347). Every create path a
// client reaches (bind, writes_as, `grayboard identity create`) checks it before
// a new name; an existing name binds at any count, so a server already past a
// lowered cap keeps working. The Slack link's `human` is neither capped nor
// counted. Fleet sessions mint a name per task and nothing prunes names, so
// the default is generous; a team owner frees one with `grayboard team
// delete-alias`, a user with `grayboard identity rm`. GRAYBOARD_ALIAS_SCOPE_CAP.
export const ALIAS_SCOPE_CAP = 500;

// The refusal for a new name in a scope at its cap, or null. Callers check and create inside one queued body,
// so two creates can't both pass at the last slot: the count's await (#807 P3 A7g2) is before the verdict, and no
// other body writes until the caller's commits. That rests on D4's single queue; D3's `FOR UPDATE` on the scope's
// parent row, the form that holds without it, comes with the Postgres store (P3). `r`: the body's Tx the create runs in, so the count sees its own creates.
export async function aliasCapRefusal(repo: Repo, r: Read, scope: { scope_kind: ScopeKind; scope_ref: string }, cap: number): Promise<string | null> {
  const n = await repo.aliases.countForScope(r, scope.scope_kind, scope.scope_ref);
  if (n < cap) return null;
  const free = scope.scope_kind === "team"
    ? `a team owner frees one with grayboard team delete-alias ${scope.scope_ref} <name>`
    : scope.scope_kind === "service" ? `an admin frees one with grayboard admin service delete-alias ${scope.scope_ref} <name>`
    : "free one with grayboard identity rm <name>";
  return `${scope.scope_kind === "person" ? "your scope" : `${scope.scope_kind} "${scope.scope_ref}"`} already has ${n} names, the server's cap of ${cap}; bind an existing name, or ${free}`;
}
