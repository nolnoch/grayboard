import pkg from "../../package.json" with { type: "json" };
import { PrincipalTaken, type Repo, type Team } from "./db.ts";
import { mayActIn } from "./access.ts";
import type { Config } from "./config.ts";
import {
  verifySessionToken, extractBearer, exchangeGoogleCode,
  mintToken, hashToken, type AuthedUser, type TouchQueue,
} from "./auth.ts";
import { readableAttachment, releaseStored, storeUpload } from "./attachments.ts";
import { UploadTimeout, readUploadBody, type UploadGate } from "./uploads.ts";
import { userAgent, writeAudit } from "./audit.ts";
import { canAdmin } from "./can_send.ts";
import { HUMAN_NAME, HUMAN_RESERVED, isValidEmail, isValidIdentityName } from "../shared/addressing.ts";
import { forgetHandle, getBoard, type CoreDb } from "../core/boards.ts";
import { addressParts } from "../core/addresses.ts";
import { BlobMissing, CoreError, TooLargeError } from "../core/errors.ts";
import { transferTimeoutMs } from "../shared/http.ts";
import { listClaims } from "../core/claims.ts";
import { addressSet, aliasHeldText, aliasUser, idRow } from "../core/bindings.ts";
import { callBoardTool } from "../core/tools.ts";
import { SizeTally, checkFile, contentDisposition, reprDigest, sanitizeFilename } from "../shared/attachments.ts";
import { ensureTeamBoard, onAliasCreated, onTeamJoined, onTeamLeft } from "./teams.ts";
import type { SlackLinker } from "./slack.ts";

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

function requireAuth(req: Request, repo: Repo, touches: TouchQueue): AuthedUser | null {
  const raw = extractBearer(req);
  if (!raw) return null;
  return verifySessionToken(raw, repo, touches);
}

async function parseBody<T>(req: Request): Promise<T | null> {
  try { return (await req.json()) as T; } catch { return null; }
}

// ── route handlers ────────────────────────────────────────────────────────────

