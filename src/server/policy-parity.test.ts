// The policy drivers give one answer (#807 P3 A7e3): the parity tests' synchronous oracle (tests/support/sync_access.ts
// `authorizeNow`, which replaced the server's `authorizeNow` over `repo.policyNow` in #807 P3 C10d2-a), `authorize` on
// the store's read handle and `authorize` on a write body's Tx agree on every rule branch and see a body's own
// uncommitted writes. Every rule literal in policy.ts has a row,
// so a new branch fails here until it's covered. The H1 race: a membership change committed between two of a
// decision's reads must not combine into an allow neither state gives.
import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { idAddress } from "../core/bindings.ts";
import { registerId, type CoreDb } from "../core/boards.ts";
import type { Principal } from "../core/resolver.ts";
import { authorize, type AuthzRequest, type PolicyContext } from "./policy.ts";
import { openDatabase, type Repo, type Team, type User } from "./db.ts";
import { scratchDbPath } from "../../tests/support/scratch_db.ts";
import { seed, seedSync } from "../../tests/support/seed.ts";
import { grantOwner } from "../../tests/support/roles.ts";
import { authorizeNow as oracle } from "../../tests/support/sync_access.ts";
import { NO_MEMBER_AUTHORITY } from "./store/identity.ts";

type Fixture = { repo: Repo; db: CoreDb; a: User; b: User; c: User; d: User; svc: User; eng: Team; ops: Team; x: Team; id: string };

// Users a, b, c, d; eng collaborative (a owner, b), ops delegating (a owner, c), x open (d owner); an ID registered
// by a; aliases a@example.com/x and eng/bot; a service principal, svc, owned by a (#270), and another, ci;
// c holds org_admin by a binding (#927); service_invoke on svc is held by b directly, by team x (d's) and by
// the service ci (#270 D6).
async function fixture(): Promise<Fixture> {
  const { repo, db } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
  const id = idAddress("a".repeat(64));
  const rows = await seed(repo, async tx => {
    const [a, b, c, d] = [
      await repo.users.upsertByEmail(tx, "a@example.com", null),
      await repo.users.upsertByEmail(tx, "b@example.com", null),
      await repo.users.upsertByEmail(tx, "c@example.com", null),
      await repo.users.upsertByEmail(tx, "d@example.com", null),
    ];
    const eng = await repo.teams.create(tx, "eng", a.id);
    await repo.teams.addMember(tx, eng.id, a.id, NO_MEMBER_AUTHORITY);
    await grantOwner(repo, tx, "eng", "a@example.com");
    await repo.teams.addMember(tx, eng.id, b.id, NO_MEMBER_AUTHORITY);
    await repo.teams.setPolicy(tx, eng.id, "collaborative");
    const ops = await repo.teams.create(tx, "ops", a.id);
    await repo.teams.addMember(tx, ops.id, a.id, NO_MEMBER_AUTHORITY);
    await grantOwner(repo, tx, "ops", "a@example.com");
    await repo.teams.addMember(tx, ops.id, c.id, NO_MEMBER_AUTHORITY);
    await repo.teams.setPolicy(tx, ops.id, "delegating");
    const x = await repo.teams.create(tx, "x", d.id);
    await repo.teams.addMember(tx, x.id, d.id, NO_MEMBER_AUTHORITY);
    await grantOwner(repo, tx, "x", "d@example.com");
    await repo.aliases.create(tx, { scope_kind: "person", scope_ref: "a@example.com", name: "x" }, "a@example.com");
    await repo.aliases.create(tx, { scope_kind: "team", scope_ref: "eng", name: "bot" }, "a@example.com");
    const svc = await repo.services.create(tx, "svc");
    await repo.services.create(tx, "ci");
    await repo.roles.grant(tx, { holder: "a@example.com", role: "service_owner", scope: "svc", holderKinds: ["user"], scopeKind: "service", member: false, by: "a@example.com", byUser: null, authority: "none", actor: "a@example.com" });
    return { a, b, c, d, svc, eng: (await repo.teams.findByName(tx, "eng"))!, ops: (await repo.teams.findByName(tx, "ops"))!, x };
  });
  await seed(db, () => {
    registerId(db, { id, principal: "a@example.com", launcher: false });
    db.run("INSERT INTO role_bindings (principal_id, role, scope_id, granted_by, granted_at) SELECT id, 'org_admin', NULL, NULL, 0 FROM principals WHERE name = 'c@example.com'");
    for (const h of ["b@example.com", "x", "ci"]) {
      db.run("INSERT INTO role_bindings (principal_id, role, scope_id, granted_by, granted_at) SELECT h.id, 'service_invoke', s.id, NULL, 0 FROM principals h, principals s WHERE h.name = ? AND s.name = 'svc'", [h]);
    }
  });
  return { repo, db, id, ...rows };
}

