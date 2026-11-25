// The admin dashboard's read routes (#1651, docs/server-admin-dashboard.md §2): GET /api/admin/<view>, each a
// page of one Repo read behind http.ts's /api/admin/ gate. Lists are body-free; `thread` and `conversation` return
// content and write an `admin.read` row (D5). The gate's allow row and `admin.read` are written once per admin, route
// and target per ADMIN_ROW_WINDOW_MS (`AdminRows`), so a polling page doesn't write a row per refresh; a deny is
// always written (http.ts).
import { ADMIN_PAGE_MAX, type AuditCursor, type AuditFilter } from "./store/admin.ts";
import { writeAudit } from "./audit.ts";
import type { Repo } from "./db.ts";
import type { LagWindow } from "./metrics.ts";
import { GRANT_LIST_MAX } from "./oauth-types.ts";
import { isRole, ROLES } from "./policy.ts";
import { isValidEmail } from "../shared/addressing.ts";

export const ADMIN_ROW_WINDOW_MS = 10 * 60_000;
// The most (admin, route, target) keys remembered; past it, after a sweep, rows are written undeduplicated.
export const ADMIN_ROW_KEYS_MAX = 10_000;
// A list page's default size; `limit` asks for another, which the store clamps to 1..ADMIN_PAGE_MAX.
const DEFAULT_PAGE = 50;

class BadParam extends Error {}
// A route this server doesn't serve (overview without its getters): 501, not the caller's error.
class NotServed extends Error {}

// When each (kind, admin, route, target) last wrote its row, in memory: a restart forgets and writes one more (D5).
export class AdminRows {
  private last = new Map<string, number>();
  constructor(private window = ADMIN_ROW_WINDOW_MS, private max = ADMIN_ROW_KEYS_MAX) {}
  // True when the row is due (none in the window), and records it as written.
  due(kind: "gate" | "read", admin: string, route: string, target: string, now: number): boolean {
    const key = `${kind}\0${admin}\0${route}\0${target}`;
    const at = this.last.get(key);
    if (at !== undefined && now - at < this.window) return false;
    if (at === undefined && this.last.size >= this.max) {
      for (const [k, t] of this.last) if (now - t >= this.window) this.last.delete(k);
      if (this.last.size >= this.max) return true;
    }
    this.last.set(key, now);
    return true;
  }
}
const rowsByRepo = new WeakMap<Repo, AdminRows>();
export const adminRows = (repo: Repo): AdminRows => {
  let rows = rowsByRepo.get(repo);
  if (!rows) rowsByRepo.set(repo, rows = new AdminRows());
  return rows;
};

const int = (url: URL, name: string): number => {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return 0;
  if (!/^\d{1,15}$/.test(raw)) throw new BadParam(`${name} must be a non-negative integer`);
  return Number(raw);
};
const str = (url: URL, name: string): string | undefined => url.searchParams.get(name) ?? undefined;
const need = (url: URL, name: string): string => {
  const v = str(url, name);
  if (!v) throw new BadParam(`${name} required`);
  return v;
};
const limitOf = (url: URL): number => url.searchParams.has("limit") ? int(url, "limit") : DEFAULT_PAGE;
// A page and the cursor of the next, null at the end.
const page = <T, C>(rows: T[], limit: number, next: (last: T) => C) =>
  ({ rows, next: rows.length > 0 && rows.length >= Math.min(limit, ADMIN_PAGE_MAX) ? next(rows[rows.length - 1]!) : null });

function auditFilter(url: URL): AuditFilter {
  const action = str(url, "action"), target = str(url, "target"), actor = str(url, "actor");
  if (actor !== undefined) {
    if (action !== undefined || target !== undefined) throw new BadParam("actor combines with no other filter");
    return { actor };
  }
  if (target !== undefined && action === undefined) throw new BadParam("target needs action");
  return action === undefined ? {} : target === undefined ? { action } : { action, target };
}
// A DM pair in a fixed order, so (a, b) and (b, a) are one target.
const pair = (a: string, b: string) => (a < b ? `${a} ${b}` : `${b} ${a}`);

