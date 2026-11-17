// Teams are access groups for boards. Each team has a members-only board of
// the same name; members' aliases follow it in digest mode by default.
import {
  ensureBoard,
  isSubscribed,
  subscribe,
  unsubscribeScope,
  type CoreDb,
} from "../core/boards.ts";
import { addressParts } from "../core/addresses.ts";
import type { Repo, Team } from "./db.ts";
import type { Tx } from "./store/tx.ts";

export const teamScope = (name: string) => `team:${name}`;

// Each takes the `Tx` of the write body that changed a membership or created
// an alias, and reaches core's board helpers on that body's connection.
export function ensureTeamBoard(repo: Repo, tx: Tx, team: Team, createdBy: string): void {
  ensureBoard(repo.coreOn(tx), team.name, `Team ${team.name}`, teamScope(team.name), createdBy);
}

// Never overrides a mode the agent chose (including a past unsubscribe that
// happened while still a member: this only runs on join and alias creation).
function follow(db: CoreDb, handle: string, team: Team): void {
  if (!isSubscribed(db, handle, team.name)) subscribe(db, handle, team.name, "digest");
}

export function onTeamJoined(repo: Repo, tx: Tx, team: Team, email: string): void {
  ensureTeamBoard(repo, tx, team, email);
  for (const alias of repo.aliases.listForScope(tx, "person", email)) follow(repo.coreOn(tx), alias.address, team);
}

export function onTeamLeft(repo: Repo, tx: Tx, team: Team, email: string): void {
  for (const alias of repo.aliases.listForScope(tx, "person", email)) unsubscribeScope(repo.coreOn(tx), alias.address, teamScope(team.name));
}

// A person's alias follows each of its user's teams; a team's alias follows
// only its own team (#284 S9), whoever created it.
export function onAliasCreated(repo: Repo, tx: Tx, userId: number, handle: string): void {
  const creator = repo.users.findById(userId)?.email;
  if (!creator) return;
  const p = addressParts(handle);
  if (p?.kind !== "alias") return;
  const teams = p.scopeKind === "person" ? repo.policyNow.teamsOf(userId) : [repo.policyNow.teamByName(p.scope)].filter((t): t is Team => !!t);
  for (const team of teams) {
    ensureTeamBoard(repo, tx, team, creator);
    follow(repo.coreOn(tx), handle, team);
  }
}
