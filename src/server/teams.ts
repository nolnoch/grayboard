// Teams are access groups for boards. Each team has a members-only board of
// the same name; members' aliases follow it in digest mode by default.
import { addressParts } from "../core/addresses.ts";
import { CoreError } from "../core/errors.ts";
import { boardAccess } from "./access.ts";
import type { Repo, Team } from "./db.ts";
import type { Tx } from "./store/tx.ts";

export const teamScope = (name: string) => `team:${name}`;

// Each takes the `Tx` of the write body that changed a membership or created
// an alias, and writes through repo.boards on it.
export async function ensureTeamBoard(repo: Repo, tx: Tx, team: Team, createdBy: string): Promise<void> {
  await repo.boards.ensure(tx, team.name, `Team ${team.name}`, teamScope(team.name), createdBy);
}

// Never overrides a mode the agent chose (including a past unsubscribe that
// happened while still a member: this only runs on join and alias creation).
// A board the handle can't see is refused as core's subscribe refuses it; the
// callers have just made it visible, so that is a broken invariant, not a user error.
async function follow(repo: Repo, tx: Tx, handle: string, team: Team): Promise<void> {
  if (await repo.boards.isSubscribed(tx, handle, team.name)) return;
  const board = await repo.boards.get(tx, team.name);
  // Visibility doesn't depend on the human-reach setting, so the default access judges it.
  if (!board || !(await boardAccess(repo).canSee(tx, handle, board))) throw new CoreError(`no such board #${team.name}; see board_list`);
  await repo.boards.setSubscription(tx, handle, team.name, "digest");
}

export async function onTeamJoined(repo: Repo, tx: Tx, team: Team, email: string): Promise<void> {
  await ensureTeamBoard(repo, tx, team, email);
  for (const alias of await repo.aliases.listForScope(tx, "person", email)) await follow(repo, tx, alias.address, team);
}

export async function onTeamLeft(repo: Repo, tx: Tx, team: Team, email: string): Promise<void> {
  for (const alias of await repo.aliases.listForScope(tx, "person", email)) await repo.boards.unsubscribeScope(tx, alias.address, teamScope(team.name));
}

// A person's alias follows each of its user's teams; a team's alias follows
// only its own team (#284 S9), whoever created it.
export async function onAliasCreated(repo: Repo, tx: Tx, userId: number, handle: string): Promise<void> {
  const creator = (await repo.users.findById(tx, userId))?.email;
  if (!creator) return;
  const p = addressParts(handle);
  if (p?.kind !== "alias") return;
  const teams = p.scopeKind === "person" ? await repo.teams.listForUser(tx, userId) : [await repo.teams.findByName(tx, p.scope)].filter((t): t is Team => !!t);
  for (const team of teams) {
    await ensureTeamBoard(repo, tx, team, creator);
    await follow(repo, tx, handle, team);
  }
}