async function healthz(repo: Repo): Promise<Response> {
  try {
    repo.users.findByEmail("__healthz__");
    // The version lets a deploy check tell a restarted server from a stale one.
    return json({ ok: true, version: pkg.version });
  } catch (e) {
    // A deploy check that sees this 503 needs the cause in the journal.
    console.error(`[grayboard] healthz: ${(e as Error).stack ?? e}`);
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


// A sign-in body must be JSON (#240): a cross-origin page can't send that
// without a CORS preflight, so it can't spend an office's sign-in budget.
export function isJsonRequest(req: Request): boolean {
  return req.headers.get("content-type")?.split(";")[0]!.trim().toLowerCase() === "application/json";
}

async function authExchange(req: Request, repo: Repo, config: Config, ip: string | null): Promise<Response> {
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
  if (!isValidEmail(email)) return jsonErr("forbidden", `grayboard can't address "${email}"`, 403);
  const user = repo.users.upsertByEmail(email, displayName ?? null);
  const raw  = mintToken();
  const ua   = userAgent(req);
  repo.sessions.create(user.id, hashToken(raw), ua);
  writeAudit(repo, "auth.login", email, null, {
    ip: ip ?? undefined,
    ua: ua ?? undefined,
  });
  return json({ session_token: raw, user_email: email, expires_at: null });
}

async function devLogin(req: Request, repo: Repo, ip: string | null): Promise<Response> {
  const body = await parseBody<{ email: string }>(req);
  if (!body?.email) return badRequest("email required");
  const email = body.email.toLowerCase();
  if (!isValidEmail(email)) return badRequest(`grayboard can't address "${email}"`);
  const user  = repo.users.upsertByEmail(email, null);
  const raw   = mintToken();
  repo.sessions.create(user.id, hashToken(raw), "dev");
  writeAudit(repo, "auth.login", email, null, { dev: true, ip: ip ?? undefined });
  return json({ session_token: raw, user_email: email, expires_at: null });
}

// Sign-in routes: each call costs the caller's address an auth failure
// (#240), charged on entry while the route is enabled. The router dispatches
// them from this table, so a route can't be served without being charged.
// The OAuth AS routes stay out: oauth.fetch answers them first (app.ts) under
// its own limiter, and charges token and revocation posts only for refused
// grant material, since they must take form posts (#283).
type SignInHandler = (req: Request, repo: Repo, config: Config, ip: string | null) => Promise<Response>;
const SIGN_IN_ROUTES = new Map<string, { enabled: (config: Config) => boolean; handle: SignInHandler }>([
  ["/api/auth/exchange", { enabled: () => true, handle: authExchange }],
  ["/api/auth/dev-login", { enabled: (config) => config.devAuth, handle: (req, repo, _config, ip) => devLogin(req, repo, ip) }],
]);

/** The sign-in route `method` and `path` name, if any: whether it's on (and
 *  so charged), and its handler, which a route that's off doesn't reach. */
export function signInRoute(method: string, path: string, config: Config): { charged: boolean; handle: SignInHandler } | null {
  const r = method === "POST" ? SIGN_IN_ROUTES.get(path) : undefined;
  if (!r) return null;
  const on = r.enabled(config);
  return { charged: on, handle: on ? r.handle : async () => notFound() };
}

// Revoke first, so a reconnect cannot succeed; the open connections of this
// token close in the same tick (#351).
function authLogout(authed: AuthedUser, repo: Repo, disconnectSession: SessionHooks["disconnectSession"]): Response {
  repo.sessions.revoke(authed.session_id);
  writeAudit(repo, "auth.logout", authed.user_email, null, { token_session: authed.session_id });
  disconnectSession(authed.session_id, "logout");
  return json({ ok: true });
}

function whoami(authed: AuthedUser, repo: Repo): Response {
  const identities = repo.aliases.listForScope("person", authed.user_email).map(i => i.name);
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

// An address the caller may act as (#284 S11), in full, or the refusal: a
// bare name means the caller's own person scope; an alias must exist, in
// the caller's scope or a team's it belongs to, and never be a human
// (`humanReason` says why); a session ID must be the caller's, live and no
// viewer, so nothing acts as an ended session.
function ownAddress(input: string | null | undefined, authed: AuthedUser, repo: Repo, db: CoreDb, humanReason: string): string | Response {
  if (!input) return badRequest("as required: the address to act as");
  const p = addressParts(input);
  if (!p || p.kind === "team") return badRequest(`"${input}" isn't an alias or a session ID`);
  if (p.kind === "id") {
    const row = idRow(db, p.address);
    if (!row || row.viewer || row.principal !== authed.user_email) return forbidden(`${p.address} isn't a session of yours`);
    if (row.ended_at !== null) return forbidden(`${p.address} ended at ${new Date(row.ended_at).toISOString()}`);
    return p.address;
  }
  const address = p.kind === "bare" ? `${authed.user_email}/${p.name}` : p.address;
  if (p.name === HUMAN_NAME) return forbidden(humanReason);
  const owner = repo.resolver.principalOf(address);
  const no = owner
    ? mayActIn(repo, { kind: "user", name: authed.user_email }, { scope_kind: owner.kind === "user" ? "person" : owner.kind, scope_ref: owner.name })
    : "no principal owns its scope";
  if (no) return forbidden(`you can't act as "${address}": ${no}`);
  if (!repo.aliases.find(address)) {
    return jsonErr("unknown_identity", `no session has used "${address}"; check which handle this shell acts as with grayboard whoami, or pass --as`, 404);
  }
  // An alias in use by another user's session is exclusive (#284 S8, decided);
  // the caller's own sessions' uses aren't refused (a tools-only sidecar, #182).
  const other = aliasUser(db, address, authed.user_email);
  if (other) return jsonErr("alias_held", aliasHeldText(address, `another user's session ${other}`, "act as another name"), 409);
  return address;
}

// For `grayboard claim`: a claim tool run as one of the caller's identities.
const CLAIM_TOOLS = new Set(["claim_take", "claim_release", "claim_watch"]);

async function claimCall(req: Request, authed: AuthedUser, repo: Repo, db: CoreDb, wake: (handles: string[]) => void, onBoardsChanged?: (boards: string[]) => void | Promise<void>): Promise<Response> {
  const body = await parseBody<{ identity?: string; tool?: string; args?: Record<string, unknown> }>(req);
  if (!body?.identity || !body.tool || !CLAIM_TOOLS.has(body.tool)) return badRequest("identity and a claim tool required");
  const handle = ownAddress(body.identity, authed, repo, db, `claims are for agents; "${HUMAN_NAME}" is your Slack link`);
  if (handle instanceof Response) return handle;
  if (body.args?.as !== undefined) return badRequest("name the address to act as in identity, not args.as");
  try {
    // As the session the identity is or is held by: its claims under any of
    // its addresses are its own here (#360).
    const outcome = callBoardTool(db, handle, body.tool, body.args ?? {}, { addresses: addressSet(db, handle, authed.user_email) });
    if (outcome.boards?.length) {
      try { void Promise.resolve(onBoardsChanged?.(outcome.boards)).catch(() => {}); } catch {}
    }
    wake(outcome.wake);
    return json(outcome.result);
  } catch (e) {
    if (e instanceof CoreError) return badRequest(e.message);
    throw e;
  }
}

// ── identities ────────────────────────────────────────────────────────────────

function identityList(authed: AuthedUser, repo: Repo): Response {
  return json(repo.aliases.listForScope("person", authed.user_email).map(i => ({ name: i.name, created_at: i.created_at })));
}

async function identityCreate(req: Request, authed: AuthedUser, repo: Repo, db: CoreDb): Promise<Response> {
  const body = await parseBody<{ name: string }>(req);
  if (!body?.name) return badRequest("name required");
  const name = body.name.toLowerCase();
  if (!isValidIdentityName(name)) return badRequest("invalid identity name");
  if (name === HUMAN_NAME) return badRequest(HUMAN_RESERVED);
  const existing = repo.aliases.find(`${authed.user_email}/${name}`);
  if (existing) return conflict(`identity "${name}" already exists`);
  const identity = repo.aliases.create({ scope_kind: "person", scope_ref: authed.user_email, name }, authed.user_email);
  writeAudit(repo, "alias.created", authed.user_email, identity.address);
  onAliasCreated(db, repo, authed.user_id, identity.address);
  return json({ name: identity.name, created_at: identity.created_at }, 201);
}

function identityDelete(name: string, authed: AuthedUser, repo: Repo, db: CoreDb): Response {
  name = name.toLowerCase();
  if (name === HUMAN_NAME) return badRequest(`"${HUMAN_NAME}" goes away with your Slack link: grayboard slack unlink`);
  const existing = repo.aliases.find(`${authed.user_email}/${name}`);
  if (!existing) return notFound();
  // Its holds and writers would outlive it: a second session could then bind
  // the name while the first still acts as it.
  const user = aliasUser(db, existing.address);
  if (user) return jsonErr("alias_held", aliasHeldText(existing.address, `the session ${user}`, "end it, or bind it elsewhere, first"), 409);
  repo.aliases.remove(existing.address);
  forgetHandle(db, existing.address);
  writeAudit(repo, "alias.deleted", authed.user_email, existing.address);
  return json({ ok: true });
}

// ── attachments ──────────────────────────────────────────────────────────────

// The address named by ?as=. The Slack bridge's human stores its files
// in-process, not here.
function queryAs(url: URL, authed: AuthedUser, repo: Repo, db: CoreDb): string | Response {
  return ownAddress(url.searchParams.get("as"), authed, repo, db, HUMAN_RESERVED);
}

// POST /api/attachments?as=&filename=, the file's bytes as the body.
// The session's MCP process has already checked the path it came from; this
// runs the same checks on what arrives (checkFile, the size caps) plus the
// user's quota of unsent bytes, and stores it unbound, for a dm_send or
// board_post by that identity to carry.
export async function attachmentUpload(req: Request, url: URL, authed: AuthedUser, repo: Repo, db: CoreDb, uploads: UploadGate, guard?: () => void, signal = req.signal): Promise<Response> {
  const handle = queryAs(url, authed, repo, db);
  if (handle instanceof Response) return handle;
  const rawName = url.searchParams.get("filename");
  if (!rawName) return badRequest("filename required");
  const label = `file ${sanitizeFilename(rawName)}`;
  // The body's length is reserved before it's read, so it must be declared.
  const declared = req.headers.get("content-length");
  if (declared === null || !/^\d{1,15}$/.test(declared)) return jsonErr("length_required", "an upload needs a Content-Length", 411);
  const refuse = (code: string, message: string, status: number) => {
    writeAudit(repo, "attachment.upload_refused", authed.user_email, null, { identity: handle, filename: sanitizeFilename(rawName), size: Number(declared), reason: message });
    return jsonErr(code, message, status);
  };
  let release = () => {};
  try {
    // A declared length over the cap is refused before the body is read.
    new SizeTally(repo.attachmentLimits, 1).add(label, Number(declared));
    guard?.();
    release = await uploads.reserve(authed.user_email, Number(declared), signal);
    guard?.();
    const data = await readUploadBody(req, Number(declared), transferTimeoutMs(Number(declared)), guard ? signal : undefined);
    guard?.();
    if (guard && data.length !== Number(declared)) return refuse("bad_request", "the body is shorter than its Content-Length", 400);
    new SizeTally(repo.attachmentLimits, 1).add(label, data.length);
    const row = await storeUpload(repo, db, authed.user_email, handle, checkFile(label, rawName, data), {}, guard);
    try { guard?.(); } catch (error) {
      await releaseStored(repo, db, authed.user_email, handle, row.id);
      throw error;
    }
    return json({ id: row.id, filename: row.filename, type: row.type, size: row.size, sha256: row.sha256 }, 201);
  } catch (e) {
    if (e instanceof TooLargeError) return refuse("too_large", e.message, 413);
    if (e instanceof UploadTimeout) return refuse("timeout", e.message, 408);
    if (e instanceof CoreError) return refuse("bad_request", e.message, 400);
    // A fault (disk full, unwritable blob dir, the client gone mid-wait): the
    // audit keeps it, the server's error handler answers a bare 500.
    writeAudit(repo, "attachment.upload_failed", authed.user_email, null, { identity: handle, filename: sanitizeFilename(rawName), size: Number(declared), error: (e as Error).message });
    throw e;
  } finally {
    try {
      if (guard && req.body && !req.body.locked) await req.body.cancel();
    } finally { release(); }
  }
}

// GET /api/attachments/<id>?as=: the file, for an identity that can
// read the message or post carrying it. One it can't reads as missing.
export async function attachmentDownload(idStr: string, url: URL, authed: AuthedUser, repo: Repo, db: CoreDb, guard?: () => void): Promise<Response> {
  const handle = queryAs(url, authed, repo, db);
  if (handle instanceof Response) return handle;
  const row = readableAttachment(repo, db, handle, Number(idStr), authed.user_email, authed.user_email);
  if (!row) {
    writeAudit(repo, "attachment.download_refused", authed.user_email, `attachment:${idStr.slice(0, 32)}`, { identity: handle });
    return jsonErr("not_found", `no attachment ${idStr.slice(0, 32)} on a message or post you can read`, 404);
  }
  // Audited once the bytes are in hand, so a failed read isn't logged as a download.
  let data: Uint8Array<ArrayBuffer>;
  try {
    data = new Uint8Array(await repo.blobs.get(row.sha256));
  } catch (e) {
    writeAudit(repo, "attachment.download_failed", authed.user_email, `attachment:${row.id}`, { identity: handle, sha256: row.sha256, error: (e as Error).message });
    // Swept between the read check and the read: the file is gone, as a 404 says.
    if (e instanceof BlobMissing) return jsonErr("not_found", `attachment ${row.id}'s bytes are gone`, 404);
    throw e;
  }
  return db.transaction(() => {
  guard?.();
  if (guard) {
    const current = readableAttachment(repo, db, handle, row.id, authed.user_email, authed.user_email);
    if (!current || current.sha256 !== row.sha256) return notFound();
  }
  writeAudit(repo, "attachment.downloaded", authed.user_email, `attachment:${row.id}`, { identity: handle, sha256: row.sha256 });
  return new Response(data, {
    headers: {
      "Content-Type": row.type,
      "Content-Disposition": contentDisposition(row.filename),
      "Repr-Digest": reprDigest(row.sha256),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
  }).immediate();
}

// DELETE /api/attachments/<id>?as=: drops an upload of that identity's
// that no message or post carries, when the send it was for failed.
export async function attachmentRelease(idStr: string, url: URL, authed: AuthedUser, repo: Repo, db: CoreDb, guard?: () => void): Promise<Response> {
  const handle = queryAs(url, authed, repo, db);
  if (handle instanceof Response) return handle;
  guard?.();
  const row = /^\d{1,15}$/.test(idStr) ? await releaseStored(repo, db, authed.user_email, handle, Number(idStr), {}, guard) : null;
  guard?.();
  if (!row) return jsonErr("not_found", `no unsent upload ${idStr.slice(0, 32)} of yours`, 404);
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
  let team: Team;
  try {
    team = repo.teams.create(name, authed.user_id);
  } catch (e) {
    if (e instanceof PrincipalTaken) return conflict(e.message);
    throw e;
  }
  repo.teams.addMember(team.id, authed.user_id);
  ensureTeamBoard(db, team, authed.user_email);
  onTeamJoined(db, repo, team, authed.user_email);
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
  if (!canAdmin(authed.user_email, config.admins).allow) return null;
  const any = repo.teams.findByName(teamName.toLowerCase());
  return any ? { team: any, audit: { as_admin: true } } : null;
}

function teamLeave(teamName: string, authed: AuthedUser, repo: Repo, db: CoreDb, sessions: SessionHooks): Response {
  const team = memberTeam(teamName, authed, repo);
  if (!team) return notFound();
  repo.teams.removeMember(team.id, authed.user_id);
  onTeamLeft(db, repo, team, authed.user_email);
  sessions.accessChanged(authed.user_email, authed.user_email);
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
  onTeamJoined(db, repo, team, email);
  writeAudit(repo, "team.member_added", authed.user_email, team.name, { member: email, ...managed.audit });
  return json({ ok: true });
}

async function teamRemove(teamName: string, req: Request, authed: AuthedUser, repo: Repo, db: CoreDb, config: Config, sessions: SessionHooks): Promise<Response> {
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
  onTeamLeft(db, repo, team, email);
  sessions.accessChanged(email, authed.user_email);
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
async function adminRevokeSession(req: Request, authed: AuthedUser, repo: Repo, disconnectUser: (userId: number) => void): Promise<Response> {
  const body = await parseBody<{ email: string }>(req);
  if (!body?.email) return badRequest("email required");
  const target = repo.users.findByEmail(body.email.toLowerCase());
  if (!target) return notFound();
  repo.sessions.revokeAllForUser(target.id);
  disconnectUser(target.id);
  writeAudit(repo, "auth.session_revoked", authed.user_email, body.email);
  return json({ ok: true });
}

async function adminDisableUser(
  req: Request, authed: AuthedUser, repo: Repo, disconnectUser: (userId: number) => void, slack?: SlackLinker,
): Promise<Response> {
  const body = await parseBody<{ email: string }>(req);
  if (!body?.email) return badRequest("email required");
  const target = repo.users.findByEmail(body.email.toLowerCase());
  if (!target) return notFound();
  repo.users.setDisabled(target.id, true);
  disconnectUser(target.id);
  writeAudit(repo, "auth.user_disabled", authed.user_email, body.email);
  await slack?.userChanged(target.id);
  return json({ ok: true });
}

async function adminEnableUser(req: Request, authed: AuthedUser, repo: Repo, slack?: SlackLinker): Promise<Response> {
  const body = await parseBody<{ email: string }>(req);
  if (!body?.email) return badRequest("email required");
  const target = repo.users.findByEmail(body.email.toLowerCase());
  if (!target) return notFound();
  repo.users.setDisabled(target.id, false);
  writeAudit(repo, "auth.user_enabled", authed.user_email, body.email);
  await slack?.userChanged(target.id);
  return json({ ok: true });
}

// ── main router ──────────────────────────────────────────────────────────────

// What the WebSocket side does when an HTTP action changes who a user's
// sessions may be: a revoked or disabled user's sessions end; a user who
// left a team stops acting as its aliases (#284 S9).
export type SessionHooks = {
  disconnectUser: (userId: number) => void;
  // One token's connections close and their sessions end (#351); why is audited.
  disconnectSession: (tokenSession: number, why: string) => void;
  // principal: a principal's name; its sessions' aliases are re-checked.
  accessChanged: (principal: string, by: string) => void;
};

export async function handleHttp(
  req: Request, repo: Repo, db: CoreDb, config: Config, touches: TouchQueue, uploads: UploadGate, wake: (handles: string[]) => void, slack: SlackLinker | undefined,
  sessions: SessionHooks,
  // The client's address as the auth gate resolved it (src/server/client_addr.ts).
  ip: string | null,
  onBoardsChanged?: (boards: string[]) => void | Promise<void>,
): Promise<Response> {
  const url    = new URL(req.url);
  const path   = url.pathname;
  const method = req.method;

  if (path === "/healthz" && method === "GET") return healthz(repo);
  if (path === "/api/auth/config"    && method === "GET")  return authConfig(config);
  const signIn = signInRoute(method, path, config);
  if (signIn) return signIn.handle(req, repo, config, ip);

  const authed = requireAuth(req, repo, touches);
  if (!authed) return jsonErr("unauthenticated", "invalid or missing token", 401);

  if (path === "/api/auth/logout" && method === "POST") return authLogout(authed, repo, sessions.disconnectSession);
  if (path === "/api/whoami"      && method === "GET")  return whoami(authed, repo);

  if (path === "/api/claims" && method === "GET") return claimList(url, db);
  if (path === "/api/claims/call" && method === "POST") return claimCall(req, authed, repo, db, wake, onBoardsChanged);

  if (path === "/api/attachments" && method === "POST") return attachmentUpload(req, url, authed, repo, db, uploads);
  if (path.startsWith("/api/attachments/") && method === "GET") {
    return attachmentDownload(path.slice("/api/attachments/".length), url, authed, repo, db);
  }
  if (path.startsWith("/api/attachments/") && method === "DELETE") {
    return attachmentRelease(path.slice("/api/attachments/".length), url, authed, repo, db);
  }

  if (path === "/api/identities" && method === "GET")  return identityList(authed, repo);
  if (path === "/api/identities" && method === "POST") return identityCreate(req, authed, repo, db);
  if (path.startsWith("/api/identities/") && method === "DELETE") {
    return identityDelete(path.slice("/api/identities/".length), authed, repo, db);
  }

  if (path.startsWith("/api/slack/") && !slack) {
    return jsonErr("not_found", "this server has no Slack bridge (its admin sets SLACK_APP_TOKEN and SLACK_BOT_TOKEN)", 404);
  }
  // Unlinking still works: it's only database rows.
  if (path === "/api/slack/link" && !slack!.running) {
    return jsonErr("not_found", "this server's Slack bridge isn't running (its admin checks the server log)", 404);
  }
  if (path === "/api/slack/link" && method === "POST") return json(slack!.newCode(authed));
  if (path === "/api/slack/unlink" && method === "POST") {
    return slack!.unlink(authed.user_id) ? json({ ok: true }) : jsonErr("not_found", "you have no Slack link", 404);
  }

  if (path === "/api/teams" && method === "GET")  return teamList(authed, repo);
  if (path === "/api/teams" && method === "POST") return teamCreate(req, authed, repo, db);

  const teamOp = path.match(/^\/api\/teams\/([^/]+)\/([^/]+)$/);
  if (teamOp) {
    const [, teamName, action] = teamOp;
    if (action === "join"    && method === "POST") return teamJoin();
    if (action === "leave"   && method === "POST") return teamLeave(teamName, authed, repo, db, sessions);
    if (action === "add"     && method === "POST") return teamAdd(teamName, req, authed, repo, db, config);
    if (action === "remove"  && method === "POST") return teamRemove(teamName, req, authed, repo, db, config, sessions);
    if (action === "members" && method === "GET")  return teamMembers(teamName, authed, repo, config);
  }

  if (path.startsWith("/api/admin/")) {
    const decision = canAdmin(authed.user_email, config.admins);
    if (!decision.allow) return forbidden(decision.reason);
  }
  if (path === "/api/admin/revoke-session" && method === "POST") return adminRevokeSession(req, authed, repo, sessions.disconnectUser);
  if (path === "/api/admin/disable-user"   && method === "POST") return adminDisableUser(req, authed, repo, sessions.disconnectUser, slack);
  if (path === "/api/admin/enable-user"    && method === "POST") return adminEnableUser(req, authed, repo, slack);

  return notFound();
}