// The Overview's headline numbers (D6): in-process O(1) getters only, no store read, so `startServer` supplies them.
export type AdminOverview = {
  version: string; started_at: number; uptime_s: number;
  // /healthz's verdict (its cached database probe and the lag gate): ok, or the code it fails with.
  health: { ok: boolean; code: string | null };
  lag: LagWindow | null; queue_waiters: number;
  refusals: Record<string, number>;
  gauges: { name: string; help: string; values: { value: number; labels?: Record<string, string> }[] }[];
  slack: "up" | "down" | "off";
};
// What a read route may need beyond the store: the Overview's getters, the bootstrap admins (GRAYBOARD_ADMINS, listed
// as org_admin bindings with no id, as /api/admin/roles lists them) and the CLI token idle window (a token unused
// past it is dead, so the grants list leaves it out).
export type AdminContext = { overview?: () => Promise<AdminOverview>; admins?: readonly string[]; cliIdleDays?: number };

type Route = {
  // The target the gate's and admin.read's dedup key on: what the page is about, not where in it.
  target(url: URL): string;
  // The audited view's name, for a route that returns content.
  content?: string;
  run(url: URL, repo: Repo, ctx: AdminContext): Promise<{ rows: unknown[]; next: unknown; read?: string | null }>;
};

// A name here must not be an existing /api/admin/ path (roles, services, grants…): a GET on it would be served from here
// instead, in this shape, to the CLI too. The dashboard's versions of those lists carry their own names.
const ROUTES: Record<string, Route> = {
  overview: { target: () => "", async run(_url, _repo, ctx) {
    if (!ctx.overview) throw new NotServed("overview not served here");
    return { rows: [await ctx.overview()], next: null };
  } },
  // Role bindings in id order, filtered by role, principal or scope as /api/admin/roles is; the first page leads with
  // the bootstrap admins.
  "role-bindings": { target: url => ["role", "principal", "scope"].map(k => url.searchParams.get(k) ?? "").join("\0"), async run(url, repo, ctx) {
    const role = str(url, "role"), principal = str(url, "principal")?.toLowerCase(), scope = str(url, "scope")?.toLowerCase();
    if (role !== undefined && !isRole(role)) throw new BadParam(`role must be one of ${Object.keys(ROLES).join(", ")}`);
    const limit = Math.min(Math.max(limitOf(url), 1), ADMIN_PAGE_MAX), after = int(url, "after");
    const bindings = await repo.roles.list(repo.read, { ...(role ? { role } : {}), ...(principal ? { principal } : {}), ...(scope ? { scope } : {}) }, after, limit);
    const bootstrap = after === 0 && (role ?? "org_admin") === "org_admin" && scope === undefined
      ? (ctx.admins ?? []).filter(e => isValidEmail(e) && (principal === undefined || e === principal))
        .map(e => ({ id: null, principal: e, role: "org_admin", scope: null, granter: null, granted_at: null, source: "bootstrap" }))
      : [];
    return {
      rows: [...bootstrap, ...bindings.map(b => ({ ...b, source: "binding" }))],
      next: bindings.length === limit ? bindings[bindings.length - 1]!.id : null,
    };
  } },
  // Service principals in id order, with their owners.
  "service-list": { target: () => "", async run(url, repo) {
    const limit = Math.min(Math.max(limitOf(url), 1), ADMIN_PAGE_MAX);
    const rows = await repo.services.list(repo.read, int(url, "after"), limit);
    return { rows, next: rows.length === limit ? rows[rows.length - 1]!.id : null };
  } },
  // One user's live OAuth grants and CLI tokens, newest use first: each bounded by GRANT_LIST_MAX, a user signs in
  // once per harness and machine. No secret: ids, clients, labels and times.
  "user-grants": { target: url => url.searchParams.get("email") ?? "", async run(url, repo, ctx) {
    const user = await repo.users.findByEmail(repo.read, need(url, "email").toLowerCase());
    return { rows: user ? await grantRows(repo, user.id, ctx.cliIdleDays ?? 0, repo.now()) : [], next: null };
  } },
  // One user's bound names (their person scope's aliases, bounded by the scope cap), each with the unended session holding it
  // now (held_by; whether it is connected right now is the hub's, not the store's), when it was last used and where; most recently used first.
  "user-names": { target: url => url.searchParams.get("email") ?? "", async run(url, repo) {
    const email = need(url, "email").toLowerCase();
    const aliases = await repo.aliases.listForScope(repo.read, "person", email);
    const addresses = aliases.map(a => a.address);
    const [seen, holders] = await Promise.all([repo.aliases.seen(repo.read, addresses), repo.bindings.holdersOf(repo.read, addresses)]);
    const rows = aliases.map(a => {
      const s = seen.get(a.address);
      return { address: a.address, name: a.name, held_by: holders.get(a.address) ?? null, last_seen: s?.last_seen ?? null, cwd: s?.cwd ?? null, place: s?.place ?? null, created_at: a.created_at };
    }).sort((a, b) => (b.last_seen ?? 0) - (a.last_seen ?? 0) || (a.address < b.address ? -1 : 1));
    return { rows, next: null };
  } },
  users: { target: () => "", async run(url, repo) {
    const limit = limitOf(url);
    return page(await repo.admin.users(repo.read, int(url, "after"), limit), limit, u => u.id);
  } },
  teams: { target: () => "", async run(url, repo) {
    const limit = limitOf(url);
    return page(await repo.admin.teams(repo.read, int(url, "after"), limit), limit, t => t.id);
  } },
  team: { target: url => url.searchParams.get("name") ?? "", async run(url, repo) {
    const team = await repo.teams.findByName(repo.read, need(url, "name"));
    if (!team) return { rows: [], next: null };
    const [members, aliases] = await Promise.all([repo.teams.listMembers(repo.read, team.id), repo.aliases.listForScope(repo.read, "team", team.name)]);
    return { rows: [{ team, members, aliases }], next: null };
  } },
  boards: { target: () => "", async run(url, repo) {
    const rows = await repo.boards.catalogPage(repo.read, str(url, "after") ?? "");
    // A short page is the last: both backends page the catalog by 100 (CATALOG_PAGE).
    return { rows, next: rows.length >= 100 ? rows[rows.length - 1]!.name : null };
  } },
  threads: { target: url => url.searchParams.get("board") ?? "", async run(url, repo) {
    const limit = limitOf(url);
    return page(await repo.admin.threads(repo.read, need(url, "board"), int(url, "before"), limit), limit, t => t.id);
  } },
  thread: { target: url => url.searchParams.get("root") ?? "", content: "thread", async run(url, repo) {
    const root = int(url, "root");
    if (!root) throw new BadParam("root required");
    const limit = limitOf(url);
    const result = page(await repo.admin.thread(repo.read, root, int(url, "after"), limit), limit, p => p.id);
    const first = result.rows[0];
    return { ...result, read: first ? `${first.board}#${root}` : null };
  } },
  claims: { target: () => "", async run(url, repo) {
    const limit = limitOf(url);
    return page(await repo.admin.claims(repo.read, str(url, "after") ?? "", repo.now(), limit), limit, c => c.key);
  } },
  "claim-events": { target: url => url.searchParams.get("key") ?? "", async run(url, repo) {
    const limit = limitOf(url);
    return page(await repo.admin.claimEvents(repo.read, need(url, "key"), int(url, "before"), limit), limit, e => e.id);
  } },
  messages: { target: () => "", async run(url, repo) {
    const limit = limitOf(url);
    return page(await repo.admin.messages(repo.read, int(url, "before"), limit), limit, m => m.id);
  } },
  conversation: {
    target: url => pair(url.searchParams.get("a") ?? "", url.searchParams.get("b") ?? ""), content: "conversation",
    async run(url, repo) {
      const a = need(url, "a"), b = need(url, "b");
      const limit = Math.min(limitOf(url), ADMIN_PAGE_MAX);
      const before = int(url, "before");
      const rows = await repo.messages.history(repo.read, [a], b, Math.max(1, limit), before || undefined);
      return { ...page(rows, limit, m => m.id), read: rows.length ? pair(a, b) : null };
    },
  },
  audit: { target: url => ["action", "target", "actor"].map(k => url.searchParams.get(k) ?? "").join("\0"), async run(url, repo) {
    const filter = auditFilter(url);
    const at = url.searchParams.get("before_at"), id = url.searchParams.get("before_id");
    if ((at === null) !== (id === null)) throw new BadParam("before_at and before_id go together");
    const before: AuditCursor | null = at === null ? null : { at: int(url, "before_at"), id: int(url, "before_id") };
    const limit = limitOf(url);
    return page(await repo.admin.audit(repo.read, filter, before, limit), limit, r => ({ at: r.at, id: r.id }));
  } },
};

