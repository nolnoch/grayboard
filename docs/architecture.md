# Grayboard Distributed v1 — Architecture Reference

**Status:** As-built reference for commit `65ef415` (Distributed v1).
**Source spec:** [`meta/distributed-poc-spec.md`](../meta/distributed-poc-spec.md).
**Audience:** Operators, future implementers, anyone reading the code cold.

This document describes what is *actually* in the tree. Where the implementation diverges from the spec, the deviation is called out inline and summarized in §11.

---

## 1. Process model

Three distinct processes, one repo, one `package.json`:

| Process | Entry | Run as | Role |
|---|---|---|---|
| **Backend server** | `src/server/main.ts` | systemd on EC2 | Single central HTTP+WSS endpoint. Owns SQLite. |
| **MCP server** (a.k.a. plugin shim) | `src/plugin/main.ts` | spawned by Claude Code per `.mcp.json` | Stdio MCP server inside a Claude session. WSS client to backend. |
| **CLI** | `src/cli/main.ts` | invoked by humans | `grayboard login / identity / team / admin` against backend HTTP API. |

A fourth tree, **`src/local/`**, is the **sanctioned same-machine mode** (v0 preserved): Unix-socket wakeup, direct SQLite, no central server. It exists because live push between concurrent sessions on one machine doesn't need a managed server process — Unix sockets are the right primitive for that. Point a repo's `.mcp.json` at `src/local/main.ts` for local-only use, or at `src/plugin/main.ts` for the distributed v1 backend. Rationale captured in `meta/future-notes.log`.

```
┌──────────────────────┐    WSS  /ws    ┌────────────────────────┐
│  Claude Code session │  ───────────►  │                        │
│  ┌────────────────┐  │                │  backend (server/)     │
│  │ MCP server     │  │  ◄─ push ───   │  ─ http.ts             │
│  │ (plugin/)      │  │                │  ─ ws.ts               │
│  └────────────────┘  │                │  ─ db.ts (SQLite WAL)  │
└──────────────────────┘                │  ─ auth.ts (Google OIDC)│
                                        │  ─ retention.ts        │
┌──────────────────────┐    HTTPS       │                        │
│  grayboard CLI       │  ───────────►  │                        │
│  (cli/)              │                └────────────────────────┘
└──────────────────────┘
```

---

## 2. Repo layout

```
src/
  server/
    main.ts          # Process entry. Bun.serve with HTTP+WSS handlers.
    config.ts        # Env-var loading + validation (fail-fast).
    db.ts            # Schema (idempotent CREATE IF NOT EXISTS) + Repo facade.
    auth.ts          # Token mint/hash/verify, Google JWKS verify, code exchange.
    can_send.ts      # canSend / canAdmin authorization seams.
    audit.ts         # writeAudit helper + AuditAction union.
    retention.ts     # Nightly prune jobs (messages + audit log).
    http.ts          # All HTTP routes (auth, whoami, identities, teams, admin).
    ws.ts            # WebSocket lifecycle: hello, send, history, thread, ack, ping.
    *.test.ts        # Unit tests for db, auth, can_send, retention.
  plugin/
    main.ts          # MCP stdio process. Reads creds, opens WSS, exposes 3 tools.
    client.ts        # GrayboardClient: reconnect, request/response, push handling.
  cli/
    main.ts          # Commander program. All subcommands.
    api.ts           # ApiClient + credentials loading.
    oauth_flow.ts    # PKCE loopback flow against Google.
  shared/
    protocol.ts      # WS frame types + parseClientMessage validator.
    addressing.ts    # parseAddress / formatDirectAddress / formatTeamAddress.
  local/             # Sanctioned same-machine mode (v0). Owns its own SQLite + sockets.
tests/integration/
  ws.test.ts         # All test.todo — placeholders, not implemented. See §11 D9.
deploy/
  grayboard.service  # systemd unit
  Caddyfile          # TLS terminator (host = grayboard.example.com placeholder)
  backup.sh          # Nightly sqlite3 .backup → S3
meta/                # Spec + proposal
docs/                # This file.
```

Bin entries in `package.json`: `grayboard`, `grayboard-plugin`, `grayboard-server`.

---

## 3. Data model

All tables in one SQLite file (default `/var/lib/grayboard/bus.db`). Pragmas on open: `journal_mode=WAL, synchronous=NORMAL, foreign_keys=ON, auto_vacuum=INCREMENTAL`. Schema is created idempotently in `db.ts:initSchema` — no migration tool.

