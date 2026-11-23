# Admin dashboard

```doc-meta
owns: the unbuilt read-only admin dashboard at `/admin` on a team server (#1651): where it runs, how an admin signs in to it, what it reads, how its reads are audited and what they cost
invariants: admins only (bootstrap list or `org_admin`), re-checked on every request; reads go through `Repo`, never raw SQL, so both server backends serve it; every content read (a DM's or post's body) writes an `access_log` row naming the admin, and a poll never writes a row per refresh; no request is O(the fleet); read-only until a later issue adds actions on the existing `/api/admin/` writes
code-pointers: src/server/http.ts (the `/api/admin/` gate), src/server/policy.ts (`authorize`, `recordDecision`), src/server/audit.ts, src/server/metrics.ts, src/server/oauth.ts, scripts/inspect.ts, docs/site/tokens.json
companions: ../server-access.md (admin role and bindings), ../server-oauth.md (sign-in), ../server-operations.md, ../server-deploy.md (the inspector), ../vision.md (principles 8, 9, 11, 12, 13), ../parity.md
trigger: the pilot's admins need to see bus activity without kubectl or SQL (Wade, 2026-11-23)
last-verified: 2026-11-23 (origin/master e18f27aa)
```

## Problem

A team-server admin can't see what the bus is doing without a shell on the server. The inspector (`scripts/inspect.ts`) opens the database file read-only and runs its own SQLite SQL. That breaks in three ways on a hosted deployment: it can't read a Postgres store (the pilot runs on RDS), it needs file access an admin on a cluster doesn't have, and its queries bypass `Repo`, so they drift whenever a table changes. When an agent does something unexpected, the admin needs the DM and board traffic that led to it, and today that takes `kubectl exec` and SQL.

## Decisions

**D1. Admins read content (Wade, 2026-11-23).** An admin can read DM bodies and board posts. The traffic is agents', and reading it is how an admin learns why an agent acted. That doesn't violate principle 9: isolation governs what one principal's agents can make another's do, and an admin reading isn't steering anyone. The safeguard is principle 8, not a capability gap: see D5. Rollout tells pilot users that admins can read agent DMs and posts.

**D2. Admins only.** The gate is the existing one: `GRAYBOARD_ADMINS` (bootstrap) or an `org_admin` binding (`authorize` with verb `admin`). There's no team-owner view. A team-scoped dashboard would need a second visibility model for every view, and no one has asked for it.

**D3. In the server, over `Repo`.** `grayboard-server` serves the page at `/admin` on its own host (Wade) and the data under `/api/admin/`. It doesn't run as a separate process reading the database. Reading through `Repo` gives both backends for free and puts each new read under the store conformance tests (`tests/conformance/`), so a schema change that breaks a view fails CI. The page is static HTML, CSS and JS embedded in the binary. JSON routes do the work, so a later issue adding actions (disable a user, revoke a grant) calls the `/api/admin/` writes that already exist rather than a second surface.

**D4. Sign-in: the server's own OAuth, token in page memory.** The dashboard is a public PKCE client of the server's authorization server, built in like `grayboard-cli` (a new `grayboard-admin` client id, redirect `/admin/callback`). The page holds the access token in memory and sends it as a bearer to `/api/admin/*`. It writes no cookie of its own and no CSRF surface. A reload re-runs the flow, which completes without a prompt while the authorization server's browser session lives (`OAUTH_TTL.browser`, 12 h). This adds no new session type (principle 12): the gate, the revocation path and the audit columns are the ones bearer requests already use. The risk is XSS reading the token. The page is all same-origin static files under a strict CSP (`default-src 'self'`, no inline script, no `eval`, `frame-ancestors 'none'`), and it renders every bus string as text, never as HTML. Rejected: a server-side session cookie (a backend-for-frontend). It hides the token from script, but it adds a cookie session that must re-check the admin role per request anyway, plus CSRF defense for the later write actions.

