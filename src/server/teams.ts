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

export const teamScope = (name: string) => `team:${name}`;

export function ensureTeamBoard(db: CoreDb, team: Team, createdBy: string): void {
  ensureBoard(db, team.name, `Team ${team.name}`, teamScope(team.name), createdBy);
}

// Never overrides a mode the agent chose (including a past unsubscribe that
// happened while still a member: this only runs on join and alias creation).
function follow(db: CoreDb, handle: string, team: Team): void {
  if (!isSubscribed(db, handle, team.name)) subscribe(db, handle, team.name, "digest");
}

export function onTeamJoined(db: CoreDb, repo: Repo, team: Team, email: string): void {
  ensureTeamBoard(db, team, email);
  for (const alias of repo.aliases.listForScope("person", email)) follow(db, alias.address, team);
}

export function onTeamLeft(db: CoreDb, repo: Repo, team: Team, email: string): void {
  for (const alias of repo.aliases.listForScope("person", email)) unsubscribeScope(db, alias.address, teamScope(team.name));
}

// A person's alias follows each of its user's teams; a team's alias follows
// only its own team (#284 S9), whoever created it.
export function onAliasCreated(db: CoreDb, repo: Repo, userId: number, handle: string): void {
  const creator = repo.users.findById(userId)?.email;
  if (!creator) return;
  const p = addressParts(handle);
  if (p?.kind !== "alias") return;
  const teams = p.scopeKind === "person" ? repo.teams.listForUser(userId) : [repo.teams.findByName(p.scope)].filter((t): t is Team => !!t);
  for (const team of teams) {
    ensureTeamBoard(db, team, creator);
    follow(db, handle, team);
  }
}
