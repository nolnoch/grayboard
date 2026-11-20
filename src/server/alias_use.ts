import type { AliasesStore } from "./store/aliases.ts";
import type { BindingsStore } from "./store/bindings.ts";
import type { Tx } from "./store/tx_base.ts";

// Another principal's session acting as `address` (bindings.userOf), read under the alias row's "use" lock (#807 P3
// C10a Q4), held until `tx`'s body ends; undefined when the alias is gone (a delete committed first). A tools-only
// root's writes_as is judged here (application.ts hostedWritesAs, on its create path), and a bind's take takes the
// same lock inside bindings.take: on Postgres two of them serialize, so the second sees the first's committed hold or
// writes_as and refuses, where two unlocked checks would both pass and put two users on one alias. On SQLite the single
// writer is the lock, and this is the find and the check.
export async function lockedUserOf(
  stores: { aliases: Pick<AliasesStore, "lock">; bindings: Pick<BindingsStore, "userOf"> }, tx: Tx, address: string, principal: string,
): Promise<string | null | undefined> {
  if (!(await stores.aliases.lock(tx, address, "use"))) return undefined;
  return stores.bindings.userOf(tx, address, principal);
}