| Table | Purpose | Key columns |
|---|---|---|
| `users` | One per Google identity. Created on first login. | `email` (unique, lowercased), `disabled_at` |
| `sessions` | Server-issued bearer tokens. SHA-256 stored, raw never persisted. | `token_hash` (unique), `revoked_at`, `last_used_at` |
| `identities` | Per-Claude-session names, owned by a user. | `(user_id, name)` unique |
| `teams` | Globally-unique team names. | `name` unique, `policy` (default `'open'`, unused) |
| `team_members` | Composite PK `(team_id, user_id)`. | `joined_at` |
| `messages` | Single table for direct + team. Stores canonical address strings, not FK ids. | `recipient_type ∈ {user,team}`, `recipient`, `parent_id` |
| `cursors` | Per-(identity, stream) read cursor. | `(identity_id, stream_type, stream_ref)` PK |
| `access_log` | Append-only audit. 90-day retention. | `at`, `actor`, `action`, `target`, `detail` (JSON) |

**Cursors are per-identity, not per-user.** Each of Wade's identities advances independently in each team inbox. New team cursors initialize to the current `MAX(messages.id)` for that team — joining never replays history (`db.ts:initTeamCursorToCurrentMax`).

**`teams.policy` and `users.disabled_at`** are the schema seams reserved for future `canSend` policy without migration churn (spec §6.4).

---

## 4. Authentication & sessions

Two layers, kept strictly separate (spec §5.1):

1. **Google OIDC** — proves the human is `<email>@<orgDomain>` once, at login.
2. **Server-issued opaque session tokens** — proves a process is acting on that human's behalf on every subsequent call.

We never store Google tokens. `id_token` is verified and discarded; `refresh_token` and `access_token` are dropped on receipt.

### 4.1 Login flow

`grayboard login` (`cli/main.ts` + `cli/oauth_flow.ts`):

1. **Bootstrap.** GET `/api/auth/config` from the backend → `{google_client_id, org_domain}`. The CLI uses these to build the Google authorize URL. Env vars `GOOGLE_OAUTH_CLIENT_ID` / `GRAYBOARD_ORG_DOMAIN` override (escape hatch for testing against an alternate OAuth app).
2. Generate PKCE `code_verifier` + S256 challenge, random `state`.
3. Boot ephemeral loopback HTTP server on `127.0.0.1:0`.
4. `xdg-open` / `open` / `start` the Google authorize URL with `redirect_uri=http://127.0.0.1:<port>/cb`, `hd=<orgDomain>` if configured, `prompt=select_account`.
5. Receive `?code=&state=` on `/cb`. Validate `state`.
6. POST `{ code, code_verifier, redirect_uri }` to backend `/api/auth/exchange`.

Backend (`server/http.ts:authExchange` → `server/auth.ts:exchangeGoogleCode`):

7. Server-to-server POST to `https://oauth2.googleapis.com/token` with `client_secret`. **Client secret never leaves the server.**
8. Verify `id_token` via `jose` (RS256, JWKS cached internally), check `iss`, `aud`, `exp`, `hd == orgDomain`, `email_verified == true`.
9. `users.upsertByEmail(email, displayName)`.
10. Mint raw token: `gbrd_v1_<base64url(32 random bytes)>`. Store SHA-256 hex; raw is returned to the CLI exactly once.
11. Audit `auth.login`. Return `{ session_token, user_email, expires_at: null }`.

CLI writes `~/.grayboard/credentials` (mode `0600`, dir `0700`).

### 4.2 Per-request verification

`server/auth.ts:verifySessionToken`:
1. SHA-256 the bearer.
2. `sessions.findByTokenHash` (filters `revoked_at IS NULL`).
3. Load user; reject if `disabled_at IS NOT NULL`.
4. Async-touch `last_used_at` via `setImmediate` (best-effort).

Used by both the WS upgrade path (`server/main.ts:fetch`) and every authed HTTP route (`server/http.ts:requireAuth`).

### 4.3 No expiry, no rotation

Sessions never auto-expire (`expires_at: null`). Rotation = explicit logout or admin revocation. Spec §5.3 calls this out; the rationale is that a long-running Claude session shouldn't fail mid-task.

### 4.4 Dev-mode auth

`GRAYBOARD_DEV_AUTH=1` enables `POST /api/auth/dev-login { email }` which mints a session without Google. Server **refuses to start** if both `GRAYBOARD_DEV_AUTH=1` and `GOOGLE_CLIENT_SECRET` are set (`config.ts:16-20`). CLI: `grayboard login --dev <email>`.

### 4.5 Logout

`POST /api/auth/logout` flips `sessions.revoked_at`. CLI then truncates the credentials file (does not delete it — see `cli/main.ts:175`). Active WS connections are **not** swept; they continue until disconnect, after which reconnect fails auth.

---

## 5. Wire protocol

### 5.1 Connect

