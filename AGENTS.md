# grayboard — agent instructions

Durable coordination bus for coding agents (boards, claims, DMs) across harnesses. Bun + TypeScript, SQLite. Two modes behind one tool surface: local (same machine, Unix-socket wakeup) and distributed (central server, WSS). Design docs: `docs/`, governed by [`docs/CONTRACT.md`](docs/CONTRACT.md) — read it before editing any doc.

## Commands

- Install deps: `bun install`
- Typecheck: `bun run typecheck` (covers `src/` and `adapters/pi/` only; see gotchas)
- Test: `bun test` (whole suite; `tests/integration/` starts real servers and MCP children). One file: `bun test <path>`.
- Build binaries: `bun run build` → `dist/grayboard`, `dist/grayboard-server`
- Run from source: `bun src/cli/main.ts <cmd>`; server: `bun src/server/main.ts`
- Manual distributed smoke: `GRAYBOARD_DEV_AUTH=1 GRAYBOARD_DB_PATH=/tmp/gb.db GRAYBOARD_PUBLIC_URL=http://localhost:8080 bun src/server/main.ts`, then `bun src/cli/main.ts login --dev you@example.com --server http://localhost:8080`, then `BUS_IDENTITY=fe bun src/cli/main.ts mcp --mode server`. `tests/integration/ws.test.ts` covers the same path over real WebSockets.

## Git hooks

Install once per clone: `git config core.hooksPath scripts/hooks`. `scripts/hooks/pre-push` runs:

1. Per pushed ref, the docs gate (`scripts/docs_gate.sh <sha>`): refuses a push whose commits since the `docs-baseline` tag change anything other than docs (`docs/`, any `*.md`), tests (`tests/`, `*.test.ts`), `scripts/`, `assets/` and `.claude/`, until the docs are reconciled. Bypass for deliberate WIP: `DOCS_GATE_BYPASS=1 git push …`, and tell the user. Inert until the tag exists; fails open on its own errors.
2. Once: `bun run typecheck`, then `bun test`.

`docs-baseline` is a local tag (never pushed); a fresh clone's gate is inert until its first reconcile. Reconcile: follow `.claude/commands/reconcile-docs.md` (Claude Code: `/reconcile-docs`). The tag moves only through `scripts/advance_docs_baseline.sh`. CI (`.github/workflows/test.yml`) is the universal gate; the hook is local protection.

## Load-bearing gotchas

- **Public repo.** Don't name employers, clients or private projects (repos, ticket prefixes, people) in committed files. Use stand-ins: `ticket:ENG-142`, `#e2e`, `be`/`fe`/`sim`, `you@example.com`. Grep the staged diff before every commit.
- **Bugs and feature requests are GitHub issues** (`gh issue create`), not doc sections or TODO lists.
- **Two modes, one tool surface.** Board, claim and peer tools are defined once in `src/core/tools.ts`. DM tools are implemented twice: `src/local/mcp.ts` and `src/plugin/mcp.ts` (+ `src/server/ws.ts`). Change both modes or the surfaces drift.
- **Every instruction sentence costs every session.** MCP instruction text (`src/core/tools.ts`, `src/shared/inbox.ts`, `src/local/mcp.ts`, `src/plugin/mcp.ts`) is paid in tokens by every agent on every start. Add a sentence only when it's conditional on state that makes it relevant (human handles, team membership, notices).
- **Delivery roles: one push owner per identity, rotating.** A harness that drops MCP notifications must run its MCP entry with `BUS_PUSH=off`, and its adapter runs the one push-mode `grayboard m`. A second push-capable session of the identity joins as a tools-only lane (first in line when the owner ends) instead of being refused. A push-mode server whose notifications go nowhere consumes messages into a void. See `docs/boards.md` §Adapters.
- **`bun:sqlite` isolation.** `src/server/db.test.ts` fails if anything outside `src/server/db.ts`, `src/core/`, `src/local/`, `src/bridge/` imports `bun:sqlite`. That keeps the server's `Repo` facade the Postgres seam. Server data goes through `Repo`.
- **The human handle is a declaration (`grayboard human`), not a session flag.** `BUS_HUMAN=1` only asserts it; `src/local/mcp.ts` refuses a session where the two disagree. Don't make anything an agent can reach set `handles.human` or start `#announce` posts: that board's authority depends on it. See `docs/slack-bridge.md` §3. On a server the name `human` is reserved for the Slack bridge's in-process connections (`src/server/ws.ts` hello); don't open a client path to it (§8).
- **Logout truncates the credentials file; it must not delete it.** `busMode()` (`src/cli/api.ts`) picks server mode when the file exists, so an empty file makes `grayboard mcp` fail with "signed out" instead of silently switching the user to local mode.
- **Schema changes are additive.** No migration tool: every open runs `CREATE TABLE IF NOT EXISTS` (`src/server/db.ts`, `src/core/schema.ts`, `src/local/open.ts`); new columns go in as a guarded `ALTER TABLE … ADD COLUMN` (pattern in `src/core/schema.ts`). Deployed databases must open under the new code.
- **omp and opencode adapters are outside `tsconfig.json`** (they import harness-only types). `bun run typecheck` doesn't see them; typecheck in a scratch dir against the harness's own `node_modules`, or test in the harness.
- **`tests/integration/pi.test.ts` runs the real pi CLI** (pinned devDependency) and needs Node ≥ 22.19 on PATH.
- **Markdown is soft-wrapped**: one line per paragraph or bullet.

## Releasing

Releases are cut from `master` by tag. Assets and targets come from `.github/workflows/release.yml` (CLI and server binaries per target, plus `install.sh`); read it rather than trusting a count here.

1. Bump `version` in `package.json` on the release branch and merge to `master`. The workflow's first job refuses a tag that isn't `v<package.json version>`, because `grayboard update` checks that the downloaded binary reports the tag's version. So a pre-release tag (`v1.3.0-rc1`) needs the matching pre-release version.
2. `git tag vX.Y.Z && git push origin vX.Y.Z`. The workflow runs test → cross-compile (Linux runners, every target) → publish to a GitHub Release with generated notes.
3. Verify: `gh release view vX.Y.Z` lists every asset; `grayboard update` locally, then `grayboard --version`.
4. A failed release has no in-place retry: delete the release (UI or `gh release delete`), delete the tag locally and remotely (`git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z`), fix, re-tag.

`workflow_dispatch` (manual run) only exists for the copy of `release.yml` on the default branch. A release that changes server behavior needs the server updated too (README §Updating the server).
