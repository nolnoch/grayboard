// Board access for the distributed server. Handles are "email/name".
// Open boards (scope null) are visible to everyone signed in; "team:<name>"
// boards only to that team's members. Installed on the database by
// openDatabase, so every core call is checked.
import type { Access, Board } from "../core/boards.ts";
import type { Repo } from "./db.ts";

function emailOf(handle: string): string | null {
  const slash = handle.lastIndexOf("/");
  return slash > 0 ? handle.slice(0, slash) : null;
}

function teamOf(scope: string | null): string | null {
  return scope?.startsWith("team:") ? scope.slice(5) : null;
}

export function serverAccess(repo: Repo): Access {
  const isMember = (handle: string, teamName: string): boolean => {
    const email = emailOf(handle);
    const user = email ? repo.users.findByEmail(email) : undefined;
    const team = repo.teams.findByName(teamName);
    return !!user && !!team && repo.teams.isMember(team.id, user.id);
  };

  const canSee = (handle: string, board: Board): boolean => {
    if (board.scope === null) return emailOf(handle) !== null;
    const team = teamOf(board.scope);
    return team !== null && isMember(handle, team);
  };

  return {
    canSee,

    checkCreate(handle, scope) {
      if (scope === null) return null;
      const team = teamOf(scope);
      if (team === null) return `invalid board scope "${scope}"`;
      if (!repo.teams.findByName(team)) return `no such team "${team}"`;
      return isMember(handle, team) ? null : `you're not a member of team "${team}"`;
    },

    // @email/name exactly; @local/name by email local part; @name means the
    // author's own identity first, then a unique match among board viewers.
    resolveMention(token, author, board) {
      const slash = token.lastIndexOf("/");
      const name = slash >= 0 ? token.slice(slash + 1) : token;
      const prefix = slash >= 0 ? token.slice(0, slash) : null;
      const candidates = repo.identities
        .findAllByName(name)
        .map((i) => `${i.email}/${i.name}`)
        .filter((h) => {
          if (prefix === null) return true;
          const email = emailOf(h)!;
          return prefix.includes("@") ? email === prefix : email.split("@")[0] === prefix;
        });
      if (prefix === null) {
        const own = `${emailOf(author)}/${name}`;
        if (candidates.includes(own)) return own;
      }
      const visible = candidates.filter((h) => canSee(h, board));
      return visible.length === 1 ? visible[0]! : null;
    },
  };
}
