// The load test's dashboard leg (#1651, admin-dashboard design D6): one org_admin polls every dashboard view at the
// page's cadence for the whole run, through the routes the page calls (`/api/admin/<route>`, page 1 of each list, plus
// one board thread and one DM conversation once the fleet has made them), on a grayboard-admin token. The run holds
// its requests to the bar's latency edge, wants every one answered 200, and counts the rows the dashboard admin's
// polling wrote (the gate's authz.decision allow and admin.read): at most one per route and target per dedup window.
import { ADMIN_ROW_WINDOW_MS } from "../src/server/admin_api.ts";
import { BUCKETS, type Hist } from "./loadtest_driver.ts";

// The views the page polls, each as the request its open view makes (src/server/admin/app.js). `need`: a view that
// waits for a target the fleet makes (a thread root, a DM pair) until a list shows one.
export type DashView = { view: string; route: string; params: (t: Targets) => Record<string, string> | null };
export type Targets = { board: string; user: string; team: string | null; root: number | null; pair: [string, string] | null };
export const DASH_VIEWS: DashView[] = [
  { view: "overview", route: "overview", params: () => ({}) },
  { view: "users", route: "users", params: () => ({}) },
  { view: "role-bindings", route: "role-bindings", params: () => ({}) },
  { view: "service-list", route: "service-list", params: () => ({}) },
  { view: "user-grants", route: "user-grants", params: t => ({ email: t.user }) },
  { view: "user-names", route: "user-names", params: t => ({ email: t.user }) },
  { view: "user-bindings", route: "role-bindings", params: t => ({ principal: t.user }) },
  { view: "audit", route: "audit", params: () => ({}) },
  { view: "boards", route: "boards", params: () => ({}) },
  { view: "threads", route: "threads", params: t => ({ board: t.board }) },
  { view: "thread", route: "thread", params: t => t.root === null ? null : { root: String(t.root) } },
  { view: "dms", route: "messages", params: () => ({}) },
  { view: "conversation", route: "conversation", params: t => t.pair && { a: t.pair[0], b: t.pair[1] } },
  { view: "claims", route: "claims", params: () => ({}) },
  { view: "teams", route: "teams", params: () => ({}) },
  { view: "team", route: "team", params: t => t.team === null ? null : { name: t.team } },
  { view: "team-bindings", route: "role-bindings", params: t => t.team === null ? null : { scope: t.team, role: "team_owner" } },
];

// What the leg measured: polls run, requests per view (latency histogram, client seconds; errors: any answer but a
// 200, or a fetch that threw), the first errors, and when its first and last polls started.
export type DashResult = {
  periodMs: number; polls: number; requests: number; views: Record<string, Hist>; errors: Record<string, number>; firstErrors: string[];
  firstAt: number | null; lastAt: number | null; skipped: Record<string, number>;
};

const newHist = (): Hist => ({ buckets: BUCKETS.map(() => 0), count: 0, sum: 0, errors: 0 });

// Starts the leg: a poll at once, then one per period; a poll that runs past its period delays the next rather than
// overlapping it (the page's one-poll-at-a-time rule). stop() waits out the poll in flight.
export function startDashboard(base: string, token: string, periodMs: number, targets: Omit<Targets, "root" | "pair">): { stop: () => Promise<DashResult> } {
  const r: DashResult = { periodMs, polls: 0, requests: 0, views: {}, errors: {}, firstErrors: [], firstAt: null, lastAt: null, skipped: {} };
  const t: Targets = { ...targets, root: null, pair: null };
  let stopped = false;
  const get = async (v: DashView, params: Record<string, string>) => {
    const h = r.views[v.view] ??= newHist();
    const url = new URL(`${base}/api/admin/${v.route}?${new URLSearchParams(params)}`);
    const t0 = performance.now();
    let status = 0, body = null as { rows?: unknown[] } | null;
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
      status = res.status;
      body = await res.json().catch(() => null) as typeof body;
    } catch (e) {
      r.errors[`${v.view}:fetch`] = (r.errors[`${v.view}:fetch`] ?? 0) + 1;
      if (r.firstErrors.length < 10) r.firstErrors.push(`${v.view}: ${e instanceof Error ? e.message : e}`);
      h.errors++;
      return null;
    }
    const s = (performance.now() - t0) / 1000;
    r.requests++;
    h.count++; h.sum += s;
    for (let i = 0; i < BUCKETS.length; i++) if (s <= BUCKETS[i]!) h.buckets[i]!++;
    if (status !== 200) {
      h.errors++;
      r.errors[`${v.view}:${status}`] = (r.errors[`${v.view}:${status}`] ?? 0) + 1;
      if (r.firstErrors.length < 10) r.firstErrors.push(`${v.view}: HTTP ${status} ${JSON.stringify(body).slice(0, 200)}`);
      return null;
    }
    return body?.rows ?? [];
  };
  const poll = async () => {
    const at = Date.now();
    r.firstAt ??= at; r.lastAt = at; r.polls++;
    // In turn, as one tab's views would be; a view's target comes from a list read earlier in this or a past poll.
    for (const v of DASH_VIEWS) {
      if (stopped) return;
      const params = v.params(t);
      if (!params) { r.skipped[v.view] = (r.skipped[v.view] ?? 0) + 1; continue; }
      const rows = await get(v, params);
      if (!rows) continue;
      if (v.view === "threads" && t.root === null && rows.length) t.root = Number((rows[0] as { id: number }).id);
      if (v.view === "dms" && t.pair === null) {
        const m = (rows as { sender: string; recipient: string; recipient_type: string }[]).find(x => x.recipient_type === "user");
        if (m) t.pair = [m.sender, m.recipient];
      }
    }
  };
  let next = Date.now();
  const done = (async () => {
    while (!stopped) {
      await poll();
      next = Math.max(next + periodMs, Date.now());
      while (!stopped && Date.now() < next) await Bun.sleep(Math.min(200, next - Date.now()));
    }
  })();
  return { async stop() { stopped = true; await done; return r; } };
}