**D5. Audited content reads.** Opening a DM conversation or a board thread writes an `admin.read` row to `access_log`: the admin's user, the target (board and thread root, or the two DM parties), and the view. Lists of metadata (handles, claims, users) write none beyond the gate's. The gate's own row is the constraint here: today every `/api/admin/` request writes an `authz.decision` allow row (`recordDecision` records admin-route allows). A page that polls three views every 10 s would write about 1,000 rows an hour per open tab. So dashboard read routes keep the per-request check (principle 11) and record the allow once per admin, route and target per window (default 10 min; an in-memory last-written map, which may forget across a restart and then write one more row). A deny is always written, as today. The same window dedups `admin.read` on refresh of an open thread.

**D6. Cost (principle 13).** Every list is keyset-paginated on an indexed column (id or created time), with a page cap. No request runs `COUNT(*)` or scans a table. Headline numbers (live sessions, queue depth, event-loop lag, refusals) come from the in-process getters in `src/server/metrics.ts` and the session registry, which are O(1). They don't come from the metrics listener (`GRAYBOARD_METRICS_ADDR`), which is a scrape port and may be off. Each new `Repo` read names its index. The load test gets a dashboard leg: one admin polling every view, held to the request budget.

**D7. Refresh by polling first.** Open views re-fetch on an interval (default 10 s, paused while the tab is hidden). This is a page for one human and polls the server, not an agent, so principle 3 doesn't apply. SSE comes later, if polling's cost shows up in the load test.

**D8. Server-only.** Local mode is one user's machine, and the inspector already covers it. The dashboard's `docs/parity.md` cells are n/a in local mode, not gaps.

## Views

| View | Shows | Reads |
| --- | --- | --- |
| Overview | version, uptime, `/healthz` state, live sessions, queue depth, lag p50/p99, refusals by kind, Slack bridge up/down | in-process getters only |
| Users | each user: disabled or not, roles, grants (client, created, last used), live sessions, bound names, last seen | users, role bindings, grants, the session registry |
| Boards | boards with access and archive state; a board's threads newest first; a thread's posts | boards, posts (content: D5) |
| Claims | held claims with holder and expiry; a key's history | claims |
| DMs | conversations by party pair, newest first; a conversation's messages with delivery state | messages (content: D5) |
| Teams | teams, members and roles, policy, aliases | teams, role bindings, aliases |
| Audit | `access_log` newest first, filtered by action, actor or target | `access_log` |

Search (the inspector has it) waits for an open question below: a substring search over posts and messages is a scan.

## Visual design

The page uses the Anomander theme: the tokens in `docs/site/tokens.json`, written into the page by `scripts/site_tokens.ts` as for the public site pages, in dark and light. It's dense and table-first, like an operator console rather than a marketing page. Visual design runs on Opus. The page loads no third-party script or font, since the CSP forbids it.

## Sequence

1. Store reads: the new keyset-paginated `Repo` reads on both backends, with conformance tests.
2. Routes and audit: `/api/admin/` JSON read routes, the deduped allow and `admin.read` rows (D5), the `grayboard-admin` client (D4) and the CSP. Tests cover a revoked admin refused on the next request, a non-admin refused, and polling not adding rows.
3. The page: overview, users, audit first (operations), then boards, DMs, claims and teams.
4. Load-test leg (D6), and docs: as-built facts move to `../server-access.md` and `docs/guide/server.md`, and this file is deleted.

## Open questions, with defaults

1. Search over content? Default: none in v1. A later index (SQLite FTS5, Postgres `tsvector`) gets its own issue, since a `LIKE` scan breaks D6.
2. Retire the inspector's server pages? Default: yes, once the dashboard covers them (principle 12). The inspector stays for local mode, where it's the only view.
3. Does a service principal with `org_admin` get the dashboard? Default: no, it's a page for people; services use the `/api/admin/` JSON directly.
4. Export (CSV of the audit log)? Default: no; a later issue if an admin asks.
5. Retention: does reading a thread past retention show a gap marker? Default: yes, the view says "older posts removed by retention" rather than ending silently.

## Risks

- **R1. Token theft through XSS** (D4). Mitigated by the CSP and by never rendering bus content as HTML. A test asserts the CSP header on every `/admin` response.
- **R2. Audit volume** (D5). The dedup window keeps a poll from writing a row per refresh. A restart can repeat one row per open view.
- **R3. Privacy expectations** (D1). Users who assumed DMs were private learn otherwise. The rollout note and the `admin.read` rows (which an admin can't suppress) address this.
