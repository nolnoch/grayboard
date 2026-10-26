// Teams are access groups for boards. Each team has a members-only board of
// the same name; members' aliases follow it in digest mode by default.
import {
  ensureBoard,
  isSubscribed,
  subscribe,
  unsubscribeScope,
  type CoreDb,
} from "../core/boards.ts";
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
  for (const alias of repo.aliases.listFor(email)) follow(db, alias.address, team);
}

export function onTeamLeft(db: CoreDb, repo: Repo, team: Team, email: string): void {
  for (const alias of repo.aliases.listFor(email)) unsubscribeScope(db, alias.address, teamScope(team.name));
}

export function onAliasCreated(db: CoreDb, repo: Repo, userId: number, handle: string): void {
  const email = handle.slice(0, handle.lastIndexOf("/"));
  for (const team of repo.teams.listForUser(userId)) {
    ensureTeamBoard(db, team, email);
    follow(db, handle, team);
  }
}