// The rows the dashboard admin's polling wrote: its gate allows (authz.decision with detail.route under /api/admin/, its
// target detail.target, the dedup key's) and admin.read rows, each with its target. `deny`: any refusal of the admin, which the gate writes every time.
export type DashRow = { action: "authz.decision" | "admin.read"; target: string | null; route: string | null; view: string | null; allow: boolean | null };

// The dedup bound over a span (ms): one row per (admin, route, target) per window, so a key writes at most
// floor(span / window) + 1 rows (its first, then one each time the window lapses while polling goes on).
export const dedupBound = (spanMs: number, windowMs = ADMIN_ROW_WINDOW_MS) => Math.floor(Math.max(0, spanMs) / windowMs) + 1;

// The leg's failures, in the order the run reports them. `edge`: the bar's latency edge (s); `tooSlow`: the pooled
// small-pool rule the run's other pools use; `spanMs`: from the leg's first poll to its last.
export function judgeDashboard(r: DashResult, rows: DashRow[], durationMs: number, edge: number, label: string, tooSlow: (count: number, fast: number) => boolean): string[] {
  const out: string[] = [];
  const want = Math.floor(durationMs / r.periodMs);
  // The page's cadence: a poll every period, less one for the run's edges. A poll that ran past its period is one fewer.
  if (r.polls < Math.max(1, Math.floor(0.8 * want))) out.push(`dashboard: ${r.polls} polls; want ≥ 80% of ${want} (one per ${r.periodMs / 1000} s)`);
  // Every view ran, once its target existed (a thread and a conversation need the fleet's posts and DMs first).
  for (const v of DASH_VIEWS) if (!r.views[v.view]?.count) out.push(`dashboard ${v.view}: no request answered${r.skipped[v.view] ? ` (no target in ${r.skipped[v.view]} polls)` : ""}`);
  if (Object.keys(r.errors).length) out.push(`dashboard errors: ${JSON.stringify(r.errors)}${r.firstErrors.length ? ` (e.g. ${r.firstErrors.slice(0, 3).join("; ")})` : ""}`);
  // The request budget: the dashboard's requests, pooled, at the bar's edge (at most 1% slower, rounded up).
  const i = BUCKETS.indexOf(edge);
  const pool = Object.values(r.views).reduce((a, h) => ({ count: a.count + h.count, fast: a.fast + h.buckets[i]! }), { count: 0, fast: 0 });
  if (pool.count && tooSlow(pool.count, pool.fast)) out.push(`dashboard: ${(100 * pool.fast / pool.count).toFixed(2)}% of ${pool.count} requests at ${label}; want at most 1% slower, rounded up`);
  // The audit rows: no deny, and no more than the dedup bound per key.
  const denies = rows.filter(x => x.action === "authz.decision" && x.allow === false);
  if (denies.length) out.push(`dashboard: ${denies.length} gate denies for the dashboard admin (e.g. ${denies.slice(0, 3).map(x => x.route).join(", ")})`);
  const bound = dedupBound(r.firstAt !== null && r.lastAt !== null ? r.lastAt - r.firstAt : 0);
  // Gate allows per route and target, admin.read rows per view and target: one per key per window.
  const gate = new Map<string, number>(), reads = new Map<string, number>();
  for (const x of rows) {
    if (x.allow === false) continue;
    if (x.action === "authz.decision") { const k = `${x.route} ${x.target ?? ""}`; gate.set(k, (gate.get(k) ?? 0) + 1); }
    else { const k = `${x.view} ${x.target ?? ""}`; reads.set(k, (reads.get(k) ?? 0) + 1); }
  }
  const over = [
    ...[...gate].filter(([, n]) => n > bound).map(([k, n]) => `gate ${k}: ${n} rows`),
    ...[...reads].filter(([, n]) => n > bound).map(([k, n]) => `admin.read ${k}: ${n} rows`),
  ];
  if (over.length) out.push(`dashboard: audit rows over the dedup bound (${bound} per route and target) in ${r.polls} polls: ${over.slice(0, 3).join("; ")}`);
  if (r.polls > 1 && !rows.some(x => x.action === "admin.read")) out.push("dashboard: no admin.read row for the thread or conversation it opened");
  return out;
}

// The summary's view of the leg: polls, requests, per view count, p99 bucket edge and mean (ms), errors, row counts.
export function dashSummary(r: DashResult, rows: DashRow[]) {
  const p99 = (h: Hist) => h.count ? BUCKETS.find((_, i) => h.buckets[i]! >= 0.99 * h.count) ?? null : null;
  return {
    periodS: r.periodMs / 1000, polls: r.polls, requests: r.requests, errors: r.errors,
    views: Object.fromEntries(Object.entries(r.views).map(([v, h]) => [v, { count: h.count, p99Le: p99(h), meanMs: h.count ? 1000 * h.sum / h.count : null, errors: h.errors }])),
    rows: { gate: rows.filter(x => x.action === "authz.decision").length, adminRead: rows.filter(x => x.action === "admin.read").length, bound: dedupBound(r.firstAt !== null && r.lastAt !== null ? r.lastAt - r.firstAt : 0) },
  };
}
