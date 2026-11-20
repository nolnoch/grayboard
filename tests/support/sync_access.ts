// The synchronous core Access the server installed until #807 P3 C10d2-a (src/server/access.ts serverAccess), kept as a
// test oracle: core's board, post and claim functions run over a server database with it (setAccess), and the server's
// ported tools and async boardAccess are compared against them (board-access-parity, board-tools-parity,
// board-post-parity, claim-tools-parity). Production installs no synchronous Access: the server's session end is
// composed over the Repo's groups (src/server/session_end.ts). It restates no policy rule: every decision calls
// production policy.ts `decide` over the store's own reads, each settled synchronously (`Bun.peek`: a SQLite store
// read's promise is resolved when returned). The Access glue around those calls (which principal an ID is judged as,
// a board scope's team or service, the mention grammar) is the deleted serverAccess as it was, and
// src/server/board-access-parity.test.ts holds it equal to production `boardAccess`, as it held the two forms before.
// Test-only: nothing under src/, scripts/ or adapters/ but *.test.ts imports it (src/server/policy.test.ts checks).
import { addressParts, type AliasScope } from "../../src/core/addresses.ts";
import { holdsOf, idRow } from "../../src/core/bindings.ts";
import type { Access, Board, CoreDb } from "../../src/core/boards.ts";
import { CoreError } from "../../src/core/errors.ts";
import { ownScope, type Principal } from "../../src/core/resolver.ts";
import { undeliverableId } from "../../src/core/session_end.ts";
import { HUMAN_NAME } from "../../src/shared/addressing.ts";
import { laneOf, serviceCreate, teamOf } from "../../src/server/access.ts";
import type { Alias, Repo } from "../../src/server/db.ts";
import { decide, policyReads, serviceOfScope, type ActScope, type AuthzRequest, type Decision, type HumanReach, type PolicyContext, type PolicyReads, type Rule } from "../../src/server/policy.ts";
import { sqliteTx } from "../../src/server/store/tx.ts";

/** A promise's value now; one still pending is a store read that awaited, which this oracle can't serve. */
export function settled<T>(p: Promise<T>): T {
  const status = Bun.peek.status(p);
  if (status === "pending") throw new Error("sync_access: a store read was still pending (not a synchronous SQLite read)");
  const v = Bun.peek(p);
  if (status === "rejected") throw v;
  return v as T;
}

type SyncReads = { [K in keyof PolicyReads]: (...a: Parameters<PolicyReads[K]>) => Awaited<ReturnType<PolicyReads[K]>> }
  & { alias(address: string): Alias | undefined; aliasesNamed(name: string): Alias[] };

/** The store's policy and alias reads on `db`'s connection, synchronously: inside a body they see its writes. */
export function now(repo: Repo, db: CoreDb): SyncReads {
  const h = sqliteTx(db as never);
  const reads = policyReads(repo, h);
  const out = Object.fromEntries(Object.entries(reads).map(([k, fn]) => [k, (...a: unknown[]) => settled((fn as (...x: unknown[]) => Promise<unknown>)(...a))]));
  return {
    ...(out as unknown as SyncReads),
    alias: (address) => settled(repo.aliases.find(h, address)),
    aliasesNamed: (name) => settled(repo.aliases.findAllByName(h, name)),
  };
}

/** A rule driven to its answer over `now`'s reads. */
function drive<T>(g: Rule<T>, reads: SyncReads): T {
  for (let s = g.next(); ; ) {
    if (s.done) return s.value;
    const { read, args } = s.value;
    s = g.next((reads[read] as (...a: unknown[]) => unknown)(...args));
  }
}

/** policy.ts `authorize`, synchronously over `db`'s connection. */
export function authorizeNow(repo: Repo, db: CoreDb, ctx: PolicyContext, req: AuthzRequest): Decision {
  return drive(decide(ctx, req), now(repo, db));
}

// Whether principal p may act in a scope (#284 S9), as policy.ts decides it:
// a filter check, so it writes no decision row.
function actsIn(repo: Repo, db: CoreDb, p: Principal, scope: ActScope): boolean {
  return authorizeNow(repo, db, {}, { verb: "scope.act", principal: p, scope }).allow;
}

// Whether `from` may wake `to` (a human's phone), the DM rule as a filter.
function reaches(repo: Repo, db: CoreDb, humanReach: HumanReach, from: string, to: string): boolean {
  return authorizeNow(repo, db, { humanReach }, { verb: "human.reach", from, to }).allow;
}

// Board visibility is the principal's: an org board is everyone's, a team
// board its team's and members', a service's board the service's and its
// invokers' (#270 D5: service.invoke as a filter, no row; anyone else reads
// "no such board", as for a team's). canSee resolves an address to this.
export function principalCanSee(repo: Repo, db: CoreDb, p: Principal, board: Board): boolean {
  if (board.scope === null) return true;
  const service = serviceOfScope(board.scope);
  if (service !== null) return authorizeNow(repo, db, {}, { verb: "service.invoke", principal: p, service, board: board.name }).allow;
  const team = teamOf(board.scope);
  if (team === null) return false;
  return p.kind === "team" ? p.name === team : actsIn(repo, db, p, { scope_kind: "team", scope_ref: team });
}