type Row = { name: string; ctx?: PolicyContext; req: AuthzRequest; allow: boolean; rule: string };

const user = (email: string): Principal => ({ kind: "user", name: email });
const teamScope = (ref: string) => ({ scope_kind: "team" as const, scope_ref: ref });
const personScope = (ref: string) => ({ scope_kind: "person" as const, scope_ref: ref });

function rows(f: Fixture): Row[] {
  const A = "a@example.com", B = "b@example.com", C = "c@example.com", D = "d@example.com";
  const ua = { id: f.a.id, email: A, kind: "user" as const }, ub = { id: f.b.id, email: B, kind: "user" as const }, uc = { id: f.c.id, email: C, kind: "user" as const }, ud = { id: f.d.id, email: D, kind: "user" as const };
  const live = { principal: A, viewer: false, ended_at: null };
  const svc = { kind: "service" as const, name: "svc" }, us = { id: f.svc.id, email: "svc", kind: "service" as const };
  const serviceScope = (ref: string) => ({ scope_kind: "service" as const, scope_ref: ref });
  return [
    // msg.send / human.reach
    { name: "not a human", req: { verb: "msg.send", from: `${A}/fe`, to: `${B}/be` }, allow: true, rule: "human.not_human" },
    { name: "reach all", ctx: { humanReach: "all" }, req: { verb: "msg.send", from: `${D}/fe`, to: `${B}/human` }, allow: true, rule: "human.reach_all" },
    { name: "own human", req: { verb: "msg.send", from: `${A}/fe`, to: `${A}/human` }, allow: true, rule: "human.self" },
    { name: "a teammate's human", req: { verb: "human.reach", from: `${A}/fe`, to: `${B}/human` }, allow: true, rule: "human.teammates" },
    { name: "an ID's registering user", req: { verb: "msg.send", from: f.id, to: `${B}/human` }, allow: true, rule: "human.teammates" },
    { name: "a stranger's human", req: { verb: "msg.send", from: `${D}/fe`, to: `${B}/human` }, allow: false, rule: "human.teammates" },
    { name: "no principal", req: { verb: "human.reach", from: "nobody/fe", to: `${B}/human` }, allow: false, rule: "human.teammates" },
    { name: "a service's alias", req: { verb: "msg.send", from: "svc/bot", to: `${B}/human` }, allow: false, rule: "human.teammates" },
    { name: "team alias to a member", req: { verb: "msg.send", from: "eng/bot", to: `${B}/human` }, allow: true, rule: "human.team_alias" },
    { name: "team alias to a non-member", req: { verb: "human.reach", from: "eng/bot", to: `${C}/human` }, allow: false, rule: "human.team_alias" },
    // scope.act / alias.bind / act_as
    { name: "service in its own scope", req: { verb: "scope.act", principal: svc, scope: serviceScope("svc") }, allow: true, rule: "scope.own_service" },
    { name: "service binds in its own scope", req: { verb: "alias.bind", principal: svc, scope: serviceScope("svc"), name: "w-1" }, allow: true, rule: "scope.own_service" },
    { name: "service in a team's scope", req: { verb: "scope.act", principal: svc, scope: teamScope("eng") }, allow: false, rule: "scope.own_service" },
    { name: "service in a person's scope", req: { verb: "alias.bind", principal: svc, scope: personScope(A), name: "w-1" }, allow: false, rule: "scope.own_service" },
    { name: "service in another service's scope", req: { verb: "scope.act", principal: svc, scope: serviceScope("ci") }, allow: false, rule: "scope.own_service" },
    { name: "service binds human", req: { verb: "alias.bind", principal: svc, scope: serviceScope("svc"), name: "human" }, allow: false, rule: "alias.human_reserved" },
    { name: "service scope", req: { verb: "scope.act", principal: user(B), scope: serviceScope("svc") }, allow: false, rule: "scope.service" },
    { name: "owner in its service's scope", req: { verb: "alias.bind", principal: user(A), scope: serviceScope("svc"), name: "w-1" }, allow: false, rule: "scope.service" },
    { name: "owner as its service's alias", req: { verb: "act_as", principal: user(A), address: "svc/w-1", name: "w-1", scope: serviceScope("svc") }, allow: false, rule: "scope.service" },
    { name: "team in a service's scope", req: { verb: "scope.act", principal: { kind: "team", name: "eng" }, scope: serviceScope("svc") }, allow: false, rule: "scope.service" },
    { name: "team principal", req: { verb: "scope.act", principal: { kind: "team", name: "eng" }, scope: personScope(A) }, allow: false, rule: "scope.user_only" },
    { name: "own person scope", req: { verb: "scope.act", principal: user(A), scope: personScope(A) }, allow: true, rule: "scope.own_person" },
    { name: "another's person scope", req: { verb: "scope.act", principal: user(A), scope: personScope(B) }, allow: false, rule: "scope.own_person" },
    { name: "member's team", req: { verb: "scope.act", principal: user(B), scope: teamScope("eng") }, allow: true, rule: "scope.team_member" },
    { name: "non-member's team", req: { verb: "scope.act", principal: user(D), scope: teamScope("eng") }, allow: false, rule: "scope.team_member" },
    { name: "missing team", req: { verb: "scope.act", principal: user(A), scope: teamScope("nope") }, allow: false, rule: "scope.team_member" },
    { name: "bind human", req: { verb: "alias.bind", principal: user(A), scope: personScope(A), name: "human" }, allow: false, rule: "alias.human_reserved" },
    { name: "bind in a team", req: { verb: "alias.bind", principal: user(C), scope: teamScope("ops"), name: "deploy" }, allow: true, rule: "scope.team_member" },
    { name: "as human", req: { verb: "act_as", principal: user(A), address: `${A}/human`, name: "human", scope: personScope(A) }, allow: false, rule: "alias.human_reserved" },
    { name: "as an ownerless scope", req: { verb: "act_as", principal: user(A), address: "nobody/fe", name: "fe", scope: null }, allow: false, rule: "scope.ownerless" },
    { name: "as a team alias", req: { verb: "act_as", principal: user(B), address: "eng/bot", name: "bot", scope: teamScope("eng") }, allow: true, rule: "scope.team_member" },
    // session.act
    { name: "unknown session", req: { verb: "session.act", user: A, session: f.id, row: undefined }, allow: false, rule: "session.unknown" },
    { name: "viewer session", req: { verb: "session.act", user: A, session: f.id, row: { ...live, viewer: true } }, allow: false, rule: "session.viewer" },
    { name: "another's session", req: { verb: "session.act", user: B, session: f.id, row: live }, allow: false, rule: "session.other_user" },
    { name: "ended session", req: { verb: "session.act", user: A, session: f.id, row: { ...live, ended_at: 5 } }, allow: false, rule: "session.ended" },
    { name: "own session", req: { verb: "session.act", user: A, session: f.id, row: live }, allow: true, rule: "session.own" },
    // hosted.session
    { name: "another user's hosted row", req: { verb: "hosted.session", session: "s", user: 1, client: "k", row: { user: 2, client: "k" } }, allow: false, rule: "hosted.other_user" },
    { name: "another client's hosted row", req: { verb: "hosted.session", session: "s", user: 1, client: "k", row: { user: 1, client: "j" } }, allow: false, rule: "hosted.other_client" },
    { name: "own hosted row", req: { verb: "hosted.session", session: "s", user: 1, client: "k", row: { user: 1, client: "k" } }, allow: true, rule: "hosted.own" },
    // attachment.read
    ...(["post", "message", "unbound"] as const).flatMap(carrier => [true, false].map(readable => ({
      name: `${carrier} attachment, readable ${readable}`,
      req: { verb: "attachment.read", identity: `${A}/fe`, attachment: "att", reach: { carrier, readable } } as AuthzRequest,
      allow: readable,
      rule: { post: "attachment.board_visible", message: "attachment.dm_party", unbound: "attachment.uploader" }[carrier],
    }))),
    { name: "unknown attachment", req: { verb: "attachment.read", identity: `${A}/fe`, attachment: "att", reach: undefined }, allow: false, rule: "attachment.unknown" },
    // team.*
    { name: "member leaves", req: { verb: "team.leave", user: ub, team: f.eng }, allow: true, rule: "team.member" },
    { name: "non-member leaves", req: { verb: "team.leave", user: ud, team: f.eng }, allow: false, rule: "team.member" },
    { name: "member reads", req: { verb: "team.read", user: uc, team: f.ops }, allow: true, rule: "team.member" },
    { name: "admin reads", ctx: { admins: [D] }, req: { verb: "team.read", user: ud, team: f.eng }, allow: true, rule: "admin.env" },
    { name: "org admin by binding reads", req: { verb: "team.read", user: uc, team: f.eng }, allow: true, rule: "role.org_admin" },
    { name: "stranger reads", req: { verb: "team.read", user: ud, team: f.eng }, allow: false, rule: "team.member" },
    { name: "owner manages", req: { verb: "team.manage", user: ua, team: f.eng }, allow: true, rule: "role.team_owner" },
    { name: "admin manages", ctx: { admins: [D] }, req: { verb: "team.manage", user: ud, team: f.eng }, allow: true, rule: "admin.env" },
    { name: "org admin by binding manages", req: { verb: "team.manage", user: uc, team: f.eng }, allow: true, rule: "role.org_admin" },
    { name: "member manages", req: { verb: "team.manage", user: ub, team: f.eng }, allow: false, rule: "role.team_owner" },
    { name: "stranger manages", req: { verb: "team.manage", user: ud, team: f.eng }, allow: false, rule: "team.member" },
    { name: "missing team managed", req: { verb: "team.manage", user: ua, team: undefined }, allow: false, rule: "team.member" },
    { name: "service in the admin list manages", ctx: { admins: ["svc"] }, req: { verb: "team.manage", user: us, team: f.eng }, allow: false, rule: "team.member" },
    { name: "service in the admin list reads", ctx: { admins: ["svc"] }, req: { verb: "team.read", user: us, team: f.eng }, allow: false, rule: "team.member" },
    // admin
    { name: "admin", ctx: { admins: [A] }, req: { verb: "admin", user: ua }, allow: true, rule: "admin.env" },
    { name: "org admin by binding", ctx: { admins: [A] }, req: { verb: "admin", user: uc }, allow: true, rule: "role.org_admin" },
    { name: "not admin", ctx: { admins: [A] }, req: { verb: "admin", user: ub }, allow: false, rule: "role.org_admin" },
    { name: "service in the admin list", ctx: { admins: ["svc"] }, req: { verb: "admin", user: us }, allow: false, rule: "role.org_admin" },
    // msg.wake / delegate.to
    { name: "wake self", req: { verb: "msg.wake", from_user: A, to_user: A }, allow: true, rule: "wake.same_user" },
    { name: "wake collaborative", req: { verb: "msg.wake", from_user: A, to_user: B }, allow: true, rule: "wake.team_policy" },
    { name: "wake delegating", req: { verb: "msg.wake", from_user: C, to_user: A }, allow: true, rule: "wake.team_policy" },
    { name: "wake open", req: { verb: "msg.wake", from_user: D, to_user: A }, allow: false, rule: "wake.cross_user" },
    { name: "delegate self", req: { verb: "delegate.to", from_user: B, to_user: B }, allow: true, rule: "delegate.same_user" },
    { name: "delegate delegating", req: { verb: "delegate.to", from_user: A, to_user: C }, allow: true, rule: "delegate.team_policy" },
    { name: "delegate collaborative", req: { verb: "delegate.to", from_user: A, to_user: B }, allow: false, rule: "delegate.cross_user" },
    // alias.see
    { name: "see a person's alias", req: { verb: "alias.see", principal: user(D), scope: personScope(A) }, allow: true, rule: "alias.see_person" },
    { name: "team sees its own", req: { verb: "alias.see", principal: { kind: "team", name: "eng" }, scope: teamScope("eng") }, allow: true, rule: "alias.see_own_team" },
    { name: "member sees a team's", req: { verb: "alias.see", principal: user(B), scope: teamScope("eng") }, allow: true, rule: "scope.team_member" },
    { name: "stranger sees a team's", req: { verb: "alias.see", principal: user(D), scope: teamScope("eng") }, allow: false, rule: "scope.team_member" },
    { name: "service sees its own", req: { verb: "alias.see", principal: svc, scope: serviceScope("svc") }, allow: true, rule: "scope.own_service" },
    { name: "owner sees a service's", req: { verb: "alias.see", principal: user(A), scope: serviceScope("svc") }, allow: false, rule: "alias.see_service" },
    { name: "invoker sees a service's", req: { verb: "alias.see", principal: user(B), scope: serviceScope("svc") }, allow: true, rule: "alias.see_service" },
    { name: "holding team's member sees a service's", req: { verb: "alias.see", principal: user(D), scope: serviceScope("svc") }, allow: true, rule: "alias.see_service" },
    { name: "service sees another's", req: { verb: "alias.see", principal: { kind: "service", name: "ci" }, scope: serviceScope("svc") }, allow: true, rule: "alias.see_service" },
    { name: "service sees one it can't invoke", req: { verb: "alias.see", principal: svc, scope: serviceScope("ci") }, allow: false, rule: "alias.see_service" },
    // service.invoke (#270 D6)
    { name: "service posts on its own board", req: { verb: "service.invoke", principal: svc, service: "svc", board: "jobs" }, allow: true, rule: "service.own" },
    { name: "direct holder invokes", req: { verb: "service.invoke", principal: user(B), service: "svc", board: "jobs" }, allow: true, rule: "role.service_invoke" },
    { name: "holding team's member invokes", req: { verb: "service.invoke", principal: user(D), service: "svc", board: "jobs" }, allow: true, rule: "role.service_invoke" },
    { name: "holding team invokes", req: { verb: "service.invoke", principal: { kind: "team", name: "x" }, service: "svc", board: "jobs" }, allow: true, rule: "role.service_invoke" },
    { name: "a holder's team doesn't invoke", req: { verb: "service.invoke", principal: { kind: "team", name: "eng" }, service: "svc", board: "jobs" }, allow: false, rule: "role.service_invoke" },
    { name: "holding service invokes", req: { verb: "service.invoke", principal: { kind: "service", name: "ci" }, service: "svc", board: "jobs" }, allow: true, rule: "role.service_invoke" },
    { name: "owner doesn't invoke", req: { verb: "service.invoke", principal: user(A), service: "svc", board: "jobs" }, allow: false, rule: "role.service_invoke" },
    { name: "admin doesn't invoke", ctx: { admins: [C] }, req: { verb: "service.invoke", principal: user(C), service: "svc", board: "jobs" }, allow: false, rule: "role.service_invoke" },
    { name: "no principal invokes", req: { verb: "service.invoke", principal: null, service: "svc", board: "jobs" }, allow: false, rule: "role.service_invoke" },
    { name: "another service's board", req: { verb: "service.invoke", principal: svc, service: "ci", board: "ci-jobs" }, allow: false, rule: "role.service_invoke" },
    { name: "service sees a person's", req: { verb: "alias.see", principal: svc, scope: personScope(A) }, allow: true, rule: "alias.see_person" },
    { name: "service wakes a user", req: { verb: "msg.wake", from_user: "svc", to_user: A }, allow: false, rule: "wake.cross_user" },
    { name: "service's board post wakes an invoker", req: { verb: "msg.wake", from_user: "svc", to_user: B, post: { board: "jobs", scope: "service:svc", from: svc, to: user(B) } }, allow: true, rule: "wake.service_invoke" },
    { name: "invoker's post wakes the service", req: { verb: "msg.wake", from_user: D, to_user: "svc", post: { board: "jobs", scope: "service:svc", from: user(D), to: svc } }, allow: true, rule: "wake.service_invoke" },
    { name: "service's board post to a non-invoker", req: { verb: "msg.wake", from_user: "svc", to_user: A, post: { board: "jobs", scope: "service:svc", from: svc, to: user(A) } }, allow: false, rule: "wake.cross_user" },
    { name: "a team name's post judged as the team", req: { verb: "msg.wake", from_user: B, to_user: "svc", post: { board: "jobs", scope: "service:svc", from: { kind: "team", name: "eng" }, to: svc } }, allow: false, rule: "wake.cross_user" },
    { name: "an org board's post isn't the service's", req: { verb: "msg.wake", from_user: "svc", to_user: B, post: { board: "open", scope: null, from: svc, to: user(B) } }, allow: false, rule: "wake.cross_user" },
    { name: "two invokers on a service's board", req: { verb: "msg.wake", from_user: B, to_user: D, post: { board: "jobs", scope: "service:svc", from: user(B), to: user(D) } }, allow: false, rule: "wake.cross_user" },
    { name: "service's alias reaches a human", req: { verb: "msg.send", from: "svc/w-1", to: `${A}/human` }, allow: false, rule: "human.teammates" },
  ];
}

