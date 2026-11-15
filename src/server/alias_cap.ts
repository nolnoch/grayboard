import type { Repo } from "./db.ts";
import type { ScopeKind } from "../core/addresses.ts";

// Names one scope (a user's, a team's) may hold (#347). Every create path a
// client reaches (bind, writes_as, `grayboard identity create`) checks it before
// a new name; an existing name binds at any count, so a server already past a
// lowered cap keeps working. The Slack link's `human` is neither capped nor
// counted. Fleet sessions mint a name per task and nothing prunes names, so
// the default is generous; a team owner frees one with `grayboard team
// delete-alias`, a user with `grayboard identity rm`. GRAYBOARD_ALIAS_SCOPE_CAP.
export const ALIAS_SCOPE_CAP = 500;

// The refusal for a new name in a scope at its cap, or null. Callers check
// and create with no await between, so two creates can't both pass at the
// last slot.
export function aliasCapRefusal(repo: Repo, scope: { scope_kind: ScopeKind; scope_ref: string }, cap: number): string | null {
  const n = repo.aliases.countForScope(scope.scope_kind, scope.scope_ref);
  if (n < cap) return null;
  const free = scope.scope_kind === "team"
    ? `a team owner frees one with grayboard team delete-alias ${scope.scope_ref} <name>`
    : "free one with grayboard identity rm <name>";
  return `${scope.scope_kind === "team" ? `team "${scope.scope_ref}"` : "your scope"} already has ${n} names, the server's cap of ${cap}; bind an existing name, or ${free}`;
}
