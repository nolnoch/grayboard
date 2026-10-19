import type { Repo, Team } from "./db.ts";
import type { Config } from "./config.ts";
import {
  verifySessionToken, extractBearer, exchangeGoogleCode,
  mintToken, hashToken, type AuthedUser,
} from "./auth.ts";
import { writeAudit } from "./audit.ts";
import { canAdmin, type SendPrincipal } from "./can_send.ts";
import { isValidIdentityName } from "../shared/addressing.ts";
import { forgetHandle, getBoard, type CoreDb } from "../core/boards.ts";
import { listClaims } from "../core/claims.ts";
import { ensureTeamBoard, onIdentityCreated, onTeamJoined, onTeamLeft } from "./teams.ts";

// ── helpers ──────────────────────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}
function jsonErr(code: string, message: string, status: number): Response {
  return json({ code, message }, status);
}
function notFound(): Response { return jsonErr("not_found", "not found", 404); }
function badRequest(msg: string): Response { return jsonErr("bad_request", msg, 400); }
function conflict(msg: string): Response { return jsonErr("conflict", msg, 409); }
function forbidden(msg: string): Response { return jsonErr("forbidden", msg, 403); }

function requireAuth(req: Request, repo: Repo): AuthedUser | null {
  const raw = extractBearer(req);
  if (!raw) return null;
  return verifySessionToken(raw, repo);
}

async function parseBody<T>(req: Request): Promise<T | null> {
  try { return (await req.json()) as T; } catch { return null; }
}

function makePrincipal(authed: AuthedUser): SendPrincipal {
  // Used only for canAdmin — identity_id can be 0 since admin doesn't need it
  return {
    user_id:       authed.user_id,
    user_email:    authed.user_email,
    identity_id:   0,
    identity_name: "",
    identity_full: "",
  };
}

// ── route handlers ────────────────────────────────────────────────────────────

async function healthz(repo: Repo): Promise<Response> {
  try {
    repo.users.findByEmail("__healthz__");
    return json({ ok: true });
  } catch (e) {
    return jsonErr("internal", "db not reachable", 503);
  }
}

function authConfig(config: Config): Response {
  // Public bootstrap endpoint. Returns only non-secret values the CLI needs to
  // start the PKCE loopback flow against Google. The client_secret never appears here.
  return json({
    google_client_id: config.googleClientId,
    org_domain:       config.orgDomain,
  });
}

async function authExchange(req: Request, repo: Repo, config: Config): Promise<Response> {
  const body = await parseBody<{ code: string; code_verifier: string; redirect_uri: string }>(req);
  if (!body?.code || !body.code_verifier || !body.redirect_uri) {
    return badRequest("code, code_verifier, redirect_uri required");
  }
  let email: string, displayName: string | null;
  try {
    ({ email, displayName } = await exchangeGoogleCode(
      body.code, body.code_verifier, body.redirect_uri,
      config.googleClientId, config.googleClientSecret, config.orgDomain,
    ));
  } catch (e) {
    return jsonErr("forbidden", String(e), 403);
  }
  const user = repo.users.upsertByEmail(email, displayName ?? null);
  const raw  = mintToken();
  const ua   = req.headers.get("user-agent")?.slice(0, 120) ?? null;
  repo.sessions.create(user.id, hashToken(raw), ua);
  writeAudit(repo, "auth.login", email, null, {
    ip: req.headers.get("x-forwarded-for") ?? undefined,
    ua: ua ?? undefined,
  });
  return json({ session_token: raw, user_email: email, expires_at: null });
}

async function devLogin(req: Request, repo: Repo): Promise<Response> {
  const body = await parseBody<{ email: string }>(req);
  if (!body?.email) return badRequest("email required");
  const email = body.email.toLowerCase();
  const user  = repo.users.upsertByEmail(email, null);
  const raw   = mintToken();
  repo.sessions.create(user.id, hashToken(raw), "dev");
  writeAudit(repo, "auth.login", email, null, { dev: true });
  return json({ session_token: raw, user_email: email, expires_at: null });
}

function authLogout(authed: AuthedUser, repo: Repo): Response {
  repo.sessions.revoke(authed.session_id);
  writeAudit(repo, "auth.logout", authed.user_email, null);
  return json({ ok: true });
}

function whoami(authed: AuthedUser, repo: Repo): Response {
  const identities = repo.identities.listForUser(authed.user_id).map(i => i.name);
  const teams      = repo.teams.listForUser(authed.user_id).map(t => t.name);
  return json({ email: authed.user_email, identities, teams });
}

// ── claims ────────────────────────────────────────────────────────────────────

// For `grayboard claims`. Signed in as a user, not one handle, so a claim's
// board, which a handle may not be able to see, is left out.
function claimList(url: URL, db: CoreDb): Response {
  const prefix = url.searchParams.get("prefix") ?? undefined;
  return json(listClaims(db, prefix).map(({ board: _b, ...c }) => c));
}

// ── identities ────────────────────────────────────────────────────────────────

function identityList(authed: AuthedUser, repo: Repo): Response {
  return json(repo.identities.listForUser(authed.user_id).map(i => ({ name: i.name, created_at: i.created_at })));
}