const READS: Record<string, Record<string, string>> = {
  principals: { findByName: "principalByName", of: "principalOf" },
  teams: { findByName: "teamByName", isMember: "isMember", shareAny: "shareAny", shareCollaborative: "shareCollaborative", shareDelegating: "shareDelegating", listForUser: "teamsOf" },
  roles: { bindingOf: "roleBinding", invokeBinding: "invokeBinding" },
  users: { findByEmail: "userByEmail" },
};

// A copy of the Repo whose policy reads log their read name and arguments (less the handle) to
// `log` once they return; `after` runs then, before the rule sees the value.
function traced(repo: Repo, log: unknown[][], after?: (read: string) => void): Repo {
  const out: Record<string, unknown> = { ...repo };
  for (const [group, names] of Object.entries(READS)) {
    const src = (repo as unknown as Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>>)[group];
    const copy: Record<string, unknown> = { ...src };
    for (const [method, read] of Object.entries(names)) {
      copy[method] = async (r: unknown, ...args: unknown[]) => {
        const v = await src[method].call(src, r, ...args);
        log.push([read, ...args]);
        after?.(read);
        return v;
      };
    }
    out[group] = copy;
  }
  return out as unknown as Repo;
}

// Every rule literal policy.ts can return, as rule:allow / rule:deny.
function ruleLiterals(): string[] {
  const src = readFileSync(join(import.meta.dir, "policy.ts"), "utf8").split("\n").filter(l => !l.trim().startsWith("//")).join("\n");
  const out = new Set<string>();
  for (const m of src.matchAll(/\ballow\("([\w.]+)"[,)]/g)) out.add(`${m[1]}:allow`);
  for (const m of src.matchAll(/\bdeny\("([\w.]+)"/g)) out.add(`${m[1]}:deny`);
  for (const m of src.matchAll(/\{ allow: ([^}]*?), rule: "([\w.]+)" \}/g)) {
    if (m[1] !== "false") out.add(`${m[2]}:allow`);
    if (m[1] !== "true") out.add(`${m[2]}:deny`);
  }
  // attachment.read's carrier map: readable ? allow(rule) : deny(rule).
  for (const m of src.matchAll(/(?:post|message|unbound): "([\w.]+)"/g)) { out.add(`${m[1]}:allow`); out.add(`${m[1]}:deny`); }
  return [...out].sort();
}