const PREFIX = "/api/admin/";
// A target is built from query parameters, so it's clipped before it keys the dedup map or lands in a row (a long
// one would overflow Postgres's btree index on access_log's target).
const MAX_TARGET = 256;
const clipTarget = (t: string) => (t.length > MAX_TARGET ? t.slice(0, MAX_TARGET) : t);
// The read route a GET path names, with its gate target, or undefined for any other /api/admin/ path.
export function adminReadRoute(method: string, path: string, url: URL): { name: string; target: string } | undefined {
  if (method !== "GET" || !path.startsWith(PREFIX)) return undefined;
  const name = path.slice(PREFIX.length);
  const route = Object.hasOwn(ROUTES, name) ? ROUTES[name] : undefined;
  return route ? { name, target: clipTarget(route.target(url)) } : undefined;
}

// Serves a read route the gate allowed. A content route writes its admin.read row once per window, and only when it
// returned content.
export async function serveAdminRead(name: string, url: URL, repo: Repo, admin: string, ctx: AdminContext = {}): Promise<Response> {
  const route = ROUTES[name]!;
  let result: Awaited<ReturnType<Route["run"]>>;
  try { result = await route.run(url, repo, ctx); }
  catch (e) {
    if (e instanceof BadParam) return Response.json({ code: "bad_request", message: e.message }, { status: 400 });
    if (e instanceof NotServed) return Response.json({ code: "not_implemented", message: e.message }, { status: 501 });
    throw e;
  }
  const { read, ...body } = result;
  if (route.content && read && adminRows(repo).due("read", admin, name, clipTarget(route.target(url)), repo.now())) {
    writeAudit(repo, repo.read, "admin.read", admin, clipTarget(read), { view: route.content });
  }
  return Response.json(body);
}

