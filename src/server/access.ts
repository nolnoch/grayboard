// Board access for the distributed server, evaluated for the acting address
// through the Resolver (#284 S12). Core calls it synchronously, so its reads
// are repo.policyNow's (#807 P3 A7e1) until B5b. Open boards (scope null) are visible to
// any address with a principal; "team:<name>" boards to that team's own
// aliases and to its members' addresses; "service:<name>" boards (#270 D5) to
// the service and the principals holding service_invoke on it, directly or
// through a team. A session bound to `eng/x` acts as eng: it sees eng's boards,
// not its binder's other teams', and a service's only by eng's own binding.
// Installed on the database by openDatabase, so every core call is checked.
import { addressParts, type AliasScope } from "../core/addresses.ts";
import type { Access, Board, CoreDb } from "../core/boards.ts";
import { CoreError } from "../core/errors.ts";
import { ownScope, type Principal } from "../core/resolver.ts";
import { undeliverableId } from "../core/session_end.ts";
import { HUMAN_NAME } from "../shared/addressing.ts";
import { authorize, authorizeNow, serviceOfScope, type ActScope, type HumanReach } from "./policy.ts";
import type { Repo } from "./db.ts";
import type { Read, Tx } from "./store/tx.ts";

function teamOf(scope: string | null): string | null {
  return scope?.startsWith("team:") ? scope.slice(5) : null;
}

// Whether principal p may act in a scope (#284 S9), as policy.ts decides it:
// a filter check, so it writes no decision row.
function actsIn(repo: Repo, p: Principal, scope: ActScope): boolean {
  return authorizeNow(repo, {}, { verb: "scope.act", principal: p, scope }).allow;
}

// Whether `from` may wake `to` (a human's phone), the DM rule as a filter.
function reaches(repo: Repo, humanReach: HumanReach, from: string, to: string): boolean {
  return authorizeNow(repo, { humanReach }, { verb: "human.reach", from, to }).allow;
}

// Board visibility is the principal's: an org board is everyone's, a team
// board its team's and members', a service's board the service's and its
// invokers' (#270 D5: service.invoke as a filter, no row; anyone else reads
// "no such board", as for a team's). canSee resolves an address to this.
export function principalCanSee(repo: Repo, p: Principal, board: Board): boolean {
  if (board.scope === null) return true;
  const service = serviceOfScope(board.scope);
  if (service !== null) return authorizeNow(repo, {}, { verb: "service.invoke", principal: p, service, board: board.name }).allow;
  const team = teamOf(board.scope);
  if (team === null) return false;
  return p.kind === "team" ? p.name === team : actsIn(repo, p, { scope_kind: "team", scope_ref: team });
}

// Whether principal p may be a lane on `board` (#270 D5): on a service's board only the service's own addresses
// consume, so an invoker subscribed in push mode never takes work meant for the service; any board else, anyone who
// may see it.
export function laneOf(p: Principal | null, board: Board): boolean {
  const service = serviceOfScope(board.scope);
  return service === null || (p?.kind === "service" && p.name === service);
}

// The scope a board the actor creates gets (#270 D5): a team's when named; else a queue board a service's address
// creates is the service's, implicitly, with no tool argument (principle 2: every session would pay for one); any
// other board is org-open.
export function createScope(p: Principal | null, team: string | undefined, kind: string | undefined): string | null {
  if (team) return `team:${team.toLowerCase()}`;
  return p?.kind === "service" && kind === "queue" ? `service:${p.name}` : null;
}

// checkCreate's ruling on a service scope: only that service may create in it. Never a read: a scope that names no
// service is refused the same way, without saying whether one exists.
function serviceCreate(p: Principal | null, scope: string): string | null | undefined {
  const service = serviceOfScope(scope);
  if (service === null) return undefined;
  return p?.kind === "service" && p.name === service ? null : `invalid board scope "${scope}"`;
}