describe("policy drivers agree", () => {
  let f: Fixture;
  beforeEach(async () => { f = await fixture(); });

  test("every rule literal has a row", () => {
    const covered = new Set(rows(f).map(r => `${r.rule}:${r.allow ? "allow" : "deny"}`));
    const literals = ruleLiterals();
    expect(literals.length).toBeGreaterThan(40);
    expect(literals.filter(l => !covered.has(l))).toEqual([]);
  });

  test("the oracle, authorize on the read handle and authorize in a body give each row's decision", async () => {
    for (const row of rows(f)) {
      const ctx = row.ctx ?? { humanReach: "team" };
      const now = oracle(f.repo, f.db, ctx, row.req);
      expect({ name: row.name, ...now }).toMatchObject({ name: row.name, allow: row.allow, rule: row.rule });
      expect({ name: row.name, ...(await authorize(f.repo, f.repo.read, ctx, row.req)) }).toEqual({ name: row.name, ...now });
      expect({ name: row.name, ...(await f.repo.write(tx => authorize(f.repo, tx, ctx, row.req))) }).toEqual({ name: row.name, ...now });
    }
  });

  test("the oracle and authorize see a body's own uncommitted write, and neither its rollback", async () => {
    const req: AuthzRequest = { verb: "delegate.to", from_user: "b@example.com", to_user: "c@example.com" };
    const inside = await f.repo.write(async tx => {
      await f.repo.teams.addMember(tx, f.ops.id, f.b.id, NO_MEMBER_AUTHORITY);
      return [oracle(f.repo, f.db, {}, req), await authorize(f.repo, tx, {}, req)];
    });
    expect(inside.map(d => d.allow)).toEqual([true, true]);

    const rolledBack = f.repo.write(async tx => {
      await f.repo.teams.removeMember(tx, f.ops.id, f.b.id, NO_MEMBER_AUTHORITY);
      expect([oracle(f.repo, f.db, {}, req).allow, (await authorize(f.repo, tx, {}, req)).allow]).toEqual([false, false]);
      throw new Error("roll back");
    });
    await expect(rolledBack).rejects.toThrow("roll back");
    expect([oracle(f.repo, f.db, {}, req).allow, (await authorize(f.repo, f.repo.read, {}, req)).allow]).toEqual([true, true]);
  });
});

