import type { Repo } from "./db.ts";
import type { Config } from "./config.ts";
import {
  verifySessionToken, extractBearer, exchangeGoogleCode,
  mintToken, hashToken, type AuthedUser,
} from "./auth.ts";
import { writeAudit } from "./audit.ts";
import { canAdmin, type SendPrincipal } from "./can_send.ts";
import { isValidIdentityName } from "../shared/addressing.ts";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

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

function requireAuth(req: Request, repo: Repo): AuthedUser | null {
  const raw = extractBearer(req);
  if (!raw) return null;
  return verifySessionToken(raw, repo);
}

async function parseBody<T>(req: Request): Promise<T | null> {
  try { return (await req.json()) as T; } catch { return null; }
}

function makePrincipal(authed: AuthedUser, repo: Repo): SendPrincipal | null {
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

// ── identities ────────────────────────────────────────────────────────────────

function identityList(authed: AuthedUser, repo: Repo): Response {
  return json(repo.identities.listForUser(authed.user_id).map(i => ({ name: i.name, created_at: i.created_at })));
}

async function identityCreate(req: Request, authed: AuthedUser, repo: Repo): Promise<Response> {
  const body = await parseBody<{ name: string }>(req);
  if (!body?.name) return badRequest("name required");
  const name = body.name.toLowerCase();
  if (!isValidIdentityName(name)) return badRequest("invalid identity name");
  const existing = repo.identities.findByUserAndName(authed.user_id, name);
  if (existing) return conflict(`identity "${name}" already exists`);
  const identity = repo.identities.create(authed.user_id, name);
  writeAudit(repo, "identity.created", authed.user_email, name);
  return json({ name: identity.name, created_at: identity.created_at }, 201);
}

function identityDelete(name: string, authed: AuthedUser, repo: Repo): Response {
  name = name.toLowerCase();
  const existing = repo.identities.findByUserAndName(authed.user_id, name);
  if (!existing) return notFound();
  repo.identities.remove(authed.user_id, name);
  writeAudit(repo, "identity.deleted", authed.user_email, name);
  return json({ ok: true });
}

// ── teams ────────────────────────────────────────────────────────────────────

function teamList(authed: AuthedUser, repo: Repo): Response {
  return json(repo.teams.listForUser(authed.user_id).map(t => ({ name: t.name, created_at: t.created_at })));
}

async function teamCreate(req: Request, authed: AuthedUser, repo: Repo): Promise<Response> {
  const body = await parseBody<{ name: string }>(req);
  if (!body?.name) return badRequest("name required");
  const name = body.name.toLowerCase();
  if (!isValidIdentityName(name)) return badRequest("invalid team name");
  if (repo.teams.findByName(name)) return conflict(`team "${name}" already exists`);
  const team = repo.teams.create(name, authed.user_id);
  repo.teams.addMember(team.id, authed.user_id);
  writeAudit(repo, "team.created", authed.user_email, name);
  writeAudit(repo, "team.member_added", authed.user_email, name, { member: authed.user_email });
  return json({ name: team.name, created_at: team.created_at }, 201);
}

function teamJoin(teamName: string, authed: AuthedUser, repo: Repo): Response {
  const team = repo.teams.findByName(teamName.toLowerCase());
  if (!team) return notFound();
  repo.teams.addMember(team.id, authed.user_id);
  // Initialize team cursors for all existing identities of this user
  const identities = repo.identities.listForUser(authed.user_id);
  for (const ident of identities) {
    repo.cursors.initTeamCursorToCurrentMax(ident.id, `team:${team.name}`);
  }
  writeAudit(repo, "team.member_added", authed.user_email, team.name, { member: authed.user_email });
  return json({ ok: true });
}

function teamLeave(teamName: string, authed: AuthedUser, repo: Repo): Response {
  const team = repo.teams.findByName(teamName.toLowerCase());
  if (!team) return notFound();
  repo.teams.removeMember(team.id, authed.user_id);
  writeAudit(repo, "team.member_removed", authed.user_email, team.name, { member: authed.user_email });
  return json({ ok: true });
}

function teamMembers(teamName: string, _authed: AuthedUser, repo: Repo): Response {
  const team = repo.teams.findByName(teamName.toLowerCase());
  if (!team) return notFound();
  return json(repo.teams.listMembers(team.id));
}

// ── admin ────────────────────────────────────────────────────────────────────

async function adminRevokeSession(req: Request, authed: AuthedUser, repo: Repo): Promise<Response> {
  const body = await parseBody<{ email: string; all?: boolean }>(req);
  if (!body?.email) return badRequest("email required");
  const target = repo.users.findByEmail(body.email.toLowerCase());
  if (!target) return notFound();
  if (body.all) {
    repo.sessions.revokeAllForUser(target.id);
  } else {
    // revoke the most recent active session (best-effort for CLI usage)
    repo.sessions.revokeAllForUser(target.id);
  }
  writeAudit(repo, "auth.session_revoked", authed.user_email, body.email, { all: body.all ?? true });
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

export async function handleHttp(req: Request, repo: Repo, config: Config): Promise<Response> {
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

  if (path === "/api/identities" && method === "GET")  return identityList(authed, repo);
  if (path === "/api/identities" && method === "POST") return identityCreate(req, authed, repo);
  if (path.startsWith("/api/identities/") && method === "DELETE") {
    return identityDelete(path.slice("/api/identities/".length), authed, repo);
  }

  if (path === "/api/teams" && method === "GET")  return teamList(authed, repo);
  if (path === "/api/teams" && method === "POST") return teamCreate(req, authed, repo);

  const teamOp = path.match(/^\/api\/teams\/([^/]+)\/([^/]+)$/);
  if (teamOp) {
    const [, teamName, action] = teamOp;
    if (action === "join"    && method === "POST") return teamJoin(teamName, authed, repo);
    if (action === "leave"   && method === "POST") return teamLeave(teamName, authed, repo);
    if (action === "members" && method === "GET")  return teamMembers(teamName, authed, repo);
  }

  if (path === "/api/admin/revoke-session" && method === "POST") return adminRevokeSession(req, authed, repo);
  if (path === "/api/admin/disable-user"   && method === "POST") return adminDisableUser(req, authed, repo);
  if (path === "/api/admin/enable-user"    && method === "POST") return adminEnableUser(req, authed, repo);

  return notFound();
}