export function serverAccess(repo: Repo, db: CoreDb, humanReach: HumanReach = "team"): Access {
  // Whether p acts inside team `teamName`: the team itself, or a member.
  const inTeam = (p: Principal, teamName: string): boolean =>
    p.kind === "team" ? p.name === teamName : actsIn(repo, p, { scope_kind: "team", scope_ref: teamName });

  const canSee = (handle: string, board: Board): boolean => {
    const p = repo.policyNow.principalOf(handle);
    return !!p && principalCanSee(repo, p, board);
  };

  // A team's alias names reach only the team and its members, as its boards
  // and roster do (#348); people's names are the open directory. A filter:
  // no decision rows.
  const seesAlias = (handle: string, scope: Omit<AliasScope, "name">): boolean => {
    // A person's names are listed to every caller, as before #348.
    if (scope.scope_kind === "person") return true;
    const p = repo.policyNow.principalOf(handle);
    if (p === null || scope.scope_ref === null) return false;
    return authorizeNow(repo, {}, { verb: "alias.see", principal: p, scope: { scope_kind: scope.scope_kind, scope_ref: scope.scope_ref } }).allow;
  };

  return {
    canSee,

    // An alias's labels reach only a principal that may act in its scope
    // (#284 S13): a team's task or private board name stays inside the team.
    seesAliasMeta(handle, scope) {
      const p = repo.policyNow.principalOf(handle);
      return p !== null && scope.scope_ref !== null && actsIn(repo, p, { scope_kind: scope.scope_kind, scope_ref: scope.scope_ref });
    },

    seesAlias,

    // No server #announce yet (#24): a team board named announce stays ordinary.
    announceBoard: null,

    mayLane: (handle, board) => serviceOfScope(board.scope) === null || laneOf(repo.policyNow.principalOf(handle), board),

    checkCreate(handle, scope) {
      if (scope === null) return null;
      const svc = serviceCreate(repo.policyNow.principalOf(handle), scope);
      if (svc !== undefined) return svc;
      const team = teamOf(scope);
      if (team === null) return `invalid board scope "${scope}"`;
      // A team reads as missing to a non-member (#1020): one refusal for both.
      const p = repo.policyNow.principalOf(handle);
      return repo.policyNow.teamByName(team) && p && inTeam(p, team) ? null : `no such team "${team}"`;
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
      if (t.kind === "alias") return repo.policyNow.alias(t.address) && reach(t.address) ? t.address : null;
      const scope = ownScope(repo.policyNow, author);
      const own = scope ? `${scope}/${t.name}` : null;
      if (own && repo.policyNow.alias(own)) return own;
      if (t.name === HUMAN_NAME) return null;
      if (!strict) return null;
      // Only names the posting session may see exist (#348): a team's stay
      // inside the team, so a hidden one refuses nothing.
      const roster = repo.policyNow.aliasesNamed(t.name).filter((a) => seesAlias(viewer, a)).map((i) => i.address).filter(reach);
      if (roster.length) throw new CoreError(`@${t.name} isn't in your scope; name it in full: ${roster.join(", ")}`);
      return null;
    },

    // A thread reply reaches a human only as far as a DM could.
    mayReach: (from, to) => reaches(repo, humanReach, from, to),

    // A human archives only boards its own user's addresses created (#848): a
    // team's alias, a service or another user's agent is someone else's.
    sameUser(human, address) {
      const h = repo.policyNow.principalOf(human), a = repo.policyNow.principalOf(address);
      return h?.kind === "user" && a?.kind === "user" && h.name === a.name;
    },

    ownerOf(address) {
      const p = repo.policyNow.principalOf(address);
      return p?.kind === "user" ? p.name : null;
    },
  };
}

// ── async board access (#807 P3 B5a0) ────────────────────────────────────────
// serverAccess's decisions with every read on the caller's handle: a write body's `Tx` sees the body's own rows (a
// member just added, D2), `repo.read` committed state. Core's synchronous `Access` stays for the paths still in core;
// the server's board ports (B5a1-B5b3) take this instead. The batch forms answer what core asks once per recipient
// or scope (post's subscribers, who's rows): canSeeMany, visibleTo and the scope tables with one decision per distinct
// principal or scope, mayReachMany per distinct address; resolveMentions still decides per token.

// An alias scope as a map key: seesAliasScopes' and seesAliasMetaScopes' answers are keyed by it.
export type AliasScopeOf = Omit<AliasScope, "name">;
export const scopeKey = (s: AliasScopeOf): string => JSON.stringify([s.scope_kind, s.scope_ref]);

