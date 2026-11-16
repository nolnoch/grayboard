// Board access for the distributed server, evaluated for the acting address
// through the Resolver (#284 S12). Open boards (scope null) are visible to
// any address with a principal; "team:<name>" boards to that team's own
// aliases and to its members' addresses. A session bound to `eng/x` acts as
// eng: it sees eng's boards, not its binder's other teams'. Installed on the
// database by openDatabase, so every core call is checked.
import { addressParts, type AliasScope } from "../core/addresses.ts";
import type { Access, Board, CoreDb } from "../core/boards.ts";
import { CoreError } from "../core/errors.ts";
import { ownScope, type Principal } from "../core/resolver.ts";
import { undeliverableId } from "../core/session_end.ts";
import { HUMAN_NAME } from "../shared/addressing.ts";
import { authorize, type ActScope, type HumanReach } from "./policy.ts";
import type { Repo } from "./db.ts";

function teamOf(scope: string | null): string | null {
  return scope?.startsWith("team:") ? scope.slice(5) : null;
}

// Whether principal p may act in a scope (#284 S9), as policy.ts decides it:
// a filter check, so it writes no decision row.
function actsIn(repo: Repo, p: Principal, scope: ActScope): boolean {
  return authorize(repo, {}, { verb: "scope.act", principal: p, scope }).allow;
}

// Whether `from` may wake `to` (a human's phone), the DM rule as a filter.
function reaches(repo: Repo, humanReach: HumanReach, from: string, to: string): boolean {
  return authorize(repo, { humanReach }, { verb: "human.reach", from, to }).allow;
}

// Board visibility is the principal's: an org board is everyone's, a team
// board its team's and members'. canSee resolves an address to this.
export function principalCanSee(repo: Repo, p: Principal, board: Board): boolean {
  if (board.scope === null) return true;
  const team = teamOf(board.scope);
  if (team === null) return false;
  return p.kind === "team" ? p.name === team : actsIn(repo, p, { scope_kind: "team", scope_ref: team });
}

export function serverAccess(repo: Repo, db: CoreDb, humanReach: HumanReach = "team"): Access {
  // Whether p acts inside team `teamName`: the team itself, or a member.
  const inTeam = (p: Principal, teamName: string): boolean =>
    p.kind === "team" ? p.name === teamName : actsIn(repo, p, { scope_kind: "team", scope_ref: teamName });

  const canSee = (handle: string, board: Board): boolean => {
    const p = repo.resolver.principalOf(handle);
    return !!p && principalCanSee(repo, p, board);
  };

  // A team's alias names reach only the team and its members, as its boards
  // and roster do (#348); people's names are the open directory. A filter:
  // no decision rows.
  const seesAlias = (handle: string, scope: Omit<AliasScope, "name">): boolean => {
    // A person's names are listed to every caller, as before #348.
    if (scope.scope_kind === "person") return true;
    const p = repo.resolver.principalOf(handle);
    if (p === null || scope.scope_ref === null) return false;
    return authorize(repo, {}, { verb: "alias.see", principal: p, scope: { scope_kind: scope.scope_kind, scope_ref: scope.scope_ref } }).allow;
  };

  return {
    canSee,

    // An alias's labels reach only a principal that may act in its scope
    // (#284 S13): a team's task or private board name stays inside the team.
    seesAliasMeta(handle, scope) {
      const p = repo.resolver.principalOf(handle);
      return p !== null && scope.scope_ref !== null && actsIn(repo, p, { scope_kind: scope.scope_kind, scope_ref: scope.scope_ref });
    },

    seesAlias,

    // No server #announce yet (#24): a team board named announce stays ordinary.
    announceBoard: null,

    checkCreate(handle, scope) {
      if (scope === null) return null;
      const team = teamOf(scope);
      if (team === null) return `invalid board scope "${scope}"`;
      // A team reads as missing to a non-member (#1020): one refusal for both.
      const p = repo.resolver.principalOf(handle);
      return repo.teams.findByName(team) && p && inTeam(p, team) ? null : `no such team "${team}"`;
    },

    // The grammar of #284 decision 16 (S13): @id:… is the session itself (a
    // strict post refuses one that can't receive); @scope/name is that alias
    // exactly; a bare @name is the author's own scope's alias of that name,
    // and only that: another user's or team's is named in full, so a bare
    // name never wakes someone else's agent by accident (security audit F-08).
    // A strict post with a bare name only others have refuses, naming the
    // ones on the board's roster; a system post leaves it unresolved. A bare
    // @human is only ever your own.
    resolveMention(token, author, board, strict, viewer = author) {
      const t = addressParts(token);
      if (!t || t.kind === "team") return null;
      if (t.kind === "id") {
        const why = undeliverableId(db, t.address);
        if (why && strict) throw why;
        return why ? null : t.address;
      }
      const reach = (h: string) => canSee(h, board) && reaches(repo, humanReach, author, h);
      if (t.kind === "alias") return repo.aliases.find(t.address) && reach(t.address) ? t.address : null;
      const scope = ownScope(repo.resolver, author);
      const own = scope ? `${scope}/${t.name}` : null;
      if (own && repo.aliases.find(own)) return own;
      if (t.name === HUMAN_NAME) return null;
      if (!strict) return null;
      // Only names the posting session may see exist (#348): a team's stay
      // inside the team, so a hidden one refuses nothing.
      const roster = repo.aliases.findAllByName(t.name).filter((a) => seesAlias(viewer, a)).map((i) => i.address).filter(reach);
      if (roster.length) throw new CoreError(`@${t.name} isn't in your scope; name it in full: ${roster.join(", ")}`);
      return null;
    },

    // A thread reply reaches a human only as far as a DM could.
    mayReach: (from, to) => reaches(repo, humanReach, from, to),
  };
}
