# E2E regression harness

```doc-meta
owns: the design of the e2e regression harness (#158): real harness hosts, real Slack, upgrades and released binaries
invariants: `*.e2e.ts` is outside `bun test` discovery, so harness, slow and secret-bearing suites run only through `scripts/e2e.sh`; never the production Slack app; recorded Slack fixtures keep only allowlisted fields (public repo); upgrade checks derive tables from the old DB, not a hand-kept list
code-pointers: tests/integration/, tests/support/, tests/integration/fake_slack.ts, tests/integration/pi.test.ts, .github/workflows/test.yml, .github/workflows/release.yml, install.sh, src/cli/update.ts, src/cli/main.ts (setup), src/server/http.ts (healthz)
companions: boards.md §Adapters (delivery owner per harness), slack-bridge.md §9 (what's unverified against Slack), architecture.md §8 (build and deploy)
trigger: PRs 0–3 (enablers, shared test support, upgrade tier, harness tier) are buildable now; the real-Slack tier waits on a test workspace, and Claude Code wake tests may wait on an Anthropic credential (Owner decisions)
last-verified: 2026-10-23
```

## Problem

The test suite exercises grayboard's own processes for real: `tests/integration/` starts in-process servers, `grayboard mcp` children over stdio, real WebSockets, and one real harness (pi, in `pi.test.ts`, against a fake model). Everything around those processes is assumed, and the assumptions have been wrong:

- **Harness hosts.** Claude Code, omp and OpenCode never run in a test; Claude Code exists only as a symlink named `claude` (a fake host in `local.test.ts`). The omp and OpenCode adapters aren't even typechecked (#91). Their wake paths, spawn-failure handling (#83) and cleanup are untested, and #141 (OpenCode V2) asks for a CI-exercised adapter that nothing can host yet.
- **Slack.** All Slack traffic goes to `tests/integration/fake_slack.ts`, which encodes our reading of Slack's docs. The 2026-10-23 probe (PR #135) found two of those readings wrong (`username` on `files.completeUploadExternal` is ignored; a repeat completion is idempotent), and Slack's own method page still documents the first one.
- **Upgrades and deploys.** No test opens a database written by a previous release (the only legacy case is hand-written SQL in `local.test.ts`), though AGENTS.md makes additive schema a load-bearing rule. No test runs `install.sh`, `grayboard update`, `grayboard setup` or `refresh-adapters`, or the compiled binaries that ship (`release.yml` builds after testing and never executes them). The 1.10.0 deploy left the old server process running because `install.sh` doesn't restart the service, and nothing could tell (#155).

## Goal

A regression harness that runs the real things a user runs (harness hosts, Slack, released binaries, installers) around grayboard, deterministic wherever a fake doesn't hide the behaviour under test, so designs can be checked against behaviour rather than our reading of docs.

## Design

### Layout and tiers

Suites split by cost, determinism and secrets. Measured baseline (2026-10-23): `bun test` 47.8 s locally (328 tests, 24 files); the CI test job 70–75 s. Per-push budget: `bun test` (and so the pre-push hook) grows by at most 15 s; each new per-push CI job finishes within 5 min and runs in parallel with the test job. A suite that P5 measures over its budget moves to nightly.

| Tier | Where | Runs | Needs |
|---|---|---|---|
| Harness | `tests/e2e/harness/*.e2e.ts` | every push and PR, as its own parallel CI job (`test.yml` job `harness`); not in `bun test` or the pre-push hook, so dev machines never install harness CLIs | harness CLIs at pinned versions, cached; fake model; no secrets |
| Upgrade (latest previous release) | `tests/integration/upgrade.test.ts` | every push (`bun test`) | previous release's binaries for the runner's platform, downloaded once and cached |
| Upgrade (all v1.x) | `tests/e2e/upgrade_matrix.e2e.ts` | nightly, `workflow_dispatch`, required before a release tag | release downloads |
| Real Slack | `tests/e2e/slack_real.e2e.ts` | nightly, `workflow_dispatch`, required before a release tag | test workspace secrets |
| Released binaries | `tests/e2e/binaries.e2e.ts` | in `release.yml`, between build and publish | the build job's artifacts |
| Claude Code push | `tests/e2e/claude_push.e2e.ts` | nightly, `workflow_dispatch` (if the probe shows it needs a real credential) | Anthropic credential |