// core's ownScope on the caller's handle: an alias's own scope, or the principal an ID acts for; null for anything
// else. A bare name means this scope's alias of that name.
// The address a session's ID acts as on a scoped board (#270 D6, #1255) and for a service's names: its session's
// primary, the oldest hold, else a tools-only session's writes_as name, else the ID itself (its user). A session bound
// only to `eng/w-1` then sees eng's boards, not its binder's other teams', and holds a service's right only by eng's
// binding, on every route (MCP, HTTP), as its ID or as its name alike, and for seeing a board as for posting on it
// (D5: one right). An org board is everyone's; a team's or person's names are judged for the ID's user (#348).
export async function idActsAs(repo: Repo, r: Read, id: string): Promise<string> {
  const holds = await repo.bindings.holdsOf(r, id);
  return holds[0] ?? (await repo.bindings.idRow(r, id))?.writes_as ?? id;
}

// The principal `handle` is judged as on `board`: an ID on a scoped board as idActsAs's address, else its own.
// Not async itself: an org board costs the one read it always did, with no added tick.
function seerOn(repo: Repo, r: Read, handle: string, board: Board): Promise<Principal | null> {
  return seerIn(repo, r, handle, board.scope !== null);
}

// The principal `handle` is judged as for a scoped board or a service's names (`scoped`: an ID as idActsAs's address,
// #1255), or for anything else (its own). A service's names are seen as its board is (alias.see_service): one right.
export function seerIn(repo: Repo, r: Read, handle: string, scoped: boolean): Promise<Principal | null> {
  if (!scoped || addressParts(handle)?.kind !== "id") return repo.principals.of(r, handle);
  return idActsAs(repo, r, handle).then((a) => repo.principals.of(r, a));
}

export async function ownScopeOn(repo: Repo, r: Read, address: string): Promise<string | null> {
  const a = addressParts(address);
  if (a?.kind === "alias") return a.scope;
  return a?.kind === "id" ? (await repo.principals.of(r, address))?.name ?? null : null;
}

export interface BoardAccess {
  canSee(r: Read, handle: string, board: Board): Promise<boolean>;
  // Of `handles`, those that may see `board`: one decision per distinct principal.
  canSeeMany(r: Read, handles: string[], board: Board): Promise<Set<string>>;
  // Of `boards`, the names a viewer (an address, or a principal already read) may see; none for an address with no
  // principal.
  visibleTo(r: Read, viewer: string | Principal, boards: Board[]): Promise<Set<string>>;
  checkCreate(r: Read, handle: string, scope: string | null): Promise<string | null>;
  // Of `handles`, those that may be a lane on `board` (#270 D5): on a service's board, the service's own addresses.
  lanesAmong(r: Read, handles: string[], board: Board): Promise<Set<string>>;
  // The scope a board `handle` creates gets (createScope).
  createScope(r: Read, handle: string, team: string | undefined, kind: string | undefined): Promise<string | null>;
  // Takes a Tx: an @id: is judged by repo.sessionEnd.refusal, the send side of an end's race (D3).
  resolveMention(tx: Tx, token: string, author: string, board: Board, strict: boolean, viewer?: string): Promise<string | null>;
  // core's resolveMentions over tokens already parsed (mentionTokens): a token resolves when its handle may see the board.
  resolveMentions(tx: Tx, tokens: string[], author: string, board: Board, strict: boolean, viewer: string): Promise<{ handles: string[]; unresolved: string[] }>;
  mayReach(r: Read, from: string, to: string): Promise<boolean>;
  mayReachMany(r: Read, from: string, tos: string[]): Promise<Set<string>>;
  seesAlias(r: Read, handle: string, scope: AliasScopeOf): Promise<boolean>;
  // Per scopeKey: one decision per distinct scope, the viewer's principal read once.
  seesAliasScopes(r: Read, viewer: string, scopes: AliasScopeOf[]): Promise<Map<string, boolean>>;
  seesAliasMeta(r: Read, handle: string, scope: AliasScopeOf): Promise<boolean>;
  seesAliasMetaScopes(r: Read, viewer: string, scopes: AliasScopeOf[]): Promise<Map<string, boolean>>;
  sameUser(r: Read, human: string, address: string): Promise<boolean>;
  ownerOf(r: Read, address: string): Promise<string | null>;
}