async function identityCreate(req: Request, authed: AuthedUser, repo: Repo, db: CoreDb): Promise<Response> {
  const body = await parseBody<{ name: string }>(req);
  if (!body?.name) return badRequest("name required");
  const name = body.name.toLowerCase();
  if (!isValidIdentityName(name)) return badRequest("invalid identity name");
  const existing = repo.identities.findByUserAndName(authed.user_id, name);
  if (existing) return conflict(`identity "${name}" already exists`);
  const identity = repo.identities.create(authed.user_id, name);
  writeAudit(repo, "identity.created", authed.user_email, name);
  onIdentityCreated(db, repo, authed.user_id, `${authed.user_email}/${name}`);
  return json({ name: identity.name, created_at: identity.created_at }, 201);
}

function identityDelete(name: string, authed: AuthedUser, repo: Repo, db: CoreDb): Response {
  name = name.toLowerCase();
  const existing = repo.identities.findByUserAndName(authed.user_id, name);
  if (!existing) return notFound();
  repo.identities.remove(authed.user_id, name);
  forgetHandle(db, `${authed.user_email}/${name}`);
  writeAudit(repo, "identity.deleted", authed.user_email, name);
  return json({ ok: true });
}

// ── teams ────────────────────────────────────────────────────────────────────

function teamList(authed: AuthedUser, repo: Repo): Response {
  return json(repo.teams.listForUser(authed.user_id).map(t => ({ name: t.name, created_at: t.created_at })));
}

async function teamCreate(req: Request, authed: AuthedUser, repo: Repo, db: CoreDb): Promise<Response> {
  const body = await parseBody<{ name: string }>(req);
  if (!body?.name) return badRequest("name required");
  const name = body.name.toLowerCase();
  if (!isValidIdentityName(name)) return badRequest("invalid team name");
  if (repo.teams.findByName(name)) return conflict(`team "${name}" already exists`);
  // The team's board shares its name, so the name must be free as a board too.
  if (getBoard(db, name)) return conflict(`a board named "#${name}" already exists`);
  const team = repo.teams.create(name, authed.user_id);
  repo.teams.addMember(team.id, authed.user_id);
  ensureTeamBoard(db, team, authed.user_email);
  onTeamJoined(db, repo, team, authed.user_id, authed.user_email);
  writeAudit(repo, "team.created", authed.user_email, name);
  writeAudit(repo, "team.member_added", authed.user_email, name, { member: authed.user_email });
  return json({ name: team.name, created_at: team.created_at }, 201);
}

// Teams are invite-only: members add people. Older CLIs still offer `team join`.
function teamJoin(): Response {
  return forbidden("teams are invite-only; ask a member to run: grayboard team add <team> <your email>");
}

// A team the caller isn't in reads as not found, like its board.
function memberTeam(teamName: string, authed: AuthedUser, repo: Repo): Team | null {
  const team = repo.teams.findByName(teamName.toLowerCase());
  return team && repo.teams.isMember(team.id, authed.user_id) ? team : null;
}

// Members manage their team; admins can manage any team, e.g. one whose last
// member left. as_admin marks the audit row when an admin isn't a member.
function managedTeam(teamName: string, authed: AuthedUser, repo: Repo, config: Config): { team: Team; audit: { as_admin?: true } } | null {
  const team = memberTeam(teamName, authed, repo);
  if (team) return { team, audit: {} };
  if (!canAdmin(makePrincipal(authed), config.admins).allow) return null;
  const any = repo.teams.findByName(teamName.toLowerCase());
  return any ? { team: any, audit: { as_admin: true } } : null;
}

function teamLeave(teamName: string, authed: AuthedUser, repo: Repo, db: CoreDb): Response {
  const team = memberTeam(teamName, authed, repo);
  if (!team) return notFound();
  repo.teams.removeMember(team.id, authed.user_id);
  onTeamLeft(db, repo, team, authed.user_id, authed.user_email);
  writeAudit(repo, "team.member_removed", authed.user_email, team.name, { member: authed.user_email });
  return json({ ok: true });
}

async function teamAdd(teamName: string, req: Request, authed: AuthedUser, repo: Repo, db: CoreDb, config: Config): Promise<Response> {
  const managed = managedTeam(teamName, authed, repo, config);
  if (!managed) return notFound();
  const { team } = managed;
  const body = await parseBody<{ email: string }>(req);
  if (!body?.email) return badRequest("email required");
  const email = body.email.toLowerCase();
  const user  = repo.users.findByEmail(email);
  if (!user) return jsonErr("not_found", `${email} has never signed in to grayboard; they need to run grayboard login first`, 404);
  repo.teams.addMember(team.id, user.id);
  onTeamJoined(db, repo, team, user.id, email);
  writeAudit(repo, "team.member_added", authed.user_email, team.name, { member: email, ...managed.audit });
  return json({ ok: true });
}

