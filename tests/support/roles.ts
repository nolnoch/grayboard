// A fixture's team owner (#927): ownership is a team_owner role binding, granted through the store as team
// creation grants it (the member must already be in the team). Throws when nothing was granted.
import type { Repo, RoleBinding } from "../../src/server/db.ts";
import { ROLES } from "../../src/server/policy.ts";
import type { Tx } from "../../src/server/store/tx.ts";

export async function grantOwner(repo: Repo, tx: Tx, team: string, email: string): Promise<RoleBinding> {
  const b = await repo.roles.grant(tx, {
    holder: email, role: "team_owner", scope: team, holderKinds: ROLES.team_owner.holders, scopeKind: "team",
    member: true, by: email, authority: "none", actor: email,
  });
  if (!b) throw new Error(`grantOwner: ${email} wasn't made an owner of ${team}`);
  return b;
}
