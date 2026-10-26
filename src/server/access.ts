// Board access for the distributed server, evaluated for the acting address
// through the Resolver (#284 S12). Open boards (scope null) are visible to
// any address with a principal; "team:<name>" boards to that team's own
// aliases and to its members' addresses. A session bound to `eng/x` acts as
// eng: it sees eng's boards, not its binder's other teams'. Installed on the
// database by openDatabase, so every core call is checked.
import { addressParts } from "../core/addresses.ts";
import type { Access, Board, CoreDb } from "../core/boards.ts";
import { CoreError } from "../core/errors.ts";
import { ownScope, type Principal } from "../core/resolver.ts";
import { undeliverableId } from "../core/session_end.ts";
import { HUMAN_NAME } from "../shared/addressing.ts";
import { reachesHuman, type HumanReach } from "./can_send.ts";
import type { Repo } from "./db.ts";

function teamOf(scope: string | null): string | null {
  return scope?.startsWith("team:") ? scope.slice(5) : null;
}

export function serverAccess(repo: Repo, db: CoreDb, humanReach: HumanReach = "team"): Access {
  // Whether p acts inside team `teamName`: the team itself, or a member.
  const inTeam = (p: Principal, teamName: string): boolean => {
    if (p.kind === "team") return p.name === teamName;
    if (p.kind !== "user") return false;
    const user = repo.users.findByEmail(p.name);
    const team = repo.teams.findByName(teamName);
    return !!user && !!team && repo.teams.isMember(team.id, user.id);
  };

  const canSee = (handle: string, board: Board): boolean => {
    const p = repo.resolver.principalOf(handle);
    if (!p) return false;
    if (board.scope === null) return true;
    const team = teamOf(board.scope);
    return team !== null && inTeam(p, team);
  };

  return {
    canSee,

    // No server #announce yet (#24): a team board named announce stays ordinary.
    announceBoard: null,

    checkCreate(handle, scope) {
      if (scope === null) return null;
      const team = teamOf(scope);
      if (team === null) return `invalid board scope "${scope}"`;
      if (!repo.teams.findByName(team)) return `no such team "${team}"`;
      const p = repo.resolver.principalOf(handle);
      return p && inTeam(p, team) ? null : `you're not a member of team "${team}"`;
    },

    // The grammar of #284 decision 16 (S13): @id:… is the session itself (a
    // strict post refuses one that can't receive); @scope/name is that alias
    // exactly; a bare @name is the author's own scope's first, then the one
    // alias of that name on the board's roster. A strict post refuses an
    // ambiguous bare name, naming the candidates; a system post leaves it
    // unresolved. A bare @human is only ever your own.
    resolveMention(token, author, board, strict) {
      const t = addressParts(token);
      if (!t || t.kind === "team") return null;
      if (t.kind === "id") {
        const why = undeliverableId(db, t.address);
        if (why && strict) throw new CoreError(why);
        return why ? null : t.address;
      }
      const reach = (h: string) => canSee(h, board) && reachesHuman(repo, humanReach, author, h);
      if (t.kind === "alias") return repo.aliases.find(t.address) && reach(t.address) ? t.address : null;
      const scope = ownScope(repo.resolver, author);
      const own = scope ? `${scope}/${t.name}` : null;
      if (own && repo.aliases.find(own)) return own;
      if (t.name === HUMAN_NAME) return null;
      const roster = repo.aliases.findAllByName(t.name).map((i) => i.address).filter(reach);
      if (roster.length === 1) return roster[0]!;
      if (roster.length > 1 && strict) throw new CoreError(`@${t.name} matches ${roster.join(", ")}; name one`);
      return null;
    },

    // A thread reply reaches a human only as far as a DM could.
    mayReach: (from, to) => reachesHuman(repo, humanReach, from, to),
  };
}