export function serverAccess(repo: Repo, db: CoreDb, humanReach: HumanReach = "team"): Access {
  // Whether p acts inside team `teamName`: the team itself, or a member.
  const inTeam = (p: Principal, teamName: string): boolean =>
    p.kind === "team" ? p.name === teamName : actsIn(repo, db, p, { scope_kind: "team", scope_ref: teamName });

  // seerIn's rule on the ambient connection (#1255, #1273 L4): for a scoped board or a service's names, an ID is
  // judged as idActsAs's address (its primary, else its writes_as name, else itself); anything else as its own.
  const seer = (handle: string, scoped: boolean): Principal | null => {
    if (!scoped || addressParts(handle)?.kind !== "id") return now(repo, db).principalOf(handle);
    return now(repo, db).principalOf(holdsOf(db, handle)[0] ?? idRow(db, handle)?.writes_as ?? handle);
  };

  const canSee = (handle: string, board: Board): boolean => {
    const p = seer(handle, board.scope !== null);
    return !!p && principalCanSee(repo, db, p, board);
  };

  // A team's alias names reach only the team and its members, as its boards
  // and roster do (#348); people's names are the open directory. A filter:
  // no decision rows.
  const seesAlias = (handle: string, scope: Omit<AliasScope, "name">): boolean => {
    // A person's names are listed to every caller, as before #348.
    if (scope.scope_kind === "person") return true;
    // A service's names are seen as its board is; a team's are the ID's user's (#348).
    const p = seer(handle, scope.scope_kind === "service");
    if (p === null || scope.scope_ref === null) return false;
    return authorizeNow(repo, db, {}, { verb: "alias.see", principal: p, scope: { scope_kind: scope.scope_kind, scope_ref: scope.scope_ref } }).allow;
  };

  return {
    canSee,

    // An alias's labels reach only a principal that may act in its scope
    // (#284 S13): a team's task or private board name stays inside the team. A scoped alias's labels can name a
    // board, so an ID is judged as its primary, as for the board (#1255).
    seesAliasMeta(handle, scope) {
      const p = seer(handle, scope.scope_kind !== "person");
      if (p === null || scope.scope_ref === null) return false;
      if (p.kind === "team") return scope.scope_kind === "team" && p.name === scope.scope_ref;
      return actsIn(repo, db, p, { scope_kind: scope.scope_kind, scope_ref: scope.scope_ref });
    },

    seesAlias,

    // No server #announce yet (#24): a team board named announce stays ordinary.
    announceBoard: null,

    mayLane: (handle, board) => serviceOfScope(board.scope) === null || laneOf(now(repo, db).principalOf(handle), board),

    checkCreate(handle, scope) {
      if (scope === null) return null;
      const svc = serviceCreate(now(repo, db).principalOf(handle), scope);
      if (svc !== undefined) return svc;
      const team = teamOf(scope);
      if (team === null) return `invalid board scope "${scope}"`;
      // A team reads as missing to a non-member (#1020): one refusal for both.
      const p = now(repo, db).principalOf(handle);
      return now(repo, db).teamByName(team) && p && inTeam(p, team) ? null : `no such team "${team}"`;
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
      const reach = (h: string) => canSee(h, board) && reaches(repo, db, humanReach, author, h);
      if (t.kind === "alias") return now(repo, db).alias(t.address) && reach(t.address) ? t.address : null;
      const scope = ownScope(now(repo, db), author);
      const own = scope ? `${scope}/${t.name}` : null;
      if (own && now(repo, db).alias(own)) return own;
      if (t.name === HUMAN_NAME) return null;
      if (!strict) return null;
      // Only names the posting session may see exist (#348): a team's stay
      // inside the team, so a hidden one refuses nothing.
      const roster = now(repo, db).aliasesNamed(t.name).filter((a) => seesAlias(viewer, a)).map((i) => i.address).filter(reach);
      if (roster.length) throw new CoreError(`@${t.name} isn't in your scope; name it in full: ${roster.join(", ")}`);
      return null;
    },

    // A thread reply reaches a human only as far as a DM could.
    mayReach: (from, to) => reaches(repo, db, humanReach, from, to),

    // A human archives only boards its own user's addresses created (#848): a
    // team's alias, a service or another user's agent is someone else's.
    sameUser(human, address) {
      const h = now(repo, db).principalOf(human), a = now(repo, db).principalOf(address);
      return h?.kind === "user" && a?.kind === "user" && h.name === a.name;
    },

    ownerOf(address) {
      const p = now(repo, db).principalOf(address);
      return p?.kind === "user" ? p.name : null;
    },

    // A claimant's user (#1286), as its own principal: never a session's binding.
    userSees(user, board) {
      const row = now(repo, db).principalByName(user);
      return !!row && principalCanSee(repo, db, { kind: row.kind, name: row.name }, board);
    },
  };
}

