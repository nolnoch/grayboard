// The delegation group's interface (#807 P3 C10d1, docs/future/postgres-server.md D2): what a delegate decides on,
// which Repo (db.ts) composes and the Postgres store (pg/delegation.ts) implements, and the facts both return. Its
// imports are type-only, so a module under pg/ may import it (pg/isolation.test.ts); db.ts re-exports every name.
import type { DelegationFacts } from "../../core/delegation.ts";
import type { Read } from "./tx_base.ts";

// A delegate's facts, read first (DelegationStore.facts): the decision's reads, and each candidate's open count.
export interface ReadDelegationFacts extends DelegationFacts {
  open(handle: string): number;
}

// What a delegate decides on (#807 P3 B4b), on the caller's handle: read first, then core's synchronous decision
// (resolveDelegationWith) runs over it.
export interface DelegationStore {
  // The user behind an address (core addressUser): an ID's principal, an alias's holder's or last holder's;
  // undefined with no session behind it.
  addressUser(r: Read, address: string): Promise<string | null | undefined>;
  // Everything the decision can ask for this call: with `to`, that target's; without, every launcher's user and
  // open count (requests since `since` it hasn't taken, #252). A fact not read throws when asked. On a Tx, the open
  // cap holds for the rest of the body: on Postgres an advisory lock per candidate (DELEGATE_CAP_LOCK) is taken
  // before the counts, so two delegations to one launcher at cap-1 count in turn; SQLite's single writer is the lock.
  facts(r: Read, q: { to?: string; since: number }): Promise<ReadDelegationFacts>;
}

// Maps over what was read; a question about anything else throws, so a decision that asks for a fact the read left
// out fails loudly instead of reading as false or zero. The human fallback's reads are local mode's only.
export function delegationFacts(read: {
  launchers?: string[];
  to?: { address: string; everConnected: boolean; isLauncher: boolean };
  users: Map<string, string | null | undefined>;
  open: Map<string, number>;
}): ReadDelegationFacts {
  const missing = (what: string): never => { throw new Error(`delegation facts: ${what} was not read`); };
  const from = <T>(m: Map<string, T>, what: string) => (h: string): T => m.has(h) ? m.get(h) as T : missing(`${what} of "${h}"`);
  return {
    launchers: () => read.launchers ?? missing("the launcher list"),
    userOf: from(read.users, "the user"),
    everConnected: (h) => read.to?.address === h ? read.to.everConnected : missing(`whether "${h}" connected`),
    isLauncher: (h) => read.to?.address === h ? read.to.isLauncher : missing(`whether "${h}" is a launcher`),
    open: from(read.open, "the open count"),
    humanHandles: () => missing("the human handles"),
    lastSeen: () => missing("a last-seen"),
  };
}