async function teamRemove(teamName: string, req: Request, authed: AuthedUser, repo: Repo, db: CoreDb, config: Config): Promise<Response> {
  const managed = managedTeam(teamName, authed, repo, config);
  if (!managed) return notFound();
  const { team } = managed;
  const body = await parseBody<{ email: string }>(req);
  if (!body?.email) return badRequest("email required");
  const email = body.email.toLowerCase();
  const user  = repo.users.findByEmail(email);
  if (!user || !repo.teams.isMember(team.id, user.id)) {
    return jsonErr("not_found", `${email} is not a member of team "${team.name}"`, 404);
  }
  repo.teams.removeMember(team.id, user.id);
  onTeamLeft(db, repo, team, user.id, email);
  writeAudit(repo, "team.member_removed", authed.user_email, team.name, { member: email, ...managed.audit });
  return json({ ok: true });
}

function teamMembers(teamName: string, authed: AuthedUser, repo: Repo, config: Config): Response {
  const managed = managedTeam(teamName, authed, repo, config);
  if (!managed) return notFound();
  return json(repo.teams.listMembers(managed.team.id));
}

// ── admin ────────────────────────────────────────────────────────────────────

// Revokes every session the user has; there's no session id to pick one by.
// Older CLIs send all: true, which is ignored.
async function adminRevokeSession(req: Request, authed: AuthedUser, repo: Repo): Promise<Response> {
  const body = await parseBody<{ email: string }>(req);
  if (!body?.email) return badRequest("email required");
  const target = repo.users.findByEmail(body.email.toLowerCase());
  if (!target) return notFound();
  repo.sessions.revokeAllForUser(target.id);
  writeAudit(repo, "auth.session_revoked", authed.user_email, body.email);
  return json({ ok: true });
}

async function adminDisableUser(req: Request, authed: AuthedUser, repo: Repo): Promise<Response> {
  const body = await parseBody<{ email: string }>(req);
  if (!body?.email) return badRequest("email required");
  const target = repo.users.findByEmail(body.email.toLowerCase());
  if (!target) return notFound();
  repo.users.setDisabled(target.id, true);
  writeAudit(repo, "auth.user_disabled", authed.user_email, body.email);
  return json({ ok: true });
}

async function adminEnableUser(req: Request, authed: AuthedUser, repo: Repo): Promise<Response> {
  const body = await parseBody<{ email: string }>(req);
  if (!body?.email) return badRequest("email required");
  const target = repo.users.findByEmail(body.email.toLowerCase());
  if (!target) return notFound();
  repo.users.setDisabled(target.id, false);
  writeAudit(repo, "auth.user_enabled", authed.user_email, body.email);
  return json({ ok: true });
}

// ── main router ──────────────────────────────────────────────────────────────

export async function handleHttp(req: Request, repo: Repo, db: CoreDb, config: Config): Promise<Response> {
  const url    = new URL(req.url);
  const path   = url.pathname;
  const method = req.method;

  if (path === "/healthz" && method === "GET") return healthz(repo);
  if (path === "/api/auth/config"    && method === "GET")  return authConfig(config);
  if (path === "/api/auth/exchange"  && method === "POST") return authExchange(req, repo, config);
  if (path === "/api/auth/dev-login" && method === "POST") {
    if (!config.devAuth) return notFound();
    return devLogin(req, repo);
  }

  const authed = requireAuth(req, repo);
  if (!authed) return jsonErr("unauthenticated", "invalid or missing token", 401);

  if (path === "/api/auth/logout" && method === "POST") return authLogout(authed, repo);
  if (path === "/api/whoami"      && method === "GET")  return whoami(authed, repo);

  if (path === "/api/claims" && method === "GET") return claimList(url, db);

  if (path === "/api/identities" && method === "GET")  return identityList(authed, repo);
  if (path === "/api/identities" && method === "POST") return identityCreate(req, authed, repo, db);
  if (path.startsWith("/api/identities/") && method === "DELETE") {
    return identityDelete(path.slice("/api/identities/".length), authed, repo, db);
  }

  if (path === "/api/teams" && method === "GET")  return teamList(authed, repo);
  if (path === "/api/teams" && method === "POST") return teamCreate(req, authed, repo, db);

  const teamOp = path.match(/^\/api\/teams\/([^/]+)\/([^/]+)$/);
  if (teamOp) {
    const [, teamName, action] = teamOp;
    if (action === "join"    && method === "POST") return teamJoin();
    if (action === "leave"   && method === "POST") return teamLeave(teamName, authed, repo, db);
    if (action === "add"     && method === "POST") return teamAdd(teamName, req, authed, repo, db, config);
    if (action === "remove"  && method === "POST") return teamRemove(teamName, req, authed, repo, db, config);
    if (action === "members" && method === "GET")  return teamMembers(teamName, authed, repo, config);
  }

  if (path.startsWith("/api/admin/")) {
    const decision = canAdmin(makePrincipal(authed), config.admins);
    if (!decision.allow) return forbidden(decision.reason);
  }
  if (path === "/api/admin/revoke-session" && method === "POST") return adminRevokeSession(req, authed, repo);
  if (path === "/api/admin/disable-user"   && method === "POST") return adminDisableUser(req, authed, repo);
  if (path === "/api/admin/enable-user"    && method === "POST") return adminEnableUser(req, authed, repo);

  return notFound();
}
