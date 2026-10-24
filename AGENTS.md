# grayboard — agent instructions

Durable coordination bus for coding agents (boards, claims, DMs) across harnesses. Bun + TypeScript, SQLite. Two modes behind one tool surface: local (same machine, Unix-socket wakeup) and distributed (central server, WSS). Design docs: `docs/`, governed by [`docs/CONTRACT.md`](docs/CONTRACT.md) — read it before editing any doc.

## Commands

- Install deps: `bun install`
- Typecheck: `bun run typecheck` (covers `src/` and `adapters/pi/` only; see gotchas)
- Test: `bun test` (whole suite; `tests/integration/` starts real servers and MCP children). One file: `bun test <path>`.
- Test helpers live in `tests/support/`: `until()` (poll a condition; no fixed sleeps), `localSession()`/`mcpSession()` (a `grayboard mcp` child in an isolated env), `TestServer` (in-process server; `srv.session()` for server-mode children), `ServerProcess` (a compiled server as its own process), `runCli()` (kills its process group on timeout), `releaseBinaries()` (a release's binaries, digest-checked and cached in `.e2e-cache/`), `ReleaseServer` (a stand-in releases origin for `update`/`install.sh`), `buildCli()` (this tree compiled, optionally under another version), `piScenario()` (a real pi session woken through the bus), `keep()` (copy evidence into the e2e run dir; a no-op under plain `bun test`). Use them rather than a per-file copy.
- E2E suites: `scripts/e2e.sh <suite>` (suites: its usage line), the one entry point for CI and by hand. Files named `*.e2e.ts` (`tests/e2e/`) are outside `bun test`'s discovery, so neither `bun test` nor the pre-push hook runs them. Each run writes a run dir (`.e2e-runs/`, gitignored; CI uploads it for 7 days). `.github/workflows/e2e.yml` runs the nightly suites and is called by `release.yml`; a nightly failure opens or comments on a "Nightly e2e failing: <suite>" issue.
- Build binaries: `bun run build` → `dist/grayboard`, `dist/grayboard-server`
- Run from source: `bun src/cli/main.ts <cmd>`; server: `bun src/server/main.ts`
- Manual distributed smoke: `GRAYBOARD_DEV_AUTH=1 GRAYBOARD_DB_PATH=/tmp/gb.db GRAYBOARD_PUBLIC_URL=http://localhost:8080 bun src/server/main.ts`, then `bun src/cli/main.ts login --dev you@example.com --server http://localhost:8080`, then `BUS_IDENTITY=fe bun src/cli/main.ts mcp --mode server`. `tests/integration/ws.test.ts` covers the same path over real WebSockets.

## Git hooks

Install once per clone: `git config core.hooksPath scripts/hooks`. `scripts/hooks/pre-push` runs:

1. Per pushed ref, the docs gate (`scripts/docs_gate.sh <sha>`): refuses a push whose commits since the `docs-baseline` tag change anything other than docs (`docs/`, any `*.md`), tests (`tests/`, `*.test.ts`), `scripts/`, `assets/` and `.claude/`, until the docs are reconciled. Bypass for deliberate WIP: `DOCS_GATE_BYPASS=1 git push …`, and tell the user. Inert until the tag exists; fails open on its own errors.
2. Once: `bun run typecheck`, then `bun test`.

`docs-baseline` is a local tag (never pushed); a fresh clone's gate is inert until its first reconcile. Reconcile: follow `.claude/commands/reconcile-docs.md` (Claude Code: `/reconcile-docs`). The tag moves only through `scripts/advance_docs_baseline.sh`. CI (`.github/workflows/test.yml`) is the universal gate; the hook is local protection.

## Contributions

- Commit and PR subjects carry the issue key; conventional prefixes (`feat:`, `fix:`, `chore:`…) on commits and PR titles.
- Issues and PRs open with the concise front — the problem, the value of solving it, the proposed solution — 2–5 bullets each; verbose detail after, for agents. Templates live in `.github/`; the filer applies the surface label (server, local, core, cli, adapters, bridge, ci).
- Reviews block on medium-and-up findings; file lower ones as `follow-up` issues rather than chasing them in review rounds. A PR merges when each in-scope item is fixed or deferred to a filed issue.

## Load-bearing gotchas

- **Public repo.** Don't name employers, clients or private projects (repos, ticket prefixes, people) in committed files. Use stand-ins: `ticket:ENG-142`, `#e2e`, `be`/`fe`/`sim`, `you@example.com`. Grep the staged diff before every commit.
- **Bugs and feature requests are GitHub issues** (`gh issue create`), not doc sections or TODO lists.
- **Two modes, one tool surface.** Board, claim and peer tools are defined once in `src/core/tools.ts`. DM tools are implemented twice: `src/local/mcp.ts` and `src/plugin/mcp.ts` (+ `src/server/ws.ts`). Change both modes or the surfaces drift.
- **Every instruction sentence costs every session.** MCP instruction text (`src/core/tools.ts`, `src/shared/inbox.ts`, `src/local/mcp.ts`, `src/plugin/mcp.ts`) is paid in tokens by every agent on every start. Add a sentence only when it's conditional on state that makes it relevant (human handles, team membership, notices).
- **Exactly one delivery owner per handle.** A harness that drops MCP notifications must run its MCP entry with `BUS_PUSH=off`, and its adapter runs the one push-mode `grayboard mcp`. A push-mode server whose notifications go nowhere consumes messages into a void. See `docs/boards.md` §Adapters.
- **`bun:sqlite` isolation.** `src/server/db.test.ts` fails if anything outside `src/server/db.ts`, `src/core/`, `src/local/`, `src/bridge/` imports `bun:sqlite`. That keeps the server's `Repo` facade the Postgres seam. Server data goes through `Repo`.
- **The human handle is a declaration (`grayboard human`), not a session flag.** `BUS_HUMAN=1` only asserts it; `src/local/mcp.ts` refuses a session where the two disagree. Don't make anything an agent can reach set `handles.human` or start `#announce` posts: that board's authority depends on it. See `docs/slack-bridge.md` §3. On a server the name `human` is reserved for the Slack bridge's in-process connections (`src/server/ws.ts` hello); don't open a client path to it (§8).
- **Logout truncates the credentials file; it must not delete it.** `busMode()` (`src/cli/api.ts`) picks server mode when the file exists, so an empty file makes `grayboard mcp` fail with "signed out" instead of silently switching the user to local mode.
- **Upgrade support floor: v1.0.0.** Every database a v1.0.0-or-later release wrote must open under HEAD. `tests/integration/upgrade.test.ts` checks the latest release per push, and `scripts/e2e.sh upgrade-matrix` checks every v1.x release. So `bun test` (and the pre-push hook) needs network: the upgrade tests list releases from the GitHub API on every run and download a release's binaries once (cached in `.e2e-cache/`). Set `GITHUB_TOKEN` if you hit the API's anonymous rate limit; `GRAYBOARD_UPGRADE_FROM=<tag>` picks the release.
- **Schema changes are additive.** No migration tool: every open runs `CREATE TABLE IF NOT EXISTS` (`src/server/db.ts`, `src/core/schema.ts`, `src/local/open.ts`); new columns go in as a guarded `ALTER TABLE … ADD COLUMN` (pattern in `src/core/schema.ts`). Deployed databases must open under the new code.
- **omp and opencode adapters are outside `tsconfig.json`** (they import harness-only types). `bun run typecheck` doesn't see them; typecheck in a scratch dir against the harness's own `node_modules`, or test in the harness.
- **`tests/integration/pi.test.ts` runs the real pi CLI** (pinned devDependency) and needs Node ≥ 22.19 on PATH.
- **Markdown is soft-wrapped**: one line per paragraph or bullet.

## Releasing

Releases are cut from `master` by tag. Assets and targets come from `.github/workflows/release.yml` (CLI and server binaries per target, plus `install.sh`); read it rather than trusting a count here.

1. Bump `version` in `package.json` on the release branch and merge to `master`. The workflow's first job refuses a tag that isn't `v<package.json version>`, because `grayboard update` checks that the downloaded binary reports the tag's version. So a pre-release tag (`v1.3.0-rc1`) needs the matching pre-release version.
2. `git tag vX.Y.Z && git push origin vX.Y.Z`. The workflow runs test → cross-compile (Linux runners, every target) → the binaries suite per target it runs on, while the upgrade matrix (`e2e.yml`) runs from the start → publish to a GitHub Release with generated notes, once all of them pass. Any failure before publish leaves no release.
3. Verify: `gh release view vX.Y.Z` lists every asset; `grayboard update` locally, then `grayboard --version`; after updating a server, `scripts/deploy_check.sh <server url> vX.Y.Z`.
4. A failed release has no in-place retry: delete the release (UI or `gh release delete`), delete the tag locally and remotely (`git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z`), fix, re-tag.

`workflow_dispatch` (manual run) only exists for the copy of `release.yml` on the default branch. A release that changes server behavior needs the server updated too (README §Updating the server).
