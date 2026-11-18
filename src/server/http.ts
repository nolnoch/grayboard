import pkg from "../../package.json" with { type: "json" };
import { randomBytes } from "node:crypto";
import { mcpResource, SERVICE_CLIENT_PREFIX } from "./oauth-config.ts";
import { CREDENTIAL_NO_EXPIRY, CREDENTIAL_SOURCES, DEFAULT_SERVICE_TOKEN_LIMITS, OAUTH_TTL, SERVICE_TOKEN_MIN_SECONDS, type CredentialSource } from "./oauth-types.ts";
import { DEV_SESSION_LABEL, LastOwner, PrincipalTaken, TEAM_POLICIES, type Repo, type RoleFilter, type Team, type TeamPolicy, type User } from "./db.ts";
import { DEFAULT_CLI_TOKEN_IDLE_DAYS, type Config } from "./config.ts";
import {
  verifySessionToken, extractBearer,
  mintToken, hashToken, principalOfAuthed, signedIn, type AuthedUser, type TouchQueue,
} from "./auth.ts";
import { defaultProviders } from "./idp.ts";
import { releaseStored, requestAttachment, storeUpload, type Guard } from "./attachments.ts";
import type { Read, Tx } from "./store/tx.ts";
import { UploadTimeout, readUploadBody, type UploadGate } from "./uploads.ts";
import { writeAudit } from "./audit.ts";
import { isLoopbackIp } from "./client_addr.ts";
import { DEFAULT_LAG_GATE, lagSampler, lagVerdict, lagWindows, type LagGate, type LagSampler, type LagWindow } from "./metrics.ts";
import { ROLES, authorize, byAdmin, decidePure, isRole, recordDecision, type AuthzRequest, type Decision, type PureRequest } from "./policy.ts";
import { authorityOf, grantRole, revokeRole, roleSpec, type Granter, type RoleOutcome } from "./roles.ts";
import { HUMAN_NAME, HUMAN_RESERVED, isValidEmail, isValidIdentityName } from "../shared/addressing.ts";
import { addressParts } from "../core/addresses.ts";
import { seenScopeOf } from "../core/boards.ts";
import { BlobMissing, CoreError, TooLargeError } from "../core/errors.ts";
import { transferTimeoutMs } from "../shared/http.ts";
import { testPauseAsync } from "../shared/testpause.ts";
import { aliasHeldText } from "../core/bindings.ts";
import { callClaimTool } from "./claims.ts";
import type { BoardAccess } from "./access.ts";
import { SizeTally, checkFile, contentDisposition, reprDigest, sanitizeFilename } from "../shared/attachments.ts";
import { ALIAS_SCOPE_CAP, aliasCapRefusal } from "./alias_cap.ts";
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

async function requireAuth(req: Request, repo: Repo, touches: TouchQueue, idleDays: number): Promise<AuthedUser | null> {
  const raw = extractBearer(req);
  if (!raw) return null;
  return verifySessionToken(raw, repo, touches, idleDays);
}

async function parseBody<T>(req: Request): Promise<T | null> {
  try { return (await req.json()) as T; } catch { return null; }
}

// ── route handlers ────────────────────────────────────────────────────────────

// /healthz is unauthenticated, so its database probe is cached per repo for HEALTH_TTL_MS, success and failure
// alike (#275): a flood costs one probe a second, and a down database logs one line a second. The probe is a
// synchronous read, so no request can arrive while one is in flight and the cache alone is single-flight.
export const HEALTH_TTL_MS = 1000;
const health = new WeakMap<Repo, { at: number; ok: boolean; lagging?: boolean }>();
export function healthz(repo: Repo, now = performance.now(), gate: LagGate = DEFAULT_LAG_GATE, windows: readonly LagWindow[] = lagWindows(), sampler: LagSampler | null = lagSampler() ?? null): Response {
  let cached = health.get(repo);
  if (!cached || now - cached.at >= HEALTH_TTL_MS) {
    let ok = true;
    try {
      repo.policyNow.userByEmail("__healthz__");
    } catch (e) {
      // A deploy check that sees this 503 needs the cause in the journal.
      console.error(`[grayboard] healthz: ${(e as Error).stack ?? e}`);
      ok = false;
    }
    // The lag verdict outlives the probe's window, so its state-change log line fires once, not every second.
    health.set(repo, cached = { at: now, ok, lagging: cached?.lagging });
  }
  if (!cached.ok) return jsonErr("internal", "db not reachable", 503);
  // Sustained event-loop lag fails the check (#805), with the version kept so a deploy check still
  // tells a restarted server from a stale one. The journal gets one line per change of state.
  const lag = lagVerdict(windows, gate, sampler);
  if (lag.lagging !== !!cached.lagging) {
    cached.lagging = lag.lagging;
    console.error(!lag.lagging ? "[grayboard] healthz: event-loop lag recovered" : lag.stalledS !== undefined ? `[grayboard] healthz: failing on event-loop lag, no lag window finished for ${lag.stalledS.toFixed(1)} s` : `[grayboard] healthz: failing on event-loop lag, p99 ${lag.p99s.map(p => p.toFixed(2)).join("/")} s over the last ${gate.windows} windows`);
  }
  // The per-window p99s and the threshold go to the journal only: this route is public, and the scrape's bind is
  // what guards the server's telemetry.
  if (lag.lagging) return json({ ok: false, version: pkg.version, code: "lagging", message: "event loop lagging" }, 503);

  // The version lets a deploy check tell a restarted server from a stale one.
  return json({ ok: true, version: pkg.version });
}

// A sign-in body must be JSON (#240): a cross-origin page can't send that
// without a CORS preflight, so it can't spend an office's sign-in budget.
export function isJsonRequest(req: Request): boolean {
  return req.headers.get("content-type")?.split(";")[0]!.trim().toLowerCase() === "application/json";
}

// A disabled user gets no dev-login token (security audit F-14); the AS refuses
// one at its callback (oauth.user_refused) and at a code's redemption.
function refuseDisabled(repo: Repo, h: Read, user: User, detail: Record<string, unknown>): Response | null {
  if (user.disabled_at === null) return null;
  writeAudit(repo, h, "auth.user_refused", user.email, null, detail);
  return jsonErr("forbidden", "this account is disabled; ask a grayboard admin to run admin enable-user", 403);
}

async function devLogin(req: Request, repo: Repo, ip: string | null): Promise<Response> {
  // The loopback public URL (config.ts) doesn't stop a remote client: the
  // server listens on every interface, and a proxy forwards to it. Only a
  // client on this host may sign in as anyone (security audit F-04).
  if (!ip || !isLoopbackIp(ip)) {
    writeAudit(repo, repo.read, "auth.dev_login_refused", null, null, { ip: ip ?? undefined });
    return jsonErr("forbidden", "dev sign-in answers only clients on the server's own host", 403);
  }
  const body = await parseBody<{ email: string }>(req);
  if (!body?.email) return badRequest("email required");
  const email = body.email.toLowerCase();
  if (!isValidEmail(email)) return badRequest(`grayboard can't address "${email}"`);
  return repo.write(async tx => {
    const user  = await repo.users.upsertByEmail(tx, email, null);
    const disabled = refuseDisabled(repo, tx, user, { dev: true, ip: ip ?? undefined });
    if (disabled) return disabled;
    const raw   = mintToken();
    await repo.sessions.create(tx, user.id, hashToken(raw), DEV_SESSION_LABEL);
    writeAudit(repo, tx, "auth.login", email, null, { dev: true, ip: ip ?? undefined });
    return json({ session_token: raw, user_email: email, expires_at: null });
  });
}

