import type { AliasesStore, AliasTarget } from "./store/aliases.ts";
import type { Tx } from "./store/tx_base.ts";

// Names one scope (a user's, a team's) may hold (#347). Every create path a
// client reaches (bind, writes_as, `grayboard identity create`) checks it before
// a new name; an existing name binds at any count, so a server already past a
// lowered cap keeps working. The Slack link's `human` is neither capped nor
// counted. Fleet sessions mint a name per task and nothing prunes names, so
// the default is generous; a team owner frees one with `grayboard team
// delete-alias`, a user with `grayboard identity rm`. GRAYBOARD_ALIAS_SCOPE_CAP.
export const ALIAS_SCOPE_CAP = 500;

// The refusal for a new name in a scope at its cap, or null. Callers check and create inside one body, under the scope's
// lock (aliases.lockScope, #807 P3 C5 decision 1), held until that body ends: two creators in one scope count in turn,
// so they can't both pass at the last slot (D3). After the lock the name is looked up again: a same-name creator that
// committed first made it an existing name, which binds at any count, not a capped one. `tx`: the body the create runs
// in, so the count sees its own creates; the lock must not sit in a savepoint that rolls back (that releases it).
export async function aliasCapRefusal(aliases: Pick<AliasesStore, "lockScope" | "find" | "countForScope">, tx: Tx, target: AliasTarget, cap: number): Promise<string | null> {
  const scope = { scope_kind: target.scope_kind, scope_ref: target.scope_ref };
  await aliases.lockScope(tx, scope);
  if (await aliases.find(tx, `${target.scope_ref}/${target.name}`)) return null;
  const n = await aliases.countForScope(tx, scope.scope_kind, scope.scope_ref);
  if (n < cap) return null;
  const free = scope.scope_kind === "team"
    ? `a team owner frees one with grayboard team delete-alias ${scope.scope_ref} <name>`
    : scope.scope_kind === "service" ? `an admin frees one with grayboard admin service delete-alias ${scope.scope_ref} <name>`
    : "free one with grayboard identity rm <name>";
  return `${scope.scope_kind === "person" ? "your scope" : `${scope.scope_kind} "${scope.scope_ref}"`} already has ${n} names, the server's cap of ${cap}; bind an existing name, or ${free}`;
}
