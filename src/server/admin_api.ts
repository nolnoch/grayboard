// The admin dashboard's read routes (#1651, docs/future/admin-dashboard.md D3, D5, D6): GET /api/admin/<view>, each a
// page of one Repo read behind http.ts's /api/admin/ gate. Lists are body-free; `thread` and `conversation` return
// content and write an `admin.read` row (D5). The gate's allow row and `admin.read` are written once per admin, route
// and target per ADMIN_ROW_WINDOW_MS (`AdminRows`), so a polling page doesn't write a row per refresh; a deny is
// always written (http.ts).
import { ADMIN_PAGE_MAX, type AuditCursor, type AuditFilter } from "./store/admin.ts";
import { writeAudit } from "./audit.ts";
import type { Repo } from "./db.ts";

export const ADMIN_ROW_WINDOW_MS = 10 * 60_000;
// The most (admin, route, target) keys remembered; past it, after a sweep, rows are written undeduplicated.
export const ADMIN_ROW_KEYS_MAX = 10_000;
// A list page's default size; `limit` asks for another, which the store clamps to 1..ADMIN_PAGE_MAX.
const DEFAULT_PAGE = 50;

class BadParam extends Error {}

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

type Route = {
  // The target the gate's and admin.read's dedup key on: what the page is about, not where in it.
  target(url: URL): string;
  // The audited view's name, for a route that returns content.
  content?: string;
  run(url: URL, repo: Repo): Promise<{ rows: unknown[]; next: unknown; read?: string | null }>;
};

const ROUTES: Record<string, Route> = {
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
export async function serveAdminRead(name: string, url: URL, repo: Repo, admin: string): Promise<Response> {
  const route = ROUTES[name]!;
  let result: Awaited<ReturnType<Route["run"]>>;
  try { result = await route.run(url, repo); }
  catch (e) {
    if (e instanceof BadParam) return Response.json({ code: "bad_request", message: e.message }, { status: 400 });
    throw e;
  }
  const { read, ...body } = result;
  if (route.content && read && adminRows(repo).due("read", admin, name, clipTarget(route.target(url)), repo.now())) {
    writeAudit(repo, repo.read, "admin.read", admin, clipTarget(read), { view: route.content });
  }
  return Response.json(body);
}