export function boardAccess(repo: Repo, humanReach: HumanReach = "team"): BoardAccess {
  const actsIn = async (r: Read, p: Principal, scope: ActScope) => (await authorize(repo, r, {}, { verb: "scope.act", principal: p, scope })).allow;
  const reaches = async (r: Read, from: string, to: string) => (await authorize(repo, r, { humanReach }, { verb: "human.reach", from, to })).allow;
  // principalCanSee's rule.
  const principalSees = async (r: Read, p: Principal, board: Board): Promise<boolean> => {
    if (board.scope === null) return true;
    const service = serviceOfScope(board.scope);
    if (service !== null) return (await authorize(repo, r, {}, { verb: "service.invoke", principal: p, service, board: board.name })).allow;
    const team = teamOf(board.scope);
    if (team === null) return false;
    return p.kind === "team" ? p.name === team : actsIn(r, p, { scope_kind: "team", scope_ref: team });
  };
  const canSeeMany = async (r: Read, handles: string[], board: Board): Promise<Set<string>> => {
    const out = new Set<string>();
    const byPrincipal = new Map<string, boolean>();
    for (const h of new Set(handles)) {
      const p = await seerOn(repo, r, h, board);
      if (p === null) continue;
      const k = `${p.kind}\0${p.name}`;
      let v = byPrincipal.get(k);
      if (v === undefined) byPrincipal.set(k, v = await principalSees(r, p, board));
      if (v) out.add(h);
    }
    return out;
  };
  const canSee = async (r: Read, handle: string, board: Board) => (await canSeeMany(r, [handle], board)).has(handle);
  // seesAlias's rule for a principal already read: a person's names are the open directory.
  const seesAliasOf = async (r: Read, p: Principal | null, scope: AliasScopeOf): Promise<boolean> => {
    if (scope.scope_kind === "person") return true;
    if (p === null || scope.scope_ref === null) return false;
    return (await authorize(repo, r, {}, { verb: "alias.see", principal: p, scope: { scope_kind: scope.scope_kind, scope_ref: scope.scope_ref } })).allow;
  };
  const seesMetaOf = async (r: Read, p: Principal | null, scope: AliasScopeOf): Promise<boolean> =>
    p !== null && scope.scope_ref !== null && actsIn(r, p, { scope_kind: scope.scope_kind, scope_ref: scope.scope_ref });
  const byScope = (rule: (r: Read, p: Principal | null, s: AliasScopeOf) => Promise<boolean>, asBoard = false) =>
    async (r: Read, viewer: string, scopes: AliasScopeOf[]): Promise<Map<string, boolean>> => {
      const out = new Map<string, boolean>();
      if (!scopes.length) return out;
      const p = await repo.principals.of(r, viewer);
      // A service's names, to an ID, are judged as its board is (seerIn), read once and only when one is asked. A
      // team's names are judged for the ID's user, as #348 decided: name sight is the user's, board sight the primary's.
      let onService: Principal | null | undefined;
      for (const s of scopes) {
        const k = scopeKey(s);
        if (out.has(k)) continue;
        const q = s.scope_kind === "service" && asBoard ? (onService === undefined ? (onService = await seerIn(repo, r, viewer, true)) : onService) : p;
        out.set(k, await rule(r, q, s));
      }
      return out;
    };

  const resolveMention = async (tx: Tx, token: string, author: string, board: Board, strict: boolean, viewer: string = author): Promise<string | null> => {
    const t = addressParts(token);
    if (!t || t.kind === "team") return null;
    if (t.kind === "id") {
      const why = await repo.sessionEnd.refusal(tx, t.address);
      if (why && strict) throw why;
      return why ? null : t.address;
    }
    const reach = async (h: string) => (await canSee(tx, h, board)) && reaches(tx, author, h);
    if (t.kind === "alias") return (await repo.aliases.find(tx, t.address)) && (await reach(t.address)) ? t.address : null;
    const scope = await ownScopeOn(repo, tx, author);
    const own = scope ? `${scope}/${t.name}` : null;
    if (own && (await repo.aliases.find(tx, own))) return own;
    if (t.name === HUMAN_NAME) return null;
    if (!strict) return null;
    // Only names the posting session may see exist (#348).
    const named = await repo.aliases.findAllByName(tx, t.name);
    const seen = await byScope(seesAliasOf, true)(tx, viewer, named);
    const roster: string[] = [];
    for (const a of named) if (seen.get(scopeKey(a)) && (await reach(a.address))) roster.push(a.address);
    if (roster.length) throw new CoreError(`@${t.name} isn't in your scope; name it in full: ${roster.join(", ")}`);
    return null;
  };

  return {
    canSee,
    canSeeMany,

    async visibleTo(r, viewer, boards) {
      const p = typeof viewer === "string" ? await repo.principals.of(r, viewer) : viewer;
      const out = new Set<string>();
      if (p === null) return out;
      // An ID's principal on a scoped board (seerOn), read once and only when one is among `boards`.
      let scoped: Principal | null | undefined;
      const byScope = new Map<string | null, boolean>();
      for (const b of boards) {
        let v = byScope.get(b.scope);
        if (v === undefined) {
          let q: Principal | null = p;
          if (typeof viewer === "string" && b.scope !== null) q = scoped === undefined ? (scoped = await seerOn(repo, r, viewer, b)) : scoped;
          byScope.set(b.scope, v = q !== null && (await principalSees(r, q, b)));
        }
        if (v) out.add(b.name);
      }
      return out;
    },

    async lanesAmong(r, handles, board) {
      if (serviceOfScope(board.scope) === null) return new Set(handles);
      const out = new Set<string>();
      for (const h of new Set(handles)) if (laneOf(await repo.principals.of(r, h), board)) out.add(h);
      return out;
    },

    async createScope(r, handle, team, kind) {
      return createScope(team ? null : await repo.principals.of(r, handle), team, kind);
    },

    async checkCreate(r, handle, scope) {
      if (scope === null) return null;
      const svc = serviceCreate(await repo.principals.of(r, handle), scope);
      if (svc !== undefined) return svc;
      const team = teamOf(scope);
      if (team === null) return `invalid board scope "${scope}"`;
      // A team reads as missing to a non-member (#1020): one refusal for both.
      const missing = `no such team "${team}"`;
      if (!(await repo.teams.findByName(r, team))) return missing;
      const p = await repo.principals.of(r, handle);
      if (p === null) return missing;
      const inTeam = p.kind === "team" ? p.name === team : await actsIn(r, p, { scope_kind: "team", scope_ref: team });
      return inTeam ? null : missing;
    },

    resolveMention,

    async resolveMentions(tx, tokens, author, board, strict, viewer) {
      const handles = new Set<string>();
      const unresolved: string[] = [];
      for (const t of tokens) {
        const h = await resolveMention(tx, t, author, board, strict, viewer);
        if (h && (await canSee(tx, h, board))) handles.add(h);
        else unresolved.push(t);
      }
      return { handles: [...handles], unresolved };
    },

    mayReach: reaches,

    async mayReachMany(r, from, tos) {
      const out = new Set<string>();
      for (const to of new Set(tos)) if (await reaches(r, from, to)) out.add(to);
      return out;
    },

    seesAlias: async (r, handle, scope) => seesAliasOf(r, scope.scope_kind === "person" ? null : await seerIn(repo, r, handle, scope.scope_kind === "service"), scope),
    seesAliasScopes: byScope(seesAliasOf, true),
    seesAliasMeta: async (r, handle, scope) => seesMetaOf(r, await repo.principals.of(r, handle), scope),
    seesAliasMetaScopes: byScope(seesMetaOf),

    // A human archives only boards its own user's addresses created (#848).
    async sameUser(r, human, address) {
      const h = await repo.principals.of(r, human), a = await repo.principals.of(r, address);
      return h?.kind === "user" && a?.kind === "user" && h.name === a.name;
    },

    async ownerOf(r, address) {
      const p = await repo.principals.of(r, address);
      return p?.kind === "user" ? p.name : null;
    },
  };
}