Client opens `wss://<host>/ws` with `Authorization: Bearer <token>` on the upgrade request. The server validates the token in `Bun.serve.fetch` *before* `server.upgrade`. Token-bearing JSON frames over the wire are otherwise unauthenticated — auth lives on the upgrade only.

### 5.2 Frames (`shared/protocol.ts`)

Client → Server:

```ts
{ type: "hello",   req_id, identity }
{ type: "send",    req_id, recipient, body, parent_id? }
{ type: "history", req_id, peer?, limit?, before_id? }
{ type: "thread",  req_id, root_id }
{ type: "ack",     req_id, message_ids: number[] }
{ type: "pong" }
```

Server → Client:

```ts
{ type: "hello_ok",   req_id, identity_full, user_email, teams: string[] }
{ type: "send_ok",    req_id, message_id, delivered_now }
{ type: "history_ok", req_id, messages: Message[] }
{ type: "thread_ok",  req_id, messages: Message[] }
{ type: "ack_ok",     req_id }
{ type: "push",       message: Message }     // no req_id
{ type: "ping" }
{ type: "error",      req_id?, code, message }
```

`ErrorCode = unauthenticated | forbidden | bad_request | not_found | rate_limited | internal | superseded`.

Every inbound frame is parsed by `parseClientMessage` — hand-rolled validator with type-narrowed asserts.

### 5.3 Hello & lazy provisioning

`ws.ts:handleHello`:
- Lowercase the requested identity name; reject invalid names with `bad_request`.
- `findByUserAndName`; if missing, **lazily create** the identity row and audit `identity.created` with `{lazy: true}`.
- Look for an existing WS in the in-memory registry under this `identity_id`. If present and ≠ current, send `error/superseded` to the old one and close it.
- Register the new WS, populate `WsData`, send `hello_ok` (with current team list as `team:<name>` strings), then drain.

### 5.4 Drain

`ws.ts:drainForIdentity` queries `messages.unreadSince` for the direct stream + every team stream the user belongs to, ordered by `id ASC`, and pushes all of them. Cursors are **not** advanced here — the client must `ack` (spec §4.5.3, §9.2).

### 5.5 Send & fan-out