`*.e2e.ts` doesn't match `bun test`'s discovery pattern (checked on Bun 1.4.2: a directory run skips it; `bun test ./tests/e2e/x.e2e.ts` runs it), so harness, secret-bearing and slow suites never run by accident and need no skip flags. The harness CLIs are therefore not devDependencies; `scripts/e2e.sh` installs the pinned versions into a cache dir (`.e2e-cache/`, gitignored) on first use, and pi moves there from `devDependencies` with `pi.test.ts`. `scripts/e2e.sh <suite>` is the one entry point CI and humans use. A new workflow `.github/workflows/e2e.yml` runs the e2e suites on `schedule`, `workflow_dispatch` and `workflow_call` (from `release.yml`), with `concurrency: e2e-slack` so runs sharing the Slack workspace serialize; fork PRs never get its secrets.

### Shared test infrastructure (first, an enabler)

Every integration file today defines its own `call()`, `until()`, env isolation and MCP client (`local.test.ts`, `plugin.test.ts`, `slack.test.ts`, `pi.test.ts`). Before any new tier:

- Duplicated today, all moving: `local.test.ts` (`busEnv`, `start`, `startCollecting`, `cli`, `gb`, `exitOf`), `plugin.test.ts` (`session`, `login`), `ws.test.ts` (`config`, `login`, `api`, `upload`, `Client`), `slack.test.ts` (`agent`, `until`), `slack_org.test.ts` (`serve`, `session`, `until`, `login`, `api`), `pi.test.ts` (`busEnv`, `until`, `startModel`, `sse`).
- `tests/support/` holds: `localEnv()` / `serverEnv()` / `cleanEnv()` (scrub every inherited `BUS_*`, `GRAYBOARD_*` and `SLACK_*` variable by prefix, plus `CLAUDE_CONFIG_DIR`, `XDG_CONFIG_HOME` and `PI_CODING_AGENT_DIR`; every session, local or server, gets a temp HOME under its temp dir, not the dir itself, so a session whose cwd is the temp dir can still attach from it), `until()` (condition polling with a deadline and a message naming what it waited for; replaces new fixed sleeps, #94), `mcpSession()` / `localSession()`, the MCP stdio client with channel-notification capture and the child's stderr (appended to a failed start or call's error) (`{content, meta}`, dropping pre-`initialized` notifications as Claude Code does; `via` runs the CLI under a launcher such as the fake `claude` host), `call()`, `runCli()` (one CLI run, as a lane's shell runs it, killed at a deadline), `TestServer` (in-process server owning a temp dir, with dev-auth `login`, `api`, `upload`, server-mode `session()`s whose files live in that dir, and raw WebSocket clients from `ws_client.ts`), and `paths.ts`. Existing tests move onto it in the same change; the per-file copies are deleted. A port-0 helper waits for its first consumer (no dead code): the servers in PR 1 take port 0 through `Bun.serve` directly.
- `tests/support/fake_model.ts`: one scriptable fake LLM. PR 1 serves OpenAI chat-completions streaming (pi, omp, OpenCode); the Anthropic Messages side (Claude Code) lands with the Claude Code harness PR, after P1 measures which routes Claude Code calls, so it implements only those. A script is a list of rules (`onChannelDm(from, reply)` → a tool call or text), and every request is recorded (method, path, body; a route the fake doesn't serve gets a 404 and lands in `unhandled`) so a test asserts on what the harness sent (system prompt carries grayboard's instructions, the `<channel>` text arrived once, the tool list). `pi.test.ts`'s `startModel` moves here.

### Harness tier

Each supported harness gets one test file built on the same scenario set, so harnesses can be compared line for line:

1. **Load:** grayboard's MCP entry and adapter as `grayboard setup` writes them (run `setup -y` into the temp HOME with the harness binary on PATH, rather than hand-writing the config as `pi.test.ts` does), and the system prompt carries the instructions.
2. **Wake:** a DM from a peer starts exactly one model turn; the fake model replies with `dm_send(parent_id=…)`; the peer sees the threaded reply.
3. **No wake:** a digest notice and a non-mention board post don't start a turn.
4. **Exactly once:** each message reaches the model once across a reconnect of the push child.
5. **Single delivery owner:** exactly one push-mode `grayboard mcp` per session (AGENTS.md gotcha); the tools-only entry runs `BUS_PUSH=off`.
6. **Failure is visible:** killing the push child surfaces an error where that harness shows one, and the next message still arrives after restart (#83's case). Where per harness: pi and omp, an RPC event or stderr line naming grayboard; OpenCode, its server log and a session-visible message; Claude Code, the MCP server's failed status in stream-json. Each harness's test file states its observable; a harness with none gets an issue rather than an unasserted scenario.
7. **Cleanup:** ending the harness session takes the handle offline and leaves no grayboard child running (checked by pid).
8. **Attachments:** a DM with a PNG reaches the model with its attachment meta; `attachment_get` saves it.

Per harness:

- **pi:** `pi.test.ts` becomes `tests/e2e/harness/pi.e2e.ts` on the shared support and scenario set; version bumped to the latest release at the time (looked up live).
- **omp:** `omp --mode rpc --no-session` with `models.yml` pointing at the fake model and the adapter installed by `setup`. Closes the omp half of #91.
- **OpenCode V1:** `opencode serve` on a free port in an isolated HOME, sessions created over its HTTP API, a provider using `@ai-sdk/openai-compatible` with `baseURL` at the fake model. Closes the OpenCode half of #91.

Package names, versions, engine requirements (omp's research reading was Bun ≥ 1.3.14), install size and whether each CLI runs offline after install are P2/P3/P5 items, looked up in the live registry at implementation, not taken from this spec.
- **OpenCode V2:** the same scenarios with `opencode run --standalone` / `serve` and an isolated HOME (V2's shared background service otherwise leaks between tests). Lands with #141; this spec gives #141 its test bed, and its acceptance item "exercise the installed V2 adapter in CI" is this file.
- **Claude Code:** two parts.
  - Per push: `claude -p --input-format stream-json --output-format stream-json --strict-mcp-config --mcp-config <entry> --no-session-persistence`, with `ANTHROPIC_BASE_URL` at the fake model (Anthropic format) and a dummy key. `setup` registers Claude Code with `claude mcp add --scope user` (`src/cli/main.ts:494-500`), so `<entry>` is read back from the temp HOME's `~/.claude.json` after `setup` runs against the real `claude`, which also tests the registration. The fake implements only the routes P1 shows Claude Code calls; it logs and 404s every other route, so a missing route reads as a fake gap, not a grayboard bug. Asserts load, tool calls round-trip, `alwaysLoad` tools are present without ToolSearch, and the "channels off" warning and tools-only behaviour (docs: channels don't register under `-p`).
  - Push and wake: Claude Code registers channels only in interactive sessions, so the wake scenarios drive `claude --dangerously-load-development-channels server:grayboard` under a PTY. Whether that works against the fake model (no real credential) is probe P1; if it does, it runs per push; if channels need a real claude.ai or Console credential, it's `claude_push.e2e.ts`, nightly, on the cheapest model, asserting on stream-json tool-use events and hook events rather than model text.

Harness binaries are pinned exact versions (devDependencies where npm-published; otherwise downloaded by version in CI with checksum) and cached in CI. A scheduled job (`e2e.yml`, weekly) runs the harness tier against each harness's latest release and opens an issue on failure, so upstream breaks show up before users report them.

### Real-Slack tier

- **Workspace:** one long-lived Slack test workspace, separate from any real one, with two apps created from `deploy/slack-manifest.yaml` and `deploy/slack-org-manifest.yaml` plus test-only user scopes (`chat:write`, `files:write`, `files:read`, and `groups:history` / `im:history`), token rotation off. Never the production app: Socket Mode spreads one app's events across its connections, so a test connection would steal production events. The test user is the bridges' configured owner (inbound accepts only the owner). The xoxp user token is obtained once by installing as that user and stored as a secret with the bot and app tokens. Setup steps go in `tests/e2e/README.md`.
- **Scenarios**, each for the local and the org bridge: outbound DM → thread; reply in thread → bus; board mention → thread; file outbound (single, multiple, refused type); file inbound (posted by the user token as the human); repeat completion; `#announce`; bridge restart resuming the outbox.
- **Assertions** read Slack, not our logs: `conversations.history` / `conversations.replies` (rendered `username`, `bot_id`, `files[]`, `thread_ts`) and `files.info` shares; inbound asserted on the bus. Reads are batched: one `history` per channel at the end of the suite, plus `replies` per thread, filtered by run-id marker. Slack's 2025 rate cut on these methods applies to commercially distributed non-Marketplace apps, and its changelog exempts internal apps; P4 measures the tier on the test app, and the suite's read plan fits it.
- **Cleanup:** every message carries a run-id marker; `finally` deletes bot posts with the bot token and the human's with the user token, and each run first sweeps markers older than a day. Files likewise (probe P4 settles which token can delete a user's file).
- **Keeping the fake honest (contract fixtures):** the bridges already take `SLACK_API_URL` (`src/bridge/config.ts:60`, `src/server/config.ts:100`). The real-Slack run points it at a recording proxy that forwards to `https://slack.com/api/` and records request/response pairs. Recordings keep only the fields the bridges read, each with its type and, for an enumerated few (`ok`, `error`, `subtype`, `username` presence, `files[].mode`, share keys), its value; every other key and value is dropped. That allowlist is the public-repo guard (no workspace, team, user or channel ids, names, hosts or permalinks reach `tests/fixtures/slack/`), and it also keeps Slack's unrelated new fields from failing the comparison. The read set is derived in the test from the bridge code's field accesses, listed in one module the bridges import (`src/bridge/slack_fields.ts`), not maintained by hand separately. A per-push test (`tests/integration/slack_contract.test.ts`) runs the same scenarios against `FakeSlack` and compares those fields and the effects (message count, rendered `username`, share count) to the fixtures. A nightly diff fails the run, attaches the new recording and diff as artifacts, and opens or comments on the tracking issue; a person lands the updated fixtures and the `FakeSlack` fix in one PR (CI never commits). `FakeSlack` gains what the scenarios need (`conversations.history`/`replies`, 429 with `Retry-After`).

### Upgrade tier

- **Database compatibility.** Support floor: v1.0.0 (the first release with today's module layout and `GRAYBOARD_DEV_AUTH`); stated in AGENTS.md. For a previous release: download its CLI and server binaries, start the old server with dev auth and a temp DB, write data through every public write path the release has (boards, posts, threads, mutes, claims, watches, DMs with `pending`, acks, attachments where it has them), and the same for local mode and the local Slack bridge's store in a temp HOME. Then open each DB with HEAD and assert: (a) the schema check, which is the real guard: the table list comes from the old DB's `sqlite_master` (not a hand-kept list), every table and column in it still exists, and `PRAGMA table_info` of the upgraded DB equals a fresh HEAD DB's column for column (catches a missing guarded `ALTER`); (b) what was written reads back through HEAD's tools. The test opens the SQLite files directly; the `bun:sqlite` isolation check (`src/server/db.test.ts:19`) covers `src/` only, so a `tests/` file may. Per push: the latest previous release. Nightly and pre-release: every v1.x tag.
- **Installers.** In a temp HOME with stub `claude`/`omp`/`opencode`/`pi` on PATH (stubs record their argv): `install.sh` with `GRAYBOARD_VERSION=<previous>` and `INSTALL_DIR`; `grayboard setup -y --local` and `--server`, asserting every file and registration it writes (MCP entries, SessionStart hook, adapters, credentials mode 600, logout truncating rather than deleting); `grayboard update` from the previous release to the build under test, served by a local release server. Today `GRAYBOARD_REPO` only substitutes `owner/repo` into hard-coded `api.github.com` and `github.com` URLs (`src/cli/update.ts:4,26,34`, `install.sh:22,50-52`), so this tier adds `GRAYBOARD_RELEASES_URL`, one origin that replaces both hosts and serves GitHub's paths; the local server (`tests/support/release_server.ts`) answers `/repos/<repo>/releases/latest`, `/<repo>/releases/latest` (the redirect `install.sh` resolves) and `/<repo>/releases/download/<tag>/<asset>` with real binaries, and the test checks `refresh-adapters` (symlinked adapters skipped). The build under test is this tree compiled by `tests/support/build.ts` (~0.1 s). `update` runs the old binary's code, and no release up to v1.10.0 honours the override, so until the previous release is newer than v1.10.0 the updater is this tree compiled with its version set to 0.0.0; after that the real previous release runs it. Covers #89, #95 and #85 as regression tests once they're fixed.
- **Released binaries.** `release.yml` runs `binaries.e2e.ts` between build and publish against the linux-x64 artifacts (and darwin-arm64 on a macOS runner): `--version` equals the tag, then the pi harness scenario and one server round trip with the compiled CLI and server instead of source.
- **Deploy smoke.** #155 shipped the server version in `/healthz` and `--version`, and `install.sh` now restarts a running `grayboard` service and verifies the restart itself: it polls `/healthz` until the new version answers and fails otherwise (#160, `tests/integration/install.test.ts`). This tier adds `scripts/deploy_check.sh <url> <tag>` for checking a live server from outside the host: it fails unless the server reports the tag. The README's server upgrade steps end with it.

Not in scope: systemd and Caddy in a container (TLS and the reverse proxy are Caddy's; a privileged systemd container buys little over the installer and binary checks above). `systemd-analyze verify deploy/grayboard.service` runs in CI as a lint; the `/etc/grayboard/env` contract is covered only by that lint and the binaries suite starting the server from an env file of the same shape. Google OAuth against Google (dev auth only); load and soak testing.

### Probes before implementation (enablers first)

Each is a measured run recorded on this issue; the design above changes if one fails.

- **P1 Claude Code:** (a) `-p` against a fake Anthropic server that logs and 404s every route: which routes does Claude Code need? (b) interactive dev-channels session under a PTY, dialogs accepted by keystroke, with the fake and a dummy key, then with a real credential: does a push start a turn? Decides whether the wake scenarios run per push or nightly, and which credential (#157).
- **P2 OpenCode V1:** package name, latest version, engines, install size; is `@ai-sdk/openai-compatible` bundled or fetched at runtime (CI network); do the plugin's `config`/`event`/`dispose` run under `serve`; does `promptAsync` wake an HTTP-created session; does `dispose` kill the child on SIGTERM?
- **P3 omp:** package name, latest version, engines, install size, offline after install; RPC mode with the adapter and fake model: does `mcp_notification` fire and `triggerTurn` start a model call?
- **P4 Slack:** event shape and timing of a user-token file upload (the live `message.im`/`message.groups` event, still unmeasured per `docs/slack-bridge.md` §9); whether the bot can delete a user's file; whether app-level tokens expire; `getUploadURLExternal`'s rate tier.
- **P4 also:** `conversations.history`/`replies` rate tier on the test app.
- **P5 cost:** install time and size for each harness on the Linux runner (cold and cached), per-scenario wall time, and the upgrade test's download and run time, checked against the budget under *Layout and tiers*.

### Sequencing

1. **PR 0 (enablers):** #156 (pin Bun in CI) and #155 (server version, installer restart). The binaries suite and deploy check assert on #155; harness pins are meaningless on an unpinned Bun.
2. **PR 1:** `tests/support/` and `fake_model.ts`; existing tests move onto them with no behaviour change.
3. **PR 2:** upgrade tier (DB compatibility, installers with `GRAYBOARD_RELEASES_URL`, binaries suite in `release.yml`, deploy check). Deterministic, no new dependencies, and it guards the additive-schema rule.
4. **P5, P3, P2** run before PR 3; **P1** runs in parallel with PRs 1–2.
5. **PR 3:** harness tier, one harness per PR: pi (already runs), omp, OpenCode V1, Claude Code. OpenCode V2 lands with #141.
6. **P4** before **PR 4:** real-Slack tier and contract fixtures.
7. **PR 5:** weekly latest-harness job.

### Observability

Every e2e run writes a run directory (harness stdout/stderr, grayboard child logs, fake-model request log, Slack recording, DB snapshots), uploaded as a CI artifact on every run with 7-day retention, so a flaky pass and a nightly comparison keep their evidence. A failure message names the scenario, the harness and its version. Nightly failures open (or comment on) one tracking issue per suite rather than failing silently in the Actions tab.

## Acceptance

- `tests/support/` exists, every integration test uses it, and per-file helper copies are gone.
- Harness tier: pi, omp, OpenCode V1 and Claude Code (`-p` part) pass the scenario set per push in CI; Claude Code wake per P1's outcome; OpenCode V2 slot ready for #141.
- Real-Slack suite passes nightly against the test workspace for both bridges, cleans up after itself, and its recordings back a per-push contract test of `FakeSlack`.
- Upgrade tier: per-push latest-previous-release DB test and installer tests; nightly v1.x matrix; `release.yml` runs the binaries suite before publishing; deploy check script using #155.
- Weekly latest-harness job and nightly failure issues work (each shown failing once on purpose).
- Per-push budget met, shown by CI timings.
- Docs: AGENTS.md (commands, the `.e2e.ts` convention, which suites the pre-push hook runs, the v1.0.0 support floor), `tests/e2e/README.md` (Slack workspace and credentials setup).

## Owner decisions

- **Slack test workspace:** recommend a new free workspace the maintainer owns, used only for this (the principles settle only "not the production app"). A Slack developer sandbox expires after 1 month (6 with a card) and must be re-provisioned by hand.
- **Anthropic credential for Claude Code wake runs** (if P1 shows the fake can't drive channels): recommend a Console API key with a spend cap, nightly only, cheapest model. Also confirms #157.
- **Weekly latest-harness job:** recommend it opens one issue per harness and comments on it while still failing, rather than one issue per run.

## Relations

#91, #83, #141 (harness coverage), #94 (sleeps), #155 (server version), #156 (pinned Bun), #157 (channels auth), #89, #95, #85 (installer bugs that gain regression tests), #138, #152 (Slack ordering and inbound durability; testable against real Slack once this exists).
