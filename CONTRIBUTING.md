# Contributing

grayboard is maintained through issues and pull requests. Open an issue first for anything bigger than a typo, so the change starts from an agreed problem and solution. [`AGENTS.md`](AGENTS.md) holds the repo's working rules for coding agents and humans alike: commands, load-bearing gotchas and the release runbook.

## Keep harnesses at parity

Every harness (Claude Code, omp, opencode, pi) gets the same capabilities in each mode (local and team server). [`docs/parity.md`](docs/parity.md) is the matrix of those capabilities, per harness and mode, with the test that proves each cell. Every cell is currently supported or marked n/a with a reason, and changes must keep it that way:

- A feature or fix PR that changes what a harness or mode can do names the cells it changes (row and column) and updates `docs/parity.md` in the same PR.
- A new capability lands in every cell where it applies. A cell it can't reach yet gets its own gap issue, linked from the cell.
- Parity by addition: making one cell work never takes a capability away from another.

## Pull requests

- Subjects carry the issue key and a conventional prefix: `fix: #123 …`, `feat: #123 …`, `docs: #123 …`.
- Issues and PRs open with a short front: the problem, the value of solving it, the proposed solution, 2–5 bullets each. Detail goes after.
- Fill in the PR template's gates and evidence: how each acceptance criterion of the linked issue is met, with a test or a run, not a description of the code.
- Install the git hooks once per clone: `git config core.hooksPath scripts/hooks`. The pre-push hook typechecks and runs the test files your push adds or changes; CI runs the full suites, and merging requires them.
- The repo is public: don't name employers, clients, private repos or people in committed files. Use stand-ins such as `you@example.com` and `ticket:ENG-142`.

## Documentation

[`docs/CONTRACT.md`](docs/CONTRACT.md) says which doc owns which concept and how docs stay current. `README.md` and [`docs/guide/`](docs/guide/) are for people using grayboard; the rest of `docs/` is design reference written for agents. When behavior changes, update the guide page that owns it, not the README.

## Build and test