// H1: c's agent reaching d's human. Before: d in x, c not. A commit lands right after the decision's first team read:
// d leaves x, c joins x. Neither state shares a team between them, so the answer is deny; reading each side's teams
// separately would pair d's old teams with c's new ones and allow.
test("a membership change between a decision's reads gives no allow neither state gives", async () => {
  const f = await fixture();
  const req: AuthzRequest = { verb: "human.reach", from: "c@example.com/x", to: "d@example.com/human" };
  let committed = false;
  const log: unknown[][] = [];
  const t = traced(f.repo, log, read => {
    if (committed || !["teamsOf", "shareAny"].includes(read)) return;
    committed = true;
    seedSync(f.repo, () => {
      f.db.run("DELETE FROM team_members WHERE team_id = ? AND user_id = ?", [f.x.id, f.d.id]);
      f.db.run("INSERT INTO team_members (team_id, user_id, joined_at) VALUES (?, ?, 0)", [f.x.id, f.c.id]);
    });
  });
  const d = await authorize(t, t.read, { humanReach: "team" }, req);
  expect(committed).toBe(true);
  expect(d).toMatchObject({ allow: false, rule: "human.teammates" });
  // The committed state alone denies too.
  expect((await authorize(f.repo, f.repo.read, { humanReach: "team" }, req)).allow).toBe(false);
});