`ws.ts:handleSend`:
- Reject body > 64 KiB (`MAX_BODY_BYTES`).
- `parseAddress` the recipient.
- For team targets: resolve the team row, call `canSend(principal, {kind:"team", team_id, name}, ctx)`, insert message, `fanOutToTeam` (iterate every member's identities, push to any with an open WS).
- For user targets: resolve recipient user + identity, `canSend(principal, {kind:"user", address}, ctx)`, insert, push if recipient WS is in registry.
- Return `send_ok { message_id, delivered_now }`.

Offline recipients pick up via the next connect's drain.

### 5.6 Acks & cursor advance

`ws.ts:handleAck` looks up each message ID and advances the matching cursor:
- `recipient_type=user` → `cursors.advance(identity_id, "direct", identity_full, msg_id)`
- `recipient_type=team` → `cursors.advance(identity_id, "team", msg.recipient, msg_id)`

`cursors.advance` uses `MAX(excluded, existing)` so out-of-order acks can't regress.

### 5.7 Heartbeats

`startPingInterval` (`ws.ts:315`) emits `{type:"ping"}` to every open WS every 30s. Client replies `{type:"pong"}`. Bun.serve `idleTimeout: 75` (spec §4.5.4 satisfied).

### 5.8 Connection registry

`Map<identity_id, ServerWebSocket>` in `ws.ts:21`. Per-process state; on backend restart, clients reconnect and re-drain from durable cursors.

---

## 6. Authorization seam (`canSend`)

`server/can_send.ts` — single file, two functions, both currently allow-all:

```ts
export function canSend(sender: SendPrincipal, target: SendTarget, ctx: SendContext): SendDecision
export function canAdmin(principal: SendPrincipal): { allow: true }
```

Contract:
- **Pure, synchronous.** No `Promise`. SQLite reads in Bun are synchronous.
- **`SendPrincipal` is pre-resolved.** Caller already authenticated and looked up the identity.
- **`SendTarget` is tagged.** Team targets arrive with `team_id` resolved — `canSend` does no I/O for team lookups.
- **Tagged-union return.** `{allow:true}` or `{allow:false, code, reason}`. `code` maps to a WS `error` frame.
- **`ctx.db: Repo`** — the spec said `Database`; the implementation passes `Repo` (the higher-level facade). Practical, but a minor divergence — see §11 D6.

Call sites:
- `ws.ts:handleSend` (direct + team branches).
- That's it. CLI doesn't send messages in v1, so there's no second site (spec §6.3).

`canAdmin` is **defined but never called**. Admin HTTP routes simply require auth and proceed. Functionally equivalent in v1 (canAdmin returns `true` unconditionally), but the seam isn't wired — see §11 D11. `http.ts:35` even constructs a `SendPrincipal` for what looks like a planned `canAdmin(...)` call that never appears.

Test coverage in `can_send.test.ts` matches the spec §6.6 contract (allow user→user, allow user→team, denied-shape exists, synchronous).

---

## 7. HTTP API

`server/http.ts:handleHttp` is a flat router: literal path matches plus one regex for `/api/teams/:name/:action`.

| Route | Auth | Notes |
|---|---|---|
| `GET /healthz` | none | Returns 200 if DB reachable; 503 otherwise. |
| `GET /api/auth/config` | none | Public bootstrap: `{google_client_id, org_domain}`. Used by the CLI to start the PKCE flow without per-developer OAuth env vars. |
| `POST /api/auth/exchange` | none | Body: `{code, code_verifier, redirect_uri}`. Returns session token. |
| `POST /api/auth/dev-login` | none (only if `GRAYBOARD_DEV_AUTH=1`; else 404) | Body: `{email}`. |
| `POST /api/auth/logout` | bearer | Revokes current session. |
| `GET /api/whoami` | bearer | `{email, identities:[name…], teams:[name…]}`. |
| `GET /api/identities` | bearer | List user's identities. |
| `POST /api/identities` | bearer | Body: `{name}`. Conflict (409) if exists. |
| `DELETE /api/identities/:name` | bearer | |
| `GET /api/teams` | bearer | Teams the user belongs to. |
| `POST /api/teams` | bearer | Body: `{name}`. Creator auto-added as member. |
| `POST /api/teams/:name/join` | bearer | Initializes team cursors for all of user's identities. |
| `POST /api/teams/:name/leave` | bearer | |
| `GET /api/teams/:name/members` | bearer | |
| `POST /api/admin/revoke-session` | bearer | Body: `{email, all?}`. **`all` flag is ignored** — both branches revoke all (D5). |
| `POST /api/admin/disable-user` | bearer | Body: `{email}`. Sets `disabled_at`. |
| `POST /api/admin/enable-user` | bearer | Clears `disabled_at`. |

Error envelope: `{code, message}` with HTTP status (400/401/403/404/409/500/503).

---

## 8. CLI surface

Implemented with `commander`. Global `--json` toggles output format.

```
grayboard login [--dev <email>] [--server <url>]
grayboard logout
grayboard whoami

grayboard identity list
grayboard identity create <name> [--mcp [path]] [--force]
grayboard identity rm <name>

grayboard team list
grayboard team create <name>
grayboard team join <name>
grayboard team leave <name>
grayboard team members <name>

grayboard admin revoke-session --email <e> [--all]
grayboard admin disable-user --email <e>
grayboard admin enable-user --email <e>
```

No `grayboard send`, no `grayboard tail` — sending is what the MCP server is for (spec §8).

### 8.1 `identity create --mcp`

Convenience: also writes/merges `.mcp.json` so engineers don't hand-craft it.

- `--mcp` (no value) → `./.mcp.json`.
- `--mcp <path>` → explicit path.
- Default: **merge** — preserve other `mcpServers` entries; overwrite only `grayboard`. Refuse if file exists but is invalid JSON or has no `mcpServers` object.
- `--force` clobbers, with a warning listing lost keys.

Plugin-path resolution (`cli/main.ts:findPluginPath`):
1. `GRAYBOARD_PLUGIN_PATH` env var. If it ends in `.ts` → `bun <path>`; otherwise treated as a binary path → `<path>` with no args.
2. Sibling `grayboard-plugin` (or `grayboard-plugin.exe`) in the same directory as the running CLI binary (the `install.sh` case).
3. Walk up to 6 levels from `process.argv[1]` looking for `src/plugin/main.ts` (the source-tree case → `bun src/plugin/main.ts`).
4. Else fail with a clear error — never write a broken file.

The resolver returns `{command, args}` and the same shape lands in the `.mcp.json` entry, so compiled-binary installs and source-tree installs produce different (but each correct) `.mcp.json` files.

### 8.2 Credentials

Read by `cli/api.ts:loadCredentials` and `plugin/main.ts:loadCredentials`. Env-var overrides:
- `GRAYBOARD_CREDENTIALS` — alternate path.
- `GRAYBOARD_SERVER` — override `server` field.
- `GRAYBOARD_TOKEN` — raw token bypass (plugin only; dev convenience).

---

## 9. MCP server (plugin shim)

`src/plugin/main.ts` mirrors the v0 MCP tool surface exactly:

| Tool | Maps to WS request |
|---|---|
| `bus_send(recipient, body, parent_id?)` | `{type:"send"}` |
| `bus_history(peer?, limit?, before_id?)` | `{type:"history"}` |
| `bus_thread(root_id)` | `{type:"thread"}` |

`GrayboardClient` (`plugin/client.ts`):
- Connects WSS with `Authorization: Bearer` header (Bun's non-standard `WebSocket` constructor option).
- Sends `hello { identity: BUS_IDENTITY }` on open.
- Resolves a `ready()` promise on `hello_ok`.
- Routes responses by `req_id` to pending request promises.
- On `push`: invokes `onPush(msg)` then auto-acks the message id.
- On `error/superseded`: sets `dead=true` and calls `process.exit(1)` — does *not* reconnect.
- Otherwise, reconnect with exponential backoff (1s → 2s → … capped at 30s).
- On `ping`: sends `pong`.

**Channel notification format** (`plugin/main.ts:buildChannelTag`):

```
<channel source="grayboard" message_id="123" from="a@org/fe" created_at="…" [in_reply_to="…"] [team="eng"]>body</channel>
```

`team="<name>"` is included only for team messages. The MCP `notification` payload uses `params: { content: <tag string> }` — note this differs from the v0 shape which used a separate `meta` object. The on-the-wire `<channel>` tag content matches what Claude Code expects.

Per-repo `.mcp.json` template:

```json
{
  "mcpServers": {
    "grayboard": {
      "command": "bun",
      "args": ["/abs/path/to/grayboard/src/plugin/main.ts"],
      "env": { "BUS_IDENTITY": "fe" }
    }
  }
}
```

No DB env var — backend owns storage.

---

## 10. Delivery semantics

- **Ordering:** messages to an identity arrive in `id` order (ASC drain + immediate post-INSERT push).
- **At-least-once:** cursors only advance on `ack`. A disconnect mid-push causes redelivery on next drain. Plugin forwards duplicates to Claude unchanged; `message_id` is stable.
- **Per-identity team cursors:** each of a user's identities can be at a different position in the same team inbox. Joining a team initializes new cursors at the current team-max — no history replay.
- **Live fan-out:** team sends iterate every member's `identities` and push to those with an open WS. Offline identities catch up via drain.
- **No per-recipient fan-out rows.** One row per send, addressed to `team:<name>`. Cursors do the rest.

**Body limit:** 64 KiB UTF-8 (rejected with `bad_request`).

---

## 10b. Build & distribution

Two delivery mechanisms, both supported.

**Compiled binaries** (recommended for end users). `bun build --compile` produces self-contained executables — no Bun runtime needed at the install site.

```bash
bun run build           # builds all three into dist/
# or individually:
bun run build:cli       # → dist/grayboard
bun run build:plugin    # → dist/grayboard-plugin
bun run build:server    # → dist/grayboard-server
```

Each binary is ~100 MB (Bun runtime + bundled JS). Bun cross-compiles via `--target=bun-{linux,darwin}-{x64,arm64}` from a single host.

**GitHub Actions release pipeline** (`.github/workflows/release.yml`):
- Triggered by pushing a `v*` tag (or manual `workflow_dispatch`).
- Matrix-builds all four `{linux,darwin}×{x64,arm64}` targets in parallel.
- Uploads each binary as `dist/grayboard-<target>`, `grayboard-plugin-<target>`, `grayboard-server-<target>` to the GitHub Release.
- Also attaches `install.sh` to the release.

**`install.sh`** at repo root:
- Detects OS + arch.
- Downloads `grayboard-<target>` and `grayboard-plugin-<target>` from `releases/latest/download` to `~/.local/bin/grayboard` and `~/.local/bin/grayboard-plugin`.
- With `INSTALL_SERVER=1`, also fetches `grayboard-server-<target>`. Used on the EC2 host alongside `INSTALL_DIR=/usr/local/bin`.
- `chmod +x`, warns if `INSTALL_DIR` isn't on `PATH`.
- Overrides: `GRAYBOARD_VERSION=v0.1.0`, `INSTALL_DIR=/some/path`, `GRAYBOARD_REPO=fork/grayboard`, `INSTALL_SERVER=1`.

The compiled CLI's `findPluginCommand` (§8.1) finds the sibling `grayboard-plugin` binary automatically and writes a binary-form `.mcp.json` (no `bun` invocation). Source-tree installs continue to write the `bun src/plugin/main.ts` form. Both are valid; the user just sees `grayboard identity create fe --mcp` and the right thing happens.

**`grayboard-server`** is shipped in releases as the default server install path. The systemd unit (`deploy/grayboard.service`) points at `/usr/local/bin/grayboard-server` out of the box; the source-tree alternative (`bun run src/server/main.ts` with `WorkingDirectory=/opt/grayboard`) is documented in the unit file as a comment. Server upgrades are `INSTALL_SERVER=1 GRAYBOARD_VERSION=vX.Y.Z bash install.sh && systemctl restart grayboard` — no git pull, no `bun install`, no source on the host.

### 10b.1 Cutting a release

Recommended flow for the first release (and a useful template for later ones):

1. **Pre-flight on a release-candidate tag.** Tag from any branch — the workflow runs against whatever commit the tag points at, not against the default branch. This lets you validate the pipeline without merging anything.
   ```bash
   git tag v0.1.0-rc1 -m "release candidate"
   git push origin v0.1.0-rc1
   ```
2. **Watch the run.** GitHub → Actions → "Release". Confirm the four matrix jobs build and the publish job attaches 12 binaries (3 entry points × 4 targets) plus `install.sh` to the auto-created release.
3. **Smoke-test the install on a clean machine** (or a temp dir):
   ```bash
   GRAYBOARD_VERSION=v0.1.0-rc1 INSTALL_DIR=/tmp/gb bash install.sh
   /tmp/gb/grayboard --version
   ```
4. **Promote to a real release.** Either move the rc to a clean tag (`git tag v0.1.0 && git push origin v0.1.0`) or, if you want to throw the rc away, delete the rc release + tag in the GitHub UI first to keep the release list tidy.

**Operational notes / gotchas** (standard GitHub Actions behavior, captured here so you don't have to re-derive):

- **First-run approval.** A brand-new repo with no prior Actions history may show your first tagged run as "pending approval" in Settings → Actions → General. Click through it once and subsequent runs go straight through.
- **`workflow_dispatch` only appears on the default branch.** The "Run workflow" button in the GitHub Actions UI requires `release.yml` to be present on `master`. Tag-triggered runs don't have this restriction. So if you want manual-trigger as a fallback, get the workflow merged to `master` at some point.
- **Tags are not branch-scoped.** A tag is a pointer to a commit; the workflow runs against that commit's tree. You can release from a feature branch, but the audit trail (release notes, `Source: <branch>`) won't be ideal. Default to tagging from `master`.
- **Re-running a failed release.** Delete the partial release (UI), delete the tag locally and remotely (`git tag -d v0.1.0 && git push origin :refs/tags/v0.1.0`), fix, re-tag, re-push. There's no in-place "retry" because the artifacts are tied to the release.
- **Cross-compile is hostless.** Bun cross-compiles all four targets from one Linux x64 runner — no per-OS matrix runners needed. If a target ever needs native deps that don't cross-compile, that's the day this assumption breaks; `release.yml` will need a real per-OS matrix.
- **Permissions.** The workflow declares `permissions: contents: write` so the default `GITHUB_TOKEN` can create the release. No PAT needed.

---

## 11. Spec deviations

These are differences between the as-built code and `meta/distributed-poc-spec.md`. Each is paired with what to do about it (or "intentional, document and move on").

Resolved since the initial audit:
- ~~D1: `src/local/` retained~~ — **intentional**, sanctioned same-machine mode (see `meta/future-notes.log`). The grep-isolation test now excludes `src/local/**` with a comment.
- ~~D2: `bun test` fails~~ — **fixed** by the test exclusion above. `bun test` is now clean (45 pass, 6 todo, 0 fail).
- ~~D7: undeclared `zod` dependency~~ — **fixed** by adding `"zod": "^4.0.0"` to `package.json`.

| # | Deviation | Spec ref | Severity | Recommendation |
|---|---|---|---|---|
| **D3** | README is the v0 README — no mention of three entry points, login flow, or backend deploy. The `.mcp.json` snippet still points at the now-renamed `src/server.ts` (it should be `src/local/main.ts` for local mode or `src/plugin/main.ts` for distributed). | §19 (✗) | High — a new reader gets the wrong picture and a broken `.mcp.json` template. | Rewrite around the two operating modes (local via `src/local/`, distributed via `src/plugin/` + backend). |
| **D4** | Domain restriction is `GRAYBOARD_ORG_DOMAIN` (env var) instead of hardcoded `stablekernel.com`. | §3 | Low — generalization the spec didn't ask for but doesn't break anything. | Keep. Already documented here in §4. |
| **D5** | `POST /api/admin/revoke-session` ignores the `all` field — both branches call `revokeAllForUser`. CLI hardcodes `all: true` anyway. | §5.6 | Low — CLI works, but the API contract lies. | Either implement single-session revoke or drop the `all` parameter and document "revokes all." |
| **D6** | `SendContext.db` is typed `Repo`, not `Database`. | §6.1 | Low — arguably an improvement (Repo is the right level of abstraction). | Keep; the seam works. |
| **D8** | Audit retention test only asserts `pruneAudit` doesn't throw — does not verify rows are deleted. | §16 (test 8) | Low — coverage gap, not a bug. | Add the deletion assertion if cheap. |
| **D9** | Integration tests in `tests/integration/ws.test.ts` are all `test.todo` — none of the §16 required WS-flow scenarios are exercised. | §16 (tests 5, 6, 7), §19 (✗) | Accepted for POC. Building a server-spinning harness was rejected as not worth it for testing. Manual acceptance via the §16 smoke procedure is the chosen mitigation. | Revisit if/when the project productizes. |
| **D10** | Monthly VACUUM is a no-op. `retention.ts:32-37` admits this and defers to "future work." | §12 | Low at POC scale; SQLite WAL + `auto_vacuum=INCREMENTAL` will keep the file from growing unboundedly. | Expose `incremental_vacuum` through `Repo` if reclamation actually matters. |
| **D11** | `canAdmin` is defined but never called from any admin route. `http.ts:35` even builds a `SendPrincipal` for what reads as a planned call. | §6.5 | Low — v1 canAdmin returns true, so wiring it through is functionally identical. | Either wire `canAdmin` in or delete the dead `makePrincipal` helper. |
| **D12** | Plugin's MCP notification payload is `params: { content: <tagString> }` (the full `<channel …>body</channel>` rendered into a single string). v0 used `params: { content: body, meta: {…} }`. | §7 implies "same … shape used today" | Low — this is the format the live channels protocol expects; v0's `meta` object was an artifact of how that version assembled the tag. Worth confirming against current Claude Code. | Confirm via manual smoke. |
| **D13** | Logout truncates the credentials file instead of unlinking it. | §5.5 | Trivial. | Use `unlinkSync`. |
| **D14** | `cli/main.ts` writes the `--mcp` file but does not verify the parent directory exists; also accepts the boolean `--mcp` form without explicit validation. | §8.1 | Trivial — would surface as a confusing fs error. | Add an explicit existence check on `dirname(path)`. |

Items the spec *explicitly* told us to do that ARE done:

- ✅ Three entry points, one repo, one `package.json` (§1).
- ✅ Schema is `CREATE TABLE IF NOT EXISTS` in `db.ts`, run on open (§2).
- ✅ Per-identity cursors, team cursors initialized to current-max on join (§2, §9.1).
- ✅ Identity uniqueness per-user; team uniqueness global (§3).
- ✅ WS auth on upgrade via `Authorization` header (§4.1).
- ✅ Lazy identity creation on `hello`, audited with `{lazy:true}` (§4.5.1).
- ✅ One active WS per identity; supersede-and-close (§4.5.2).
- ✅ Cursors advance only on `ack` (§4.5.3, §9.2).
- ✅ Server-side OAuth code exchange with Google; client_secret never on CLI (§5.2).
- ✅ Sessions never expire; SHA-256 hashed at rest; `gbrd_v1_` prefix (§5.3).
- ✅ Logout doesn't kick live WSs (§5.5).
- ✅ Dev-auth refuses to coexist with `GOOGLE_CLIENT_SECRET` (§5.9).
- ✅ `canSend` is sync, pure, tagged-union return, `ctx` carries the seam (§6.1).
- ✅ All sends route through `canSend` — exactly two call sites in `ws.ts` (§6.3).
- ✅ Repository facade in `db.ts`; the only file in the v1 tree that imports `bun:sqlite` (§13). `src/local/` is excluded from the isolation test by design.
- ✅ Heartbeats every 30s + 75s `idleTimeout` (§4.5.4).
- ✅ 64 KiB body limit (§4.5.5).
- ✅ Nightly retention prunes for messages + audit (§12).
- ✅ Reconnect with exponential backoff in plugin; bail on `superseded` (§7.1).
- ✅ `--mcp` merge semantics + `--force` (§8.1).
- ✅ systemd unit, Caddyfile, S3 backup script all present in `deploy/` (§14).

---

## 12. Configuration

Loaded once in `server/config.ts`. Fail-fast on missing required vars.

| Var | Required | Default | Used by |
|---|---|---|---|
| `GRAYBOARD_DB_PATH` | yes | — | server |
| `GRAYBOARD_PUBLIC_URL` | yes | — | server (for absolute URLs) |
| `GRAYBOARD_HTTP_PORT` | no | `8080` | server |
| `GOOGLE_OAUTH_CLIENT_ID` | yes (unless `DEV_AUTH=1`) | — | server (token exchange) |
| `GOOGLE_OAUTH_CLIENT_SECRET` | yes (unless `DEV_AUTH=1`) | — | server (token exchange) |
| `GRAYBOARD_ORG_DOMAIN` | yes (unless `DEV_AUTH=1`) | — | server (`hd` claim check) |
| `GRAYBOARD_MESSAGE_RETENTION_DAYS` | no | `90` | server (retention job) |
| `GRAYBOARD_AUDIT_RETENTION_DAYS` | no | `90` | server (retention job) |
| `GRAYBOARD_DEV_AUTH` | no | unset | server (enables `/api/auth/dev-login`) |
| `GRAYBOARD_PLUGIN_PATH` | no | auto-detect | CLI (`identity create --mcp`) |
| `GOOGLE_OAUTH_CLIENT_ID` | yes (CLI side) | — | CLI (PKCE; client_id is public) |
| `GRAYBOARD_SERVER` | no | from credentials | CLI + plugin |
| `GRAYBOARD_CREDENTIALS` | no | `~/.grayboard/credentials` | CLI + plugin |
| `GRAYBOARD_TOKEN` | no | unset | plugin only (raw token bypass) |

---

## 13. Deploy

`deploy/grayboard.service`:
- `User=grayboard`, `WorkingDirectory=/opt/grayboard`
- `EnvironmentFile=/etc/grayboard/env` (mode `0600`)
- `ExecStart=/usr/local/bin/bun run src/server/main.ts`
- `Restart=always`, `RestartSec=3`

`deploy/Caddyfile` reverse-proxies a single host to `127.0.0.1:8080`. WS upgrade is transparent.

`deploy/backup.sh` runs `sqlite3 .backup` then `aws s3 cp` with `STANDARD_IA` storage class. **Retention is enforced via S3 lifecycle policy, not the script** — a deviation from spec §14.3 in *mechanism* (not in effect). Set up the bucket lifecycle separately.

EBS / EC2 details are documented in spec §14.4 but not codified anywhere in the repo. Hostname in the Caddyfile is a placeholder (`grayboard.example.com`).

---

## 14. Test inventory

Unit tests (run by `bun test`):

| File | Coverage |
|---|---|
| `src/shared/addressing.test.ts` | parse, format, validation, lowercase, length bounds |
| `src/server/auth.test.ts` | token mint/hash, session verify, revoked, disabled, re-enabled |
| `src/server/can_send.test.ts` | spec §6.6 contract (allow user, allow team, denied shape, sync) |
| `src/server/db.test.ts` | repo CRUD + the `bun:sqlite` isolation grep test (excludes `src/local/**` by design) |
| `src/server/retention.test.ts` | message prune; audit prune asserts only no-throw (D8) |

`bun test` currently: **45 pass, 6 todo, 0 fail**.

Integration tests in `tests/integration/ws.test.ts` are deliberate `test.todo` placeholders — building a server-spinning harness was rejected as not worth it for a POC (see D9). OAuth code-exchange tests with mocked Google JWKS (spec §16 test 3) are likewise deferred.

---

## 15. Migration path to Postgres

The repository facade in `db.ts` (`Repo` interface) is the seam. To swap SQLite for Postgres:

1. Reimplement `Repo` against `pg` or `postgres.js`.
2. Replace the `openDatabase` factory.
3. Re-encode the `CREATE TABLE` DDL for Postgres types (`AUTOINCREMENT` → `SERIAL` / `BIGSERIAL`, etc.).
4. The grep test ensures nothing else in the v1 tree imports `bun:sqlite` — so step 1 is genuinely localized. (`src/local/` would not migrate; it's the same-machine mode and stays on SQLite.)

Estimated scope per the proposal: ~one engineer-week.

---

## 16. Quick smoke procedure

Per spec §19:

```bash
# Server (one terminal)
GRAYBOARD_DEV_AUTH=1 \
GRAYBOARD_DB_PATH=/tmp/grayboard.db \
GRAYBOARD_PUBLIC_URL=http://localhost:8080 \
bun run src/server/main.ts

# CLI (another terminal)
bun src/cli/main.ts login --dev wade@example.com --server http://localhost:8080
bun src/cli/main.ts whoami
bun src/cli/main.ts identity create fe
bun src/cli/main.ts team create eng

# Plugin (a third terminal, simulating an MCP child)
GRAYBOARD_TOKEN=$(jq -r .session_token ~/.grayboard/credentials) \
GRAYBOARD_SERVER=http://localhost:8080 \
BUS_IDENTITY=fe \
bun src/plugin/main.ts
```

Then exercise via WS by hand (or implement D9's integration tests, which would do exactly this).