Use Bun 1.4.4 and Node ≥22.19 with npm. Root and OpenCode V2 dependencies have independent frozen lockfiles; a root install does not install the package's dependencies. Run from the checkout root:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
bun run test:opencode
bash scripts/e2e.sh hosted-config
bash scripts/e2e.sh hosted-host
bash scripts/e2e.sh hosted-matrix
bash scripts/e2e.sh hosted-native
bash scripts/e2e.sh hosted-durable
bash scripts/e2e.sh claude-hosted
bash scripts/e2e.sh claude-local
```

`bun run test` explicitly runs `src` and `tests`, not nested package tests. `test:opencode` performs the package's own frozen install, strict typecheck, unit tests and explicit `build:package`, then typechecks and tests `adapters/hosted-core` (its own frozen install) and checks opencode-v2's generated `src/core/` copy; root typechecking does not cover opencode-v2. Install the independent dependencies first with `(cd adapters/opencode-v2 && bun install --frozen-lockfile)` when running host suites directly. The host fixtures use source-only full-SHA Git/subdirectory installs through actual OpenCode 2.1.4, without `dist` or build/install hooks. Normal actual-backend and live production-CIMD CodeMode suites exercise native binding, account/configuration guards and durable replay. The actual-backend matrix covers issued races, default admission throttling, expiry and crash recovery; native/durable fake-MCP suites separately exercise public host hooks. No fake-MCP result substitutes for actual-backend acceptance.

`hosted-config` calls the real configurator and discovers its URL-only MCP and default installed-directory plugin from JSONC, with no Grayboard executable on PATH. It checks comments/idempotence, native CIMD OAuth/tools, separate approval/binding, digest admission/receipt without an idle model call, and pause. `hosted-public` instead loads the helper's exact public `github:` selector through the host installer; local Git fixtures are not public-install evidence. Release checks install the run's own tagged commit (`github.sha`) before publication and the same published tag commit afterward. Nightly checks install the default-branch tip that triggered the run, not the latest release. The reusable `e2e.yml` input `public_revision` is optional: an empty input derives `github.sha` in the job; release callers explicitly pass that SHA. It must be a full commit SHA, and the checkout and installed-file comparisons use that same commit. There is no hand-maintained CI revision, latest-release lookup, skip or fallback. To run manually from a checkout of a public commit, use `GRAYBOARD_PUBLIC_REVISION=$(git rev-parse HEAD) bash scripts/e2e.sh hosted-public`. `bash scripts/e2e.sh hosted-live` separately exercises production CIMD DNS/TLS.

PR/master hosted CI runs the hermetic `strict`, `git`, `config`, `host`, `matrix`, `native` and `durable` suites separately from root/backend tests; release builds wait for both. The unconditional `hosted / Hosted required` aggregate fails unless that complete hermetic matrix succeeds, including when dependencies fail, cancel or skip; the one exception is a matrix its caller skipped on purpose (a pin-only PR, below). The `master` ruleset requires that context alongside `test`, so it gates merges. A new push to a PR cancels that PR's older runs. Re-running an older run of a PR joins the same group, so it cancels the PR's newest run in progress. A PR that changes only `.claude-plugin/marketplace.json` (a release's plugin pin) runs neither suite: `test` instead runs the marketplace tests, checks that the file is byte for byte the base's file re-pinned by `scripts/pin_claude_plugin.ts` to a newer release (`verify` mode: no other key changed, no downgrade), and that the pinned tag is an immutable release at the pinned commit; `hosted / Hosted required` passes on the skipped matrix and says so. Outside-network `hosted-live` and `hosted-public` run in `e2e.yml` nightly (with failure tracking issues), before release publication and again as post-release verification, not on PRs. The local pre-push hook retains root checks plus strict package, normal host and helper config gates.

`scripts/e2e.sh` streams a hosted suite's output to the job log and keeps it, with the suite's own JUnit and a few checked facts, under the run directory's `evidence/` (CI retains that directory for 7 days): `diagnostics.log`, `unit.xml`, `provenance.json` (checked source and installed-byte hashes), `summary.json` (the gate's verdict and exit) and, for the matrix suite, `matrix.json` (the failing case's scenario, boundary and crash, plus bounded preparation and progress state, checked against the unchanged reviewed package loop). A successful matrix requires every case to finish successfully; interrupted or malformed observations cannot turn a failure green. The fixture HOME, auth store and databases stay in the runner's scratch and are never copied. Malformed or missing metadata, or a postprocessing failure, fails the gate and names the problem in `summary.json` and the log. Fixtures use a fake Google exchange, logical backend HTTPS routed to loopback and fake model endpoints; live CIMD alone uses production DNS/pinned HTTPS. They do not prove production Google sign-in, deployed TLS or interactive TUI rendering, publish packages or change global configuration.

`claude-hosted` installs the pinned Claude Code release from npm (into `.e2e-cache/`, so the first run needs network) and drives it interactively in a pty with the hosted plugin, against an in-process server and a scripted fake Anthropic API: no Anthropic credential and no tokens. It checks that the plugin binds, that a DM arrives as a channel message, that the model's reply reaches the sender, and that no `grayboard` process runs under Claude Code. Nightly runs install this checkout's plugin; the release gate installs the exact marketplace entry the release's plugin pin will write, fetched from GitHub at the tag's commit.

`claude-local` drives the same pinned Claude Code with local-mode grayboard registered as `grayboard setup` registers it (the user-scope `grayboard` MCP entry and the record hooks in user settings). The root session sends a DM and starts a subagent that sends one and tries to bind; it checks that the subagent's DM carries its child session as `via`, that its bind is refused `child_session`, and that after `/clear` the record dir survives and a second subagent gets a child session of its own under the same root. Nightly and before a release.