// Sign-in routes: each call costs the caller's address an auth failure
// (#240), charged on entry while the route is enabled. The router dispatches
// them from this table, so a route can't be served without being charged.
// The OAuth AS routes stay out: oauth.fetch answers them first (app.ts) under
// its own limiter, and charges token and revocation posts only for refused
// grant material, since they must take form posts (#283).
type SignInHandler = (req: Request, repo: Repo, config: Config, ip: string | null) => Promise<Response>;
const SIGN_IN_ROUTES = new Map<string, { enabled: (config: Config) => boolean; handle: SignInHandler }>([
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

function authLogout(authed: AuthedUser, repo: Repo): Promise<Response> {
  return repo.write(async tx => {
    await repo.sessions.revoke(tx, authed.session_id);
    writeAudit(repo, tx, "auth.logout", authed.user_email, null, { token_session: authed.session_id });
    return json({ ok: true });
  });
}

async function whoami(authed: AuthedUser, repo: Repo): Promise<Response> {
  const identities = (await repo.aliases.listForScope(repo.read, "person", authed.user_email)).map(i => i.name);
  const teams      = (await repo.teams.listForUser(repo.read, authed.user_id)).map(t => t.name);
  return json({ email: authed.user_email, identities, teams });
}

// ── claims ────────────────────────────────────────────────────────────────────

// For `grayboard claims`. Signed in as a user, not one handle, so a claim's
// board, which a handle may not be able to see, is left out, and a holder
// whose name the user may not see (a team's alias, outside the team) is
// withheld with its note, as claim_list does (#871).
async function claimList(url: URL, authed: AuthedUser, repo: Repo): Promise<Response> {
  const prefix = url.searchParams.get("prefix") ?? undefined;
  const principal = principalOfAuthed(authed);
  const sees = async (holder: string): Promise<boolean> => {
    // A deleted team name (#347) keeps its claims and stays inside the team that had it (core seenScopeOf).
    const scope = seenScopeOf(await repo.aliases.find(repo.read, holder), holder);
    return !scope || scope.scope_ref === null || (await authorize(repo, repo.read, {}, { verb: "alias.see", principal, scope: { scope_kind: scope.scope_kind, scope_ref: scope.scope_ref } })).allow;
  };
  const claims = await repo.claims.list(repo.read, prefix);
  // One decision per distinct holder.
  const seen = new Map<string, boolean>();
  for (const c of claims) if (!seen.has(c.holder)) seen.set(c.holder, await sees(c.holder));
  return json(claims.map(({ board: _b, ...c }) => (seen.get(c.holder) ? c : { ...c, holder: null, note: null })));
}

// An address the caller may act as (#284 S11), in full, or the refusal: a
// bare name means the caller's own person scope; an alias must exist, in
// the caller's scope or a team's it belongs to, and never be a human
// (`humanReason` says why); a session ID must be the caller's, live and no
// viewer, so nothing acts as an ended session.
async function ownAddress(r: Read, input: string | null | undefined, authed: AuthedUser, repo: Repo, humanReason: string): Promise<string | Response> {
  if (!input) return badRequest("as required: the address to act as");
  const p = addressParts(input);
  if (!p || p.kind === "team") return badRequest(`"${input}" isn't an alias or a session ID`);
  // Security audit F-01 (#851): every policy refusal below is an `authz.decision` row.
  if (p.kind === "id") {
    const row = await repo.bindings.idRow(r, p.address);
    const req: PureRequest = { verb: "session.act", user: authed.user_email, session: p.address, row: row && { principal: row.principal, viewer: !!row.viewer, ended_at: row.ended_at } };
    const d = decidePure({}, req);
    if (!d.allow) {
      recordDecision(repo, r, { user: authed.user_email }, req, d);
      return forbidden(d.reason);
    }
    return p.address;
  }
  const address = p.kind === "bare" ? `${authed.user_email}/${p.name}` : p.address;
  // The rule decides the human name first (`humanReason`), before the scope's owner.
  const owner = await repo.principals.of(r, address);
  const req: AuthzRequest = { verb: "act_as", principal: principalOfAuthed(authed), address, name: p.name, scope: owner && { scope_kind: owner.kind === "user" ? "person" : owner.kind, scope_ref: owner.name } };
  const d = await authorize(repo, r, {}, req);
  if (!d.allow) {
    recordDecision(repo, r, { user: authed.user_email, address }, req, d);
    if (d.rule === "alias.human_reserved") return forbidden(humanReason);
    // A team reads as missing to a non-member (#1020), and a service's scope to a user (#270 D1), as a scope nobody owns.
    if (d.rule === "scope.ownerless" || d.rule === "scope.team_member" || d.rule === "scope.service") return forbidden(`you can't act as "${address}": no principal owns its scope`);
    return forbidden(`you can't act as "${address}": ${d.reason}`);
  }
  if (!(await repo.aliases.find(r, address))) {
    return jsonErr("unknown_identity", `no session has used "${address}"; check which handle this shell acts as with grayboard whoami, or pass --as`, 404);
  }
  // An alias in use by another user's session is exclusive (#284 S8, decided);
  // the caller's own sessions' uses aren't refused (a tools-only sidecar, #182).
  const other = await repo.bindings.userOf(r, address, authed.user_email);
  if (other) return jsonErr("alias_held", aliasHeldText(address, `another user's session ${other}`, "act as another name"), 409);
  return address;
}

// For `grayboard claim`: a claim tool run as one of the caller's identities.
type ClaimTool = "claim_take" | "claim_release" | "claim_watch";
const CLAIM_TOOLS = new Set<string>(["claim_take", "claim_release", "claim_watch"] satisfies ClaimTool[]);

async function claimCall(req: Request, authed: AuthedUser, repo: Repo, access: BoardAccess, wake: (handles: string[]) => void, onBoardsChanged?: (boards: string[]) => void | Promise<void>): Promise<Response> {
  const body = await parseBody<{ as?: string; tool?: string; args?: Record<string, unknown> }>(req);
  if (!body?.as || !body.tool || !CLAIM_TOOLS.has(body.tool)) return badRequest("as and a claim tool required");
  const tool = body.tool, args = body.args ?? {};
  // The address check and the tool are one queued transaction; the wakes follow its commit.
  return repo.write(async (tx: Tx) => {
    const handle = await ownAddress(tx, body.as, authed, repo, `claims are for agents; "${HUMAN_NAME}" is your Slack link`);
    if (handle instanceof Response) return handle;
    if (args.as !== undefined) return badRequest("name the address to act as in as, not args.as");
    // As the session the address is or is held by: its claims under any of
    // its addresses are its own here (#360).
    const addresses = await repo.bindings.addressSet(tx, handle, authed.user_email);
    try {
      // The tool's own savepoint rolls back a refusal's writes, so answering it here commits none (#807 P3 B5b3c).
      return await callClaimTool(repo, access, tx, handle, tool as ClaimTool, args, { addresses, user: authed.user_email });
    } catch (e) {
      if (e instanceof CoreError) return badRequest(e.message);
      throw e;
    }
  }, outcome => {
    if (outcome instanceof Response) return outcome;
    if (outcome.boards?.length) {
      try { void Promise.resolve(onBoardsChanged?.(outcome.boards)).catch(() => {}); } catch {}
    }
    wake(outcome.wake);
    return json(outcome.result);
  });
}

// ── identities ────────────────────────────────────────────────────────────────

async function identityList(authed: AuthedUser, repo: Repo): Promise<Response> {
  return json((await repo.aliases.listForScope(repo.read, "person", authed.user_email)).map(i => ({ name: i.name, created_at: i.created_at })));
}

async function identityCreate(req: Request, authed: AuthedUser, repo: Repo, config: Config): Promise<Response> {
  const body = await parseBody<{ name: string }>(req);
  if (!body?.name) return badRequest("name required");
  const name = body.name.toLowerCase();
  if (!isValidIdentityName(name)) return badRequest("invalid identity name");
  if (name === HUMAN_NAME) return badRequest(HUMAN_RESERVED);
  return repo.write(async tx => {
    const existing = await repo.aliases.find(tx, `${authed.user_email}/${name}`);
    if (existing) return conflict(`identity "${name}" already exists`);
    const capped = await aliasCapRefusal(repo, tx, { scope_kind: "person", scope_ref: authed.user_email }, config.aliasScopeCap ?? ALIAS_SCOPE_CAP);
    if (capped) return badRequest(capped);
    const identity = await repo.aliases.create(tx, { scope_kind: "person", scope_ref: authed.user_email, name }, authed.user_email);
    writeAudit(repo, tx, "alias.created", authed.user_email, identity.address);
    await onAliasCreated(repo, tx, authed.user_id, identity.address);
    return json({ name: identity.name, created_at: identity.created_at }, 201);
  });
}

function identityDelete(name: string, authed: AuthedUser, repo: Repo): Response | Promise<Response> {
  name = name.toLowerCase();
  if (name === HUMAN_NAME) return badRequest(`"${HUMAN_NAME}" goes away with your Slack link: grayboard slack unlink`);
  return repo.write(async tx => {
    const existing = await repo.aliases.find(tx, `${authed.user_email}/${name}`);
    if (!existing) return notFound();
    // Its holds and writers would outlive it: a second session could then bind
    // the name while the first still acts as it.
    const user = await repo.bindings.userOf(tx, existing.address);
    if (user) return jsonErr("alias_held", aliasHeldText(existing.address, `the session ${user}`, "end it, or bind it elsewhere, first"), 409);
    await repo.aliases.remove(tx, existing.address);
    await repo.boards.forget(tx, existing.address);
    writeAudit(repo, tx, "alias.deleted", authed.user_email, existing.address);
    return json({ ok: true });
  });
}

// ── attachments ──────────────────────────────────────────────────────────────

// The address named by ?as=, which the hosted byte routes
// (src/server/mcp-attachments.ts) set to the session's bound name; no HTTP
// route takes it from a client (#475). The Slack bridge's human stores its
// files in-process, not here.
function queryAs(url: URL, authed: AuthedUser, repo: Repo): Promise<string | Response> {
  return ownAddress(repo.read, url.searchParams.get("as"), authed, repo, HUMAN_RESERVED);
}

// An upload (`?as=&filename=`), the file's bytes as the body, for the hosted
// byte route's POST. The client has already checked the path it came from; this
// runs the same checks on what arrives (checkFile, the size caps) plus the
// user's quota of unsent bytes, and stores it unbound, for a dm_send or
// board_post by that identity to carry.
export async function attachmentUpload(req: Request, url: URL, authed: AuthedUser, repo: Repo, uploads: UploadGate, guard?: Guard, signal = req.signal): Promise<Response> {
  const handle = await queryAs(url, authed, repo);
  if (handle instanceof Response) return handle;
  const rawName = url.searchParams.get("filename");
  if (!rawName) return badRequest("filename required");
  const label = `file ${sanitizeFilename(rawName)}`;
  // The body's length is reserved before it's read, so it must be declared.
  const declared = req.headers.get("content-length");
  if (declared === null || !/^\d{1,15}$/.test(declared)) return jsonErr("length_required", "an upload needs a Content-Length", 411);
  const refuse = (code: string, message: string, status: number) => {
    writeAudit(repo, repo.read, "attachment.upload_refused", authed.user_email, null, { identity: handle, filename: sanitizeFilename(rawName), size: Number(declared), reason: message });
    return jsonErr(code, message, status);
  };
  let release = () => {};
  try {
    // A declared length over the cap is refused before the body is read.
    new SizeTally(repo.attachmentLimits, 1).add(label, Number(declared));
    await guard?.(repo.read);
    release = await uploads.reserve(authed.user_email, Number(declared), signal);
    await guard?.(repo.read);
    const data = await readUploadBody(req, Number(declared), transferTimeoutMs(Number(declared)), guard ? signal : undefined);
    await guard?.(repo.read);
    if (guard && data.length !== Number(declared)) return refuse("bad_request", "the body is shorter than its Content-Length", 400);
    new SizeTally(repo.attachmentLimits, 1).add(label, data.length);
    const row = await storeUpload(repo, authed.user_email, handle, checkFile(label, rawName, data), {}, guard);
    try { await guard?.(repo.read); } catch (error) {
      await releaseStored(repo, authed.user_email, handle, row.id);
      throw error;
    }
    return json({ id: row.id, filename: row.filename, type: row.type, size: row.size, sha256: row.sha256 }, 201);
  } catch (e) {
    if (e instanceof TooLargeError) return refuse("too_large", e.message, 413);
    if (e instanceof UploadTimeout) return refuse("timeout", e.message, 408);
    if (e instanceof CoreError) return refuse("bad_request", e.message, 400);
    // A fault (disk full, unwritable blob dir, the client gone mid-wait): the
    // audit keeps it, the server's error handler answers a bare 500.
    writeAudit(repo, repo.read, "attachment.upload_failed", authed.user_email, null, { identity: handle, filename: sanitizeFilename(rawName), size: Number(declared), error: (e as Error).message });
    throw e;
  } finally {
    try {
      if (guard && req.body && !req.body.locked) await req.body.cancel();
    } finally { release(); }
  }
}

// A download (`<id>?as=`), for the hosted byte route's GET: the file, for an identity that can
// read the message or post carrying it. One it can't reads as missing.
export async function attachmentDownload(idStr: string, url: URL, authed: AuthedUser, repo: Repo, guard?: Guard): Promise<Response> {
  const handle = await queryAs(url, authed, repo);
  if (handle instanceof Response) return handle;
  const read = await requestAttachment(repo, repo.read, handle, idStr, authed.user_email, { user: authed.user_email, address: handle });
  if ("refused" in read) return jsonErr("not_found", read.refused, 404);
  const { row } = read;
  // Audited once the bytes are in hand, so a failed read isn't logged as a download.
  let data: Uint8Array<ArrayBuffer>;
  try {
    data = new Uint8Array(await repo.blobs.get(row.sha256));
  } catch (e) {
    writeAudit(repo, repo.read, "attachment.download_failed", authed.user_email, `attachment:${row.id}`, { identity: handle, sha256: row.sha256, error: (e as Error).message });
    // Swept between the read check and the read: the file is gone, as a 404 says.
    if (e instanceof BlobMissing) return jsonErr("not_found", `attachment ${row.id}'s bytes are gone`, 404);
    throw e;
  }
  return repo.write(async tx => {
  await guard?.(tx);
  if (guard) {
    // A refusal here is a decision too (#851); the transaction returns, so its rows commit.
    const current = await requestAttachment(repo, tx, handle, String(row.id), authed.user_email, { user: authed.user_email, address: handle });
    if ("refused" in current || current.row.sha256 !== row.sha256) return notFound();
  }
  writeAudit(repo, tx, "attachment.downloaded", authed.user_email, `attachment:${row.id}`, { identity: handle, sha256: row.sha256 });
  return new Response(data, {
    headers: {
      "Content-Type": row.type,
      "Content-Disposition": contentDisposition(row.filename),
      "Repr-Digest": reprDigest(row.sha256),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
  });
}

// A release (`<id>?as=`), for the hosted byte route's DELETE: drops an upload of that identity's
// that no message or post carries, when the send it was for failed.
export async function attachmentRelease(idStr: string, url: URL, authed: AuthedUser, repo: Repo, guard?: Guard): Promise<Response> {
  const handle = await queryAs(url, authed, repo);
  if (handle instanceof Response) return handle;
  await guard?.(repo.read);
  const row = /^\d{1,15}$/.test(idStr) ? await releaseStored(repo, authed.user_email, handle, Number(idStr), {}, guard) : null;
  await guard?.(repo.read);
  if (!row) return jsonErr("not_found", `no unsent upload ${idStr.slice(0, 32)} of yours`, 404);
  return json({ ok: true });
}

// ── teams ────────────────────────────────────────────────────────────────────

async function teamList(authed: AuthedUser, repo: Repo): Promise<Response> {
  return json((await repo.teams.listForUser(repo.read, authed.user_id)).map(t => ({ name: t.name, created_at: t.created_at })));
}

async function teamCreate(req: Request, authed: AuthedUser, repo: Repo): Promise<Response> {
  const body = await parseBody<{ name: string }>(req);
  if (!body?.name) return badRequest("name required");
  const name = body.name.toLowerCase();
  if (!isValidIdentityName(name)) return badRequest("invalid team name");
  return repo.write(async (tx) => {
    if (await repo.teams.findByName(tx, name)) return conflict(`team "${name}" already exists`);
    // The team's board shares its name, so the name must be free as a board too.
    if (await repo.boards.get(tx, name)) return conflict(`a board named "#${name}" already exists`);
    let team: Team;
    try {
      team = await repo.teams.create(tx, name, authed.user_id);
    } catch (e) {
      if (e instanceof PrincipalTaken) return conflict(e.message);
      throw e;
    }
    await repo.teams.addMember(tx, team.id, authed.user_id);
    await ensureTeamBoard(repo, tx, team, authed.user_email);
    await onTeamJoined(repo, tx, team, authed.user_email);
    writeAudit(repo, tx, "team.created", authed.user_email, name);
    writeAudit(repo, tx, "team.member_added", authed.user_email, name, { member: authed.user_email });
    // Its creator is its first owner (#927): a team_owner binding they grant themselves, with its role.granted row.
    const owner = await grantRole(repo, tx, { holder: authed.user_email, role: "team_owner", scope: team.name }, { email: authed.user_email, userId: authed.user_id, authority: "none" });
    if ("refused" in owner) throw new Error(`team ${team.name}: its creator's ownership was refused: ${owner.refused.message}`);
    return json({ name: team.name, created_at: team.created_at }, 201);
  });
}

// Teams are invite-only: members add people. Older CLIs still offer `team join`.
function teamJoin(): Response {
  return forbidden("teams are invite-only; ask a member to run: grayboard team add <team> <your email>");
}

// A team the caller isn't in reads as not found, like its board; an admin
// can't leave a team it isn't in. A refusal is recorded (policy.ts).
async function memberTeam(h: Read, teamName: string, authed: AuthedUser, repo: Repo): Promise<Team | null> {
  const req: AuthzRequest = { verb: "team.leave", user: signedIn(authed), team: await repo.teams.findByName(h, teamName.toLowerCase()) };
  const d = await authorize(repo, h, {}, req);
  if (!d.allow) {
    recordDecision(repo, h, { user: authed.user_email }, req, d, { team_requested: teamName.toLowerCase() });
    return null;
  }
  return req.team!;
}

// Members read their team's roster; admins (by GRAYBOARD_ADMINS or an
// org_admin binding) can read any team's. as_admin marks the audit row when an
// admin isn't a member. A denial is recorded (policy.ts), and reads as not
// found; so is an admin's read, an exercise of admin authority (#927). A
// member's read isn't.
async function managedTeam(h: Read, teamName: string, authed: AuthedUser, repo: Repo, config: Config): Promise<{ team: Team; audit: { as_admin?: true } } | null> {
  const req: AuthzRequest = { verb: "team.read", user: signedIn(authed), team: await repo.teams.findByName(h, teamName.toLowerCase()) };
  const d = await authorize(repo, h, { admins: config.admins }, req);
  if (!d.allow || byAdmin(d)) recordDecision(repo, h, { user: authed.user_email }, req, d, { team_requested: teamName.toLowerCase() });
  if (!d.allow) return null;
  return { team: req.team!, audit: byAdmin(d) ? { as_admin: true } : {} };
}

// Owners change their team's membership; admins can change any team's, e.g.
// one whose last member left or whose creator left before roles existed
// (security audit F-02: a member could remove the creator, then bind the
// team names the creator lost). as_admin marks an admin acting without
// owning. A non-member still reads not found; a member who isn't an owner
// is refused, naming who can. Every decision is recorded (policy.ts).
async function ownedTeam(h: Read, teamName: string, authed: AuthedUser, repo: Repo, config: Config): Promise<{ team: Team; audit: { as_admin?: true }; decision: Decision } | Response> {
  const req: AuthzRequest = { verb: "team.manage", user: signedIn(authed), team: await repo.teams.findByName(h, teamName.toLowerCase()) };
  const d = await authorize(repo, h, { admins: config.admins }, req);
  recordDecision(repo, h, { user: authed.user_email }, req, d, { team_requested: teamName.toLowerCase() });
  if (!d.allow) return d.code === "not_found" ? notFound() : forbidden(d.reason);
  return { team: req.team!, audit: byAdmin(d) ? { as_admin: true } : {}, decision: d };
}

const lastOwner = (e: LastOwner): Response => jsonErr("conflict", e.message, 409);

function teamLeave(teamName: string, authed: AuthedUser, repo: Repo, sessions: SessionHooks): Promise<Response> {
  return repo.write(async (tx) => {
    const team = await memberTeam(tx, teamName, authed, repo);
    if (!team) return notFound();
    try {
      await repo.teams.removeMember(tx, team.id, authed.user_id, authed.user_email);
    } catch (e) {
      if (e instanceof LastOwner) return lastOwner(e);
      throw e;
    }
    await onTeamLeft(repo, tx, team, authed.user_email);
    await sessions.accessChanged(tx, authed.user_email, authed.user_email);
    writeAudit(repo, tx, "team.member_removed", authed.user_email, team.name, { member: authed.user_email });
    return json({ ok: true });
  });
}

// A refusal that rolls back what its savepoint wrote (a member added before their ownership's grant was refused).
class Refused extends Error { constructor(readonly response: Response) { super("refused"); } }
const refusedResponse = (o: Extract<RoleOutcome, { refused: unknown }>): Response => jsonErr(o.refused.code, o.refused.message, o.refused.status);

async function teamAdd(teamName: string, req: Request, authed: AuthedUser, repo: Repo, config: Config): Promise<Response> {
  // Read the body before the ownership check (security audit F-02): an owner
  // demoted while a slow body trickles in must not act on a stale check.
  const body = await parseBody<{ email: string; role?: unknown }>(req);
  return repo.write(async (tx) => {
    const managed = await ownedTeam(tx, teamName, authed, repo, config);
    if (managed instanceof Response) return managed;
    const { team } = managed;
    if (!body?.email) return badRequest("email required");
    if (body.role !== undefined && body.role !== "owner" && body.role !== "member") return badRequest(`role must be "owner" or "member"`);
    const role = body.role as "owner" | "member" | undefined;
    const email = body.email.toLowerCase();
    const user  = await repo.users.findByEmail(tx, email);
    if (!user) return jsonErr("not_found", `${email} has never signed in to grayboard; they need to run grayboard login first`, 404);
    // A service is never a team member (#270 D1): membership would carry the team's wakes, boards and names.
    if (user.kind === "service") return badRequest(`${email} is a service; services don't join teams`);
    // Ownership is a team_owner binding (#927), granted and revoked by the same store calls as the admin route's,
    // re-checking the caller's authority in the write. A refused grant takes the membership it followed with it.
    const granter: Granter = { email: authed.user_email, userId: authed.user_id, authority: authorityOf(managed.decision) };
    const spec = { holder: email, role: "team_owner" as const, scope: team.name };
    try {
      return await tx.savepoint(async (sp) => {
        if (await repo.teams.addMember(sp, team.id, user.id)) {
          await onTeamJoined(repo, sp, team, email);
          writeAudit(repo, sp, "team.member_added", authed.user_email, team.name, { member: email, ...managed.audit });
        }
        // A role changes only when one is asked for; a new member is a member unless made an owner.
        if (role === "owner") {
          const out = await grantRole(repo, sp, spec, granter, managed.audit);
          if ("refused" in out) throw new Refused(refusedResponse(out));
        } else if (role === "member") {
          const out = await revokeRole(repo, sp, spec, granter, false, managed.audit);
          // Not an owner already: nothing to change.
          if ("refused" in out && out.refused.status !== 404) throw new Refused(refusedResponse(out));
        }
        return json({ ok: true });
      });
    } catch (e) {
      if (e instanceof Refused) return e.response;
      throw e;
    }
  });
}

async function teamRemove(teamName: string, req: Request, authed: AuthedUser, repo: Repo, config: Config, sessions: SessionHooks): Promise<Response> {
  const body = await parseBody<{ email: string }>(req); // before the ownership check, as in teamAdd
  return repo.write(async (tx) => {
    const managed = await ownedTeam(tx, teamName, authed, repo, config);
    if (managed instanceof Response) return managed;
    const { team } = managed;
    if (!body?.email) return badRequest("email required");
    const email = body.email.toLowerCase();
    const user  = await repo.users.findByEmail(tx, email);
    if (!user || !(await repo.teams.isMember(tx, team.id, user.id))) {
      return jsonErr("not_found", `${email} is not a member of team "${team.name}"`, 404);
    }
    try {
      await repo.teams.removeMember(tx, team.id, user.id, authed.user_email, managed.audit);
    } catch (e) {
      if (e instanceof LastOwner) return lastOwner(e);
      throw e;
    }
    await onTeamLeft(repo, tx, team, email);
    await sessions.accessChanged(tx, email, authed.user_email);
    writeAudit(repo, tx, "team.member_removed", authed.user_email, team.name, { member: email, ...managed.audit });
    return json({ ok: true });
  });
}

// A team's wake policy (#806): whether members' agents may wake each
// other's across users ('collaborative'; 'delegating' adds delegation to
// each other's launchers, #256) or not ('open', the default).
// Owners and admins set it, like membership; audited with before and after.
async function teamPolicy(teamName: string, req: Request, authed: AuthedUser, repo: Repo, config: Config): Promise<Response> {
  const body = await parseBody<{ policy?: unknown }>(req);
  return repo.write(async (tx) => {
    const managed = await ownedTeam(tx, teamName, authed, repo, config);
    if (managed instanceof Response) return managed;
    const policy = body?.policy;
    if (typeof policy !== "string" || !(TEAM_POLICIES as readonly string[]).includes(policy)) return badRequest(`policy must be one of ${TEAM_POLICIES.map(p => `"${p}"`).join(", ")}`);
    const from = await repo.teams.setPolicy(tx, managed.team.id, policy as TeamPolicy);
    if (from === null) return notFound();
    if (from !== policy) writeAudit(repo, tx, "team.policy_set", authed.user_email, managed.team.name, { from, to: policy, ...managed.audit });
    return json({ ok: true, team: managed.team.name, policy, previous: from });
  });
}

// A team's name, deleted by a team owner or an admin (#347), as a user
// deletes their own (identityDelete): refused while a session holds or
// writes as it, so no session outlives the name it acts as. Its queued
// mail and claims stay with the address, as on unbind, for a member who
// binds the name again.
async function teamDeleteAlias(teamName: string, req: Request, authed: AuthedUser, repo: Repo, config: Config): Promise<Response> {
  const body = await parseBody<{ name?: unknown }>(req); // before the ownership check, as in teamAdd
  return repo.write(async tx => {
    const managed = await ownedTeam(tx, teamName, authed, repo, config);
    if (managed instanceof Response) return managed;
    if (typeof body?.name !== "string" || !body.name) return badRequest("name required");
    const name = body.name.toLowerCase();
    if (name === HUMAN_NAME) return badRequest(`"${HUMAN_NAME}" is reserved in every scope; no team has one`);
    if (!isValidIdentityName(name)) return badRequest("invalid name");
    const existing = await repo.aliases.find(tx, `${managed.team.name}/${name}`);
    if (!existing) return jsonErr("not_found", `team "${managed.team.name}" has no name "${name}"`, 404);
    const user = await repo.bindings.userOf(tx, existing.address);
    if (user) return jsonErr("alias_held", aliasHeldText(existing.address, `the session ${user}`, "end it, or have it unbind the name, first"), 409);
    await repo.aliases.remove(tx, existing.address);
    await repo.boards.forget(tx, existing.address);
    writeAudit(repo, tx, "alias.deleted", authed.user_email, existing.address, { team: managed.team.name, ...managed.audit });
    return json({ ok: true, deleted: existing.address });
  });
}

// The roster is read before the guard decides (#807 P3 A7f1): a member removed between the two reads is refused,
// where guard-first would hand the roster to someone removed while it was being read. One added between them sees
// the roster from just before they joined.
async function teamMembers(teamName: string, authed: AuthedUser, repo: Repo, config: Config): Promise<Response> {
  const team = await repo.teams.findByName(repo.read, teamName.toLowerCase());
  const roster = team ? await repo.teams.listMembers(repo.read, team.id) : [];
  await testPauseAsync("http:team-members:between");
  const managed = await managedTeam(repo.read, teamName, authed, repo, config);
  if (!managed || managed.team.id !== team?.id) return notFound();
  return json(roster);
}

// ── admin ────────────────────────────────────────────────────────────────────

// The generic user routes act on people only (#270 D1): a service goes through /api/admin/services, whose disable
// is audited as the service's, and which no generic revoke reaches.
const serviceRefused = (u: User, verb: string): Response | null =>
  u.kind === "service" ? badRequest(`${u.email} is a service, not a user; use grayboard admin service ${verb} ${u.email}`) : null;

// Revokes every session the user has; there's no session id to pick one by.
// Older CLIs send all: true, which is ignored.
async function adminRevokeSession(req: Request, authed: AuthedUser, repo: Repo, disconnectUser: (userId: number) => void): Promise<Response> {
  const body = await parseBody<{ email: string }>(req);
  if (!body?.email) return badRequest("email required");
  // The live sessions go after the commit: a rolled-back revoke leaves them up, as it leaves their tokens valid.
  const target = await repo.write(async (tx: Tx) => {
    const target = await repo.users.findByEmail(tx, body.email.toLowerCase());
    if (!target) return null;
    const refused = serviceRefused(target, "disable");
    if (refused) return refused;
    await repo.sessions.revokeAllForUser(tx, target.id);
    writeAudit(repo, tx, "auth.session_revoked", authed.user_email, body.email);
    return target;
  }, target => { if (target && !(target instanceof Response)) disconnectUser(target.id); return target; });
  if (target instanceof Response) return target;
  return target ? json({ ok: true }) : notFound();
}

async function adminDisableUser(
  req: Request, authed: AuthedUser, repo: Repo, disconnectUser: (userId: number) => void, slack?: SlackLinker,
): Promise<Response> {
  const body = await parseBody<{ email: string }>(req);
  if (!body?.email) return badRequest("email required");
  const out = await repo.write(async (tx: Tx) => {
    const target = await repo.users.findByEmail(tx, body.email.toLowerCase());
    if (!target) return null;
    const refused = serviceRefused(target, "disable");
    if (refused) return refused;
    await repo.users.setDisabled(tx, target.id, true);
    // Their service_owner bindings stay (#930 replaces disabled owners); the answer names the services left with no
    // enabled owner, so the admin knows whose accountability lapsed (#270 D1).
    const orphaned = await repo.services.orphanedBy(tx, target.id);
    writeAudit(repo, tx, "auth.user_disabled", authed.user_email, body.email, orphaned.length ? { orphaned_services: orphaned } : undefined);
    return { target, orphaned };
  }, out => { if (out && !(out instanceof Response)) disconnectUser(out.target.id); return out; });
  if (out instanceof Response) return out;
  if (!out) return notFound();
  await slack?.userChanged(out.target.id);
  return json({ ok: true, ...(out.orphaned.length ? { orphaned_services: out.orphaned } : {}) });
}

async function adminEnableUser(req: Request, authed: AuthedUser, repo: Repo, slack?: SlackLinker): Promise<Response> {
  const body = await parseBody<{ email: string }>(req);
  if (!body?.email) return badRequest("email required");
  const target = await repo.write(async tx => {
    const target = await repo.users.findByEmail(tx, body.email.toLowerCase());
    if (!target) return null;
    const refused = serviceRefused(target, "enable");
    if (refused) return refused;
    await repo.users.setDisabled(tx, target.id, false);
    writeAudit(repo, tx, "auth.user_enabled", authed.user_email, body.email);
    return target;
  });
  if (target instanceof Response) return target;
  if (!target) return notFound();
  await slack?.userChanged(target.id);
  return json({ ok: true });
}

// Forgets a user's IdP account, issuer and subject (security audit F-13, #928
// D4), so the next verified sign-in with the email, from any enabled provider,
// takes the account over: for a person whose IdP account was recreated, one
// moving to another IdP, or an email an admin chooses to hand on.
async function adminUnlinkIdp(req: Request, authed: AuthedUser, repo: Repo, config: Config): Promise<Response> {
  const body = await parseBody<{ email: string }>(req);
  if (!body?.email) return badRequest("email required");
  return repo.write(async tx => {
    const target = await repo.users.findByEmail(tx, body.email.toLowerCase());
    if (!target) return notFound();
    // A service has no IdP account to forget (#270 D1).
    if (target.kind === "service") return badRequest(`${target.email} is a service, not a user; no sign-in links to it`);
    await repo.users.clearSubject(tx, target.id);
    writeAudit(repo, tx, "auth.subject_cleared", authed.user_email, target.email, {
      had_subject: target.idp_subject !== null, provider: defaultProviders(config).find(p => p.issuer === target.idp_issuer)?.id ?? null, issuer: target.idp_issuer });
    return json({ ok: true });
  });
}

// ── roles (#927) ─────────────────────────────────────────────────────────────

// Grant and revoke behind the /api/admin/ gate, whose decision (`gate`) says which authority the write re-checks: a
// granter revoked between the gate and the write is refused there. The binding is named by its triple, not its
// id.
async function adminRoleGrant(req: Request, authed: AuthedUser, repo: Repo, gate: Decision): Promise<Response> {
  const spec = roleSpec(await parseBody(req));
  if (!("role" in spec)) return jsonErr(spec.code, spec.message, spec.status);
  await testPauseAsync("http:admin-role-grant:before-write");
  return repo.write(async tx => {
    const out = await grantRole(repo, tx, spec, { email: authed.user_email, userId: authed.user_id, authority: authorityOf(gate) });
    if ("refused" in out) return refusedResponse(out);
    return json({ binding: out.binding, created: out.changed }, out.changed ? 201 : 200);
  });
}

async function adminRoleRevoke(req: Request, authed: AuthedUser, repo: Repo, config: Config, gate: Decision): Promise<Response> {
  const spec = roleSpec(await parseBody(req));
  if (!("role" in spec)) return jsonErr(spec.code, spec.message, spec.status);
  await testPauseAsync("http:admin-role-revoke:before-write");
  const bootstrap = bootstrapAdmins(config).includes(spec.holder);
  return repo.write(async tx => {
    const out = await revokeRole(repo, tx, spec, { email: authed.user_email, userId: authed.user_id, authority: authorityOf(gate) }, bootstrap);
    if ("refused" in out) return refusedResponse(out);
    const said: { note?: string; warning?: string } = {};
    if (spec.role === "org_admin" && bootstrap) said.note = `${spec.holder} is still an admin by the server's GRAYBOARD_ADMINS`;
    // No guard on the last org admin: the env list is the way back, and the answer says when it's needed.
    if (spec.role === "org_admin" && config.admins.length === 0 && (await repo.roles.list(tx, { role: "org_admin" }, 0, 1)).length === 0) {
      said.warning = "no org admin remains on this server: set GRAYBOARD_ADMINS and restart it to have one";
    }
    return json({ revoked: out.binding, ...said });
  });
}

// The GRAYBOARD_ADMINS entries that can be admins: emails. An entry that isn't one names no user; a service's name
// never is one, and the admin rule refuses a service before it reads the list (#270 D1), so neither is listed.
const bootstrapAdmins = (config: Config): string[] => config.admins.filter(e => isValidEmail(e));

// The bindings, filtered by role, holder and scope, a page at a time by id (principle 13). GRAYBOARD_ADMINS emails
// are listed first, on the first page, with no id and source "bootstrap", whether or not they have signed in.
const ROLE_PAGE = 100;
async function adminRoleList(url: URL, repo: Repo, config: Config): Promise<Response> {
  const q = url.searchParams;
  const filter: RoleFilter = {};
  const role = q.get("role"), principal = q.get("principal"), scope = q.get("scope"), after = q.get("after"), limit = q.get("limit");
  if (role !== null) {
    if (!isRole(role)) return badRequest(`role must be one of ${Object.keys(ROLES).join(", ")}`);
    filter.role = role;
  }
  if (principal !== null) filter.principal = principal.toLowerCase();
  if (scope !== null) filter.scope = scope.toLowerCase();
  if (after !== null && !/^\d{1,15}$/.test(after)) return badRequest("after must be a binding id");
  if (limit !== null && !/^\d{1,4}$/.test(limit)) return badRequest("limit must be a number");
  const size = Math.min(Math.max(Number(limit ?? ROLE_PAGE), 1), ROLE_PAGE);
  const page = await repo.roles.list(repo.read, filter, Number(after ?? 0), size);
  const bootstrap = after === null && (filter.role ?? "org_admin") === "org_admin" && filter.scope === undefined
    ? bootstrapAdmins(config).filter(e => filter.principal === undefined || e === filter.principal).map(e => ({ id: null, principal: e, role: "org_admin", scope: null, source: "bootstrap" }))
    : [];
  return json({
    bindings: [...bootstrap, ...page.map(b => ({ ...b, source: "binding" }))],
    next: page.length === size ? page[page.length - 1]!.id : null,
  });
}

// ── services (#270 D1) ───────────────────────────────────────────────────────

// A service principal: a users row whose email column holds its name, and a principals row of kind service. Every
// route here is behind the /api/admin/ gate (org_admin, with its decision row); no MCP tool reaches them.

// The service a route names, or the 404: a user's email or a team's name reads as no service.
async function serviceNamed(h: Read, repo: Repo, name: unknown): Promise<User | Response> {
  if (typeof name !== "string" || !name) return badRequest("name required");
  const u = await repo.users.findByEmail(h, name.toLowerCase());
  return u?.kind === "service" ? u : jsonErr("not_found", `no service named "${name.toLowerCase()}"`, 404);
}

// Create: the users and principals rows and every owner's service_owner binding, in one transaction (D1: a service
// always has an owner). The owners are granted with the gate's authority, re-checked in each grant's write, so an
// admin revoked between the gate and the write creates nothing: a refused grant rolls the savepoint back.
async function adminServiceCreate(req: Request, authed: AuthedUser, repo: Repo, gate: Decision): Promise<Response> {
  const body = await parseBody<{ name?: unknown; owners?: unknown }>(req);
  if (typeof body?.name !== "string" || !body.name) return badRequest("name required");
  const name = body.name.toLowerCase();
  // The team name rule (D1): no "@", so a service's name is never a person scope and never an email.
  if (!isValidIdentityName(name)) return badRequest(`invalid service name "${name.slice(0, 64)}": 1-32 chars of a-z 0-9 _ -`);
  // The Slack bridge's name in every scope (#1241): a service called it would read as everyone's phone.
  if (name === HUMAN_NAME) return badRequest(`"${HUMAN_NAME}" is reserved; no service may take it`);
  if (!Array.isArray(body.owners) || !body.owners.length || !body.owners.every(o => typeof o === "string" && o)) {
    return badRequest("owners required: one or more users' emails; every service has an owner");
  }
  const owners = [...new Set((body.owners as string[]).map(o => o.toLowerCase()))];
  await testPauseAsync("http:admin-service-create:before-write");
  const granter: Granter = { email: authed.user_email, userId: authed.user_id, authority: authorityOf(gate) };
  return repo.write(async tx => {
    try {
      return await tx.savepoint(async sp => {
        let svc: User;
        try {
          svc = await repo.services.create(sp, name);
        } catch (e) {
          if (e instanceof PrincipalTaken) throw new Refused(conflict(`the name "${name}" belongs to another user, team or service`));
          throw e;
        }
        for (const owner of owners) {
          // A disabled owner answers for nothing: a service created with one starts orphaned (what disable-user reports).
          if ((await repo.users.findByEmail(sp, owner))?.disabled_at != null) throw new Refused(conflict(`${owner} is disabled; a service's owners must be enabled users`));
          const out = await grantRole(repo, sp, { holder: owner, role: "service_owner", scope: name }, granter);
          if ("refused" in out) throw new Refused(refusedResponse(out));
        }
        writeAudit(repo, sp, "service.created", authed.user_email, name, { owners });
        return json({ name, created_at: svc.created_at, owners: [...owners].sort() }, 201);
      });
    } catch (e) {
      if (e instanceof Refused) return e.response;
      throw e;
    }
  });
}

const SERVICE_PAGE = 100;
async function adminServiceList(url: URL, repo: Repo): Promise<Response> {
  const after = url.searchParams.get("after"), limit = url.searchParams.get("limit");
  if (after !== null && !/^\d{1,15}$/.test(after)) return badRequest("after must be a service id");
  if (limit !== null && !/^\d{1,4}$/.test(limit)) return badRequest("limit must be a number");
  const size = Math.min(Math.max(Number(limit ?? SERVICE_PAGE), 1), SERVICE_PAGE);
  const page = await repo.services.list(repo.read, Number(after ?? 0), size);
  return json({ services: page, next: page.length === size ? page[page.length - 1]!.id : null });
}

// Disable is setDisabled, as for a user: it revokes every grant and ends the service's hosted sessions in its
// transaction (F-14); enable revives none of them. Audited as the user routes are, naming the service.
async function adminServiceSetDisabled(req: Request, authed: AuthedUser, repo: Repo, disabled: boolean, disconnectUser: (userId: number) => void): Promise<Response> {
  const body = await parseBody<{ name?: unknown }>(req);
  const out = await repo.write(async (tx: Tx) => {
    const svc = await serviceNamed(tx, repo, body?.name);
    if (svc instanceof Response) return svc;
    await repo.users.setDisabled(tx, svc.id, disabled);
    writeAudit(repo, tx, disabled ? "auth.user_disabled" : "auth.user_enabled", authed.user_email, svc.email, { service: true });
    return svc;
  }, out => { if (disabled && !(out instanceof Response)) disconnectUser(out.id); return out; });
  return out instanceof Response ? out : json({ ok: true });
}

// A service's name no session is using, deleted (D4: the team route's twin), freeing a slot under the scope cap.
async function adminServiceDeleteAlias(req: Request, authed: AuthedUser, repo: Repo): Promise<Response> {
  const body = await parseBody<{ service?: unknown; name?: unknown }>(req);
  return repo.write(async tx => {
    const svc = await serviceNamed(tx, repo, body?.service);
    if (svc instanceof Response) return svc;
    if (typeof body?.name !== "string" || !body.name) return badRequest("name required");
    const name = body.name.toLowerCase();
    if (name === HUMAN_NAME) return badRequest(`"${HUMAN_NAME}" is reserved in every scope; no service has one`);
    if (!isValidIdentityName(name)) return badRequest("invalid name");
    const existing = await repo.aliases.find(tx, `${svc.email}/${name}`);
    if (!existing) return jsonErr("not_found", `service "${svc.email}" has no name "${name}"`, 404);
    const holder = await repo.bindings.userOf(tx, existing.address);
    if (holder) return jsonErr("alias_held", aliasHeldText(existing.address, `the session ${holder}`, "end it, or have it unbind the name, first"), 409);
    await repo.aliases.remove(tx, existing.address);
    await repo.boards.forget(tx, existing.address);
    writeAudit(repo, tx, "alias.deleted", authed.user_email, existing.address, { service: svc.email });
    return json({ ok: true, deleted: existing.address });
  });
}

// A service credential (#270 D2): an OAuth client-credentials client with its own grant. Add writes the credential,
// its grant (expiry = the credential's) and its first secret; with `rotate` it adds a second secret to a live
// credential instead, leaving its client ID, grant and sessions as they are. The secret is in this answer only:
// stored as SHA-256, never in an audit row or a log.
async function adminServiceCredentialAdd(req: Request, authed: AuthedUser, repo: Repo, config: Config): Promise<Response> {
  const body = await parseBody<{ service?: unknown; source?: unknown; token_seconds?: unknown; expires_at?: unknown; rotate?: unknown }>(req);
  const ceiling = (config.serviceTokens ?? DEFAULT_SERVICE_TOKEN_LIMITS).maxSeconds;
  const rotate = body?.rotate;
  if (rotate !== undefined && (typeof rotate !== "string" || !rotate.startsWith(SERVICE_CLIENT_PREFIX))) return badRequest("rotate must be a credential's client ID (svc_…)");
  if (rotate !== undefined && [body?.source, body?.token_seconds, body?.expires_at].some(v => v !== undefined)) {
    return badRequest("a rotation keeps the credential's source, lifetime and expiry; give only service and rotate");
  }
  const source = (body?.source ?? "generic") as CredentialSource;
  if (!(CREDENTIAL_SOURCES as readonly unknown[]).includes(source)) return badRequest(`source must be one of ${CREDENTIAL_SOURCES.join(", ")}`);
  // No lifetime given: the default, under a lower ceiling the ceiling (#270 audit L-2).
  const tokenSeconds = body?.token_seconds ?? Math.min(OAUTH_TTL.access / 1000, ceiling);
  if (!Number.isSafeInteger(tokenSeconds) || (tokenSeconds as number) < SERVICE_TOKEN_MIN_SECONDS || (tokenSeconds as number) > ceiling) {
    return badRequest(`token_seconds must be a whole number from ${SERVICE_TOKEN_MIN_SECONDS} to ${ceiling} (GRAYBOARD_SERVICE_TOKEN_MAX_SECONDS)`);
  }
  const expiresAt = body?.expires_at;
  if (expiresAt !== undefined && (!Number.isSafeInteger(expiresAt) || (expiresAt as number) <= Date.now() || (expiresAt as number) > CREDENTIAL_NO_EXPIRY)) {
    return badRequest("expires_at must be a future time in epoch milliseconds");
  }
  const secret = randomBytes(32).toString("base64url");
  const out = await repo.write(async tx => {
    const svc = await serviceNamed(tx, repo, body?.service);
    if (svc instanceof Response) return svc;
    if (svc.disabled_at !== null) return conflict(`service ${svc.email} is disabled; enable it first`);
    const now = Date.now();
    if (typeof rotate === "string") {
      // The credential must be this service's: a client ID names no other service's here.
      const live = await repo.oauth.findServiceCredential(tx, rotate, now);
      if (!live || live.userId !== svc.id) return jsonErr("not_found", `service ${svc.email} has no live credential ${rotate}`, 404);
      const r = await repo.oauth.rotateServiceCredential(tx, { clientId: rotate, secretHash: hashToken(secret) }, now);
      if (r.status === "capacity") return conflict(`credential ${rotate} already holds two live secrets; revoke one first (credential revoke --secret <id>)`);
      if (r.status !== "ok") return jsonErr("not_found", `service ${svc.email} has no live credential ${rotate}`, 404);
      writeAudit(repo, tx, "service.credential_added", authed.user_email, svc.email, { client_id: rotate, secret_id: r.value.secretId, rotation: true });
      return { service: svc.email, client_id: rotate, client_secret: secret, secret_id: r.value.secretId, source: live.source, token_seconds: live.tokenSeconds };
    }
    const clientId = SERVICE_CLIENT_PREFIX + randomBytes(16).toString("hex");
    const at = (expiresAt as number | undefined) ?? CREDENTIAL_NO_EXPIRY;
    const r = await repo.oauth.addServiceCredential(tx, { userId: svc.id, clientId, grantId: randomBytes(32).toString("base64url"), resource: mcpResource(config.publicUrl, config.devAuth),
      source, tokenSeconds: tokenSeconds as number, expiresAt: at, secretHash: hashToken(secret) }, now);
    if (r.status !== "ok") return conflict(`service ${svc.email} can't take a credential now`);
    writeAudit(repo, tx, "service.credential_added", authed.user_email, svc.email, { client_id: clientId, secret_id: r.value.secretId, source, token_seconds: tokenSeconds,
      ...(expiresAt !== undefined ? { expires_at: at } : {}) });
    return { service: svc.email, client_id: clientId, client_secret: secret, secret_id: r.value.secretId, source, token_seconds: tokenSeconds, ...(expiresAt !== undefined ? { expires_at: at } : {}) };
  });
  if (out instanceof Response) return out;
  return new Response(JSON.stringify(out), { status: 201, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

// Revoke a credential (its grant: every session attached to it ends in this transaction, D2) or, with `secret`, one
// of its secrets and that secret's tokens, leaving the grant and the sessions that present a token from the other.
async function adminServiceCredentialRevoke(req: Request, authed: AuthedUser, repo: Repo): Promise<Response> {
  const body = await parseBody<{ client_id?: unknown; secret?: unknown }>(req);
  const byClient = typeof body?.client_id === "string" && body.client_id !== "";
  if (byClient === (body?.secret !== undefined)) return badRequest("give client_id, or secret (a secret's id), not both");
  if (!byClient && !Number.isSafeInteger(body?.secret)) return badRequest("secret must be a secret's id");
  return repo.write(async tx => {
    const now = Date.now();
    if (byClient) {
      const clientId = body!.client_id as string;
      const r = await repo.oauth.revokeServiceCredential(tx, clientId, now);
      if (r.status !== "ok") return jsonErr("not_found", `no live credential ${clientId}`, 404);
      const svc = await repo.users.findById(tx, r.value.userId);
      writeAudit(repo, tx, "service.credential_revoked", authed.user_email, svc?.email ?? null, { client_id: clientId });
      return json({ ok: true, client_id: clientId });
    }
    const secretId = body!.secret as number;
    const r = await repo.oauth.revokeServiceSecret(tx, secretId, now);
    if (r.status === "invalid") return conflict(`secret ${secretId} is its credential's only live secret; revoke the credential instead`);
    if (r.status !== "ok") return jsonErr("not_found", `no live secret ${secretId}`, 404);
    const svc = await repo.users.findById(tx, r.value.userId);
    writeAudit(repo, tx, "service.credential_revoked", authed.user_email, svc?.email ?? null, { client_id: r.value.clientId, secret_id: secretId });
    return json({ ok: true, client_id: r.value.clientId, secret_id: secretId });
  });
}

// ── main router ──────────────────────────────────────────────────────────────

// What the server does when an HTTP action changes who a user's
// sessions may be: a revoked or disabled user's sessions end; a user who
// left a team stops acting as its aliases (#284 S9).
export type SessionHooks = {
  disconnectUser: (userId: number) => void;
  // principal: a principal's name; its sessions' aliases are re-checked.
  accessChanged: (h: Read, principal: string, by: string) => Promise<void>;
};

export async function handleHttp(
  // `access`: the application's BoardAccess, which the claim tools judge boards with (#807 P3 B5b3c).
  req: Request, repo: Repo, access: BoardAccess, config: Config, touches: TouchQueue, wake: (handles: string[]) => void, slack: SlackLinker | undefined,
  sessions: SessionHooks,
  // The client's address as the auth gate resolved it (src/server/client_addr.ts).
  ip: string | null,
  onBoardsChanged?: (boards: string[]) => void | Promise<void>,
  // The request's URL when the caller already parsed it (the server's fetch does, #278).
  parsed?: URL,
): Promise<Response> {
  const url    = parsed ?? new URL(req.url);
  const path   = url.pathname;
  const method = req.method;

  if (path === "/healthz" && method === "GET") return healthz(repo, performance.now(), config.healthzLag);
  const signIn = signInRoute(method, path, config);
  if (signIn) return signIn.handle(req, repo, config, ip);

  const authed = await requireAuth(req, repo, touches, config.cliTokenIdleDays ?? DEFAULT_CLI_TOKEN_IDLE_DAYS);
  if (!authed) return jsonErr("unauthenticated", "invalid or missing token", 401);

  if (path === "/api/auth/logout" && method === "POST") return authLogout(authed, repo);
  if (path === "/api/whoami"      && method === "GET")  return whoami(authed, repo);

  if (path === "/api/claims" && method === "GET") return claimList(url, authed, repo);
  if (path === "/api/claims/call" && method === "POST") return claimCall(req, authed, repo, access, wake, onBoardsChanged);

  if (path === "/api/identities" && method === "GET")  return identityList(authed, repo);
  if (path === "/api/identities" && method === "POST") return identityCreate(req, authed, repo, config);
  if (path.startsWith("/api/identities/") && method === "DELETE") {
    return identityDelete(path.slice("/api/identities/".length), authed, repo);
  }

  if (path.startsWith("/api/slack/") && !slack) {
    return jsonErr("not_found", "this server has no Slack bridge (its admin sets SLACK_APP_TOKEN and SLACK_BOT_TOKEN)", 404);
  }
  // Unlinking still works: it's only database rows.
  if (path === "/api/slack/link" && !slack!.running) {
    return jsonErr("not_found", "this server's Slack bridge isn't running (its admin checks the server log)", 404);
  }
  if (path === "/api/slack/link" && method === "POST") return json(await slack!.newCode(authed));
  if (path === "/api/slack/unlink" && method === "POST") {
    return (await slack!.unlink(authed.user_id)) ? json({ ok: true }) : jsonErr("not_found", "you have no Slack link", 404);
  }

  if (path === "/api/teams" && method === "GET")  return teamList(authed, repo);
  if (path === "/api/teams" && method === "POST") return teamCreate(req, authed, repo);

  const teamOp = path.match(/^\/api\/teams\/([^/]+)\/([^/]+)$/);
  if (teamOp) {
    const [, teamName, action] = teamOp;
    if (action === "join"    && method === "POST") return teamJoin();
    if (action === "leave"   && method === "POST") return teamLeave(teamName, authed, repo, sessions);
    if (action === "add"     && method === "POST") return teamAdd(teamName, req, authed, repo, config);
    if (action === "remove"  && method === "POST") return teamRemove(teamName, req, authed, repo, config, sessions);
    if (action === "members" && method === "GET")  return teamMembers(teamName, authed, repo, config);
    if (action === "policy"  && method === "POST") return teamPolicy(teamName, req, authed, repo, config);
    if (action === "delete-alias" && method === "POST") return teamDeleteAlias(teamName, req, authed, repo, config);
  }

  let gate: Decision | undefined;
  if (path.startsWith("/api/admin/")) {
    const req: AuthzRequest = { verb: "admin", user: signedIn(authed) };
    const decision = await authorize(repo, repo.read, { admins: config.admins }, req);
    recordDecision(repo, repo.read, { user: authed.user_email }, req, decision, { route: path });
    if (!decision.allow) return forbidden(decision.reason);
    gate = decision;
  }
  if (path === "/api/admin/roles"          && method === "GET")  return adminRoleList(url, repo, config);
  if (path === "/api/admin/roles/grant"    && method === "POST") return adminRoleGrant(req, authed, repo, gate!);
  if (path === "/api/admin/roles/revoke"   && method === "POST") return adminRoleRevoke(req, authed, repo, config, gate!);
  if (path === "/api/admin/revoke-session" && method === "POST") return adminRevokeSession(req, authed, repo, sessions.disconnectUser);
  if (path === "/api/admin/disable-user"   && method === "POST") return adminDisableUser(req, authed, repo, sessions.disconnectUser, slack);
  if (path === "/api/admin/enable-user"    && method === "POST") return adminEnableUser(req, authed, repo, slack);
  if (path === "/api/admin/unlink-idp"     && method === "POST") return adminUnlinkIdp(req, authed, repo, config);
  if (path === "/api/admin/services"       && method === "GET")  return adminServiceList(url, repo);
  if (path === "/api/admin/services"       && method === "POST") return adminServiceCreate(req, authed, repo, gate!);
  if (path === "/api/admin/services/disable" && method === "POST") return adminServiceSetDisabled(req, authed, repo, true, sessions.disconnectUser);
  if (path === "/api/admin/services/enable"  && method === "POST") return adminServiceSetDisabled(req, authed, repo, false, sessions.disconnectUser);
  if (path === "/api/admin/services/delete-alias" && method === "POST") return adminServiceDeleteAlias(req, authed, repo);
  if (path === "/api/admin/services/credentials" && method === "POST") return adminServiceCredentialAdd(req, authed, repo, config);
  if (path === "/api/admin/services/credentials/revoke" && method === "POST") return adminServiceCredentialRevoke(req, authed, repo);

  return notFound();
}