// A user's live OAuth grants (one harness sign-in on one machine; a service's credential grants) and CLI tokens
// (`cli:<session id>`), newest use first, each kind bounded by GRANT_LIST_MAX. A CLI token unused past idleDays is dead
// and left out (0: no idle limit). No secret: ids, clients, labels and times. `current` marks the caller's own CLI
// token. The own and admin grant lists (http.ts) and the dashboard's user-grants route all read through it (#930).
export async function grantRows(repo: Repo, userId: number, idleDays: number, now: number, current: number | null = null) {
  const usedAfter = idleDays > 0 ? now - idleDays * 86_400_000 - 1 : 0;
  const [grants, sessions] = await Promise.all([repo.oauth.listGrants(repo.read, userId, now), repo.sessions.listLive(repo.read, userId, usedAfter, GRANT_LIST_MAX)]);
  return [
    ...grants.map(g => ({ id: g.id, kind: g.credential ? "credential" : "oauth", client_id: g.clientId, created_at: g.createdAt, last_used_at: g.lastUsedAt, expires_at: g.expiresAt })),
    ...sessions.map(t => ({ id: `cli:${t.id}`, kind: "cli", label: t.label, created_at: t.created_at, last_used_at: t.last_used_at, expires_at: null, ...(t.id === current ? { current: true } : {}) })),
  ].sort((a, b) => b.last_used_at - a.last_used_at);
}
