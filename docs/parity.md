# Parity matrix

```doc-meta
owns: capability parity across harnesses and modes: per harness × mode cell, supported, gap (issue) or n/a (reason), and where it is proven
invariants: parity by addition (a cell becomes supported without taking anything from another cell); a feature or fix PR names the cells it changes; a gap cell links an issue or says unfiled; mechanisms stay in their owner docs, this doc holds status, reasons and proof
code-pointers: adapters/pi/, adapters/omp/, adapters/opencode/, adapters/pi-family/, adapters/opencode-v2/, adapters/hosted-core/src/, plugins/claude-code/src/, src/local/mcp.ts, src/server/hosted.ts
companions: boards.md §9 (adapter and push mechanics), boards.md §3 (handles, child sessions, name record), architecture.md §Hosted MCP (hosted wire and login), slack-bridge.md (human handles)
```

The baseline every later change is measured against. A cell says what a user of that harness in that mode gets; how it works is in the owner doc the evidence links. "Proof" names a test or e2e suite only where one exercises that cell; `—` means none does.

## Columns

| Column | What runs |
|---|---|
| pi L | `adapters/pi/`: the extension runs one push-mode `grayboard mcp` child and serves its tools (boards.md §9) |
| pi H | `adapters/pi-family/entry-pi.ts`: no grayboard process; own grant, hosted-core lease per root session |
| omp L | `adapters/omp/`: one `grayboard mcp` per omp process, tools served in every runtime (#523) |
| omp H | `adapters/pi-family/entry-omp.ts`: the hosted pi extension with omp's delivery and subagent rules (#280) |
| OC V1 (L) | `adapters/opencode/`: one `grayboard mcp` per opencode process; local mode only |
| OC V2 (H) | native OpenCode HTTP MCP for tools and OAuth, plus `adapters/opencode-v2/` for delivery only; hosted only |
| CC L | Claude Code runs `grayboard mcp` as its own MCP server; pushes are channel notifications |
| CC H | `plugins/claude-code/`: stdio plugin over hosted-core, own grant, lease keyed by `CLAUDE_CODE_SESSION_ID` (#281) |

## Matrix

| # | Capability | pi L | pi H | omp L | omp H | OC V1 (L) | OC V2 (H) | CC L | CC H |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Tool surface | yes | yes | yes | yes | yes | yes | yes | yes |
| 2 | Push delivery and wakeup | yes | yes | yes | yes | yes | yes | yes | yes |
| 3 | Current instructions on push-started turns | yes | yes | yes | yes | yes | yes | yes | yes |
| 4 | Bind, unbind, several holds, configured start name | yes | yes | yes | yes | yes | yes | yes | yes |
| 5 | Names across an in-process session switch or MCP reconnect | yes | yes | yes | yes | yes | n/a | yes | yes |
| 6 | Names when a new harness process resumes a conversation | gap #195 | yes | gap #195 | yes | gap #195 | yes | gap #195 | yes |
| 7 | Automatic restart after the grayboard process exits | yes | n/a | yes | n/a | gap #576 | n/a | n/a | n/a |
| 8 | Subagents as child sessions, writes attributed (`via`) | yes | yes | yes | yes | gap #577 | yes | yes | yes |
| 9 | Sign-in flow | n/a | yes | n/a | yes | n/a | yes | n/a | yes |
| 10 | Sign-in offer in a signed-out tool result | n/a | gap #499 | n/a | gap #499 | n/a | n/a | n/a | yes |
| 11 | Attachments (send from a path, save with `attachment_get`) | yes | yes | yes | yes | yes | gap #578 | yes | yes |
| 12 | Human handle reach and human authority marking | yes | yes | yes | yes | yes | gap #388 | yes | yes |
| 13 | Presence and `whoami` | yes | yes | yes | yes | yes | yes | yes | yes |
| 14 | Setup | yes | yes | yes | yes | yes | yes | yes | yes |
| 15 | Delegation launcher declaration | yes | yes | yes | yes | yes | yes | yes | yes |
| 16 | Update | yes | yes | yes | yes | yes | n/a | yes | yes |

## Evidence by row

### 1. Tool surface

- Local (all four): the tools `grayboard mcp` serves (`src/core/tools.ts`, `src/local/mcp.ts`); the child adapters register `grayboard tools`' list under the names each harness showed before (boards.md §9). Proof: `tests/integration/pi.test.ts` piScenario (the request's tool list equals the served one), `tests/integration/opencode.test.ts` ("every tool `grayboard tools` lists converts to zod"), `tests/integration/local.test.ts` ("the reply and recovery tools ask Claude Code to load them upfront").
- pi H, omp H, CC H: hosted-core's proxy of the server's native tools, with paths on `dm_send`/`board_post` and a local `attachment_get` added (`hostTools`, `adapters/hosted-core/src/proxy.ts`). OC V2: the native tools as served; the package registers no agent tools (`adapters/opencode-v2/README.md`). Proof: `tests/integration/hosted_core_snapshot.test.ts` (the snapshot equals the live native `tools/list`).

### 2. Push delivery and wakeup

- pi L, omp L, OC V1: DMs, mentions and thread replies start a turn; digests and deferred pushes are context only (boards.md §9). Proof: `tests/integration/pi.test.ts` piScenario, `tests/integration/omp.test.ts` omp local task run (a peer's DM reaches main once), `tests/integration/opencode.test.ts` ("an unbound session acts as its ID…": the DM arrives as a prompt).
- CC L: channel notifications, only while Claude Code's channel gate registers the server; gate off → tools-only, reason in instructions and first result (`claudeChannels`, boards.md §9). Proof: `tests/integration/local.test.ts` (pushes at the MCP level; "a Claude Code session whose channels are off runs tools-only and is warned why").
- pi H, omp H, CC H: hosted-core lease and `RootDelivery` (boards.md §9 Hosted core). Proof: `tests/integration/pi.test.ts` "pi hosted: …", `tests/integration/omp.test.ts` "omp hosted: …", `tests/integration/claude_plugin.test.ts` ("a flagged interactive session: … a DM arrives as one channel push"), e2e `claude-hosted` (`tests/e2e/claude_hosted.e2e.ts`).
- OC V2: delivery opens only on a human-enrolled, bound root (#226; README §OpenCode V2). Proof: `adapters/opencode-v2` `test:host` (`adapters/opencode-v2/tests/host.ts`).

### 3. Current instructions on push-started turns

- pi L, pi H: pi runs `before_agent_start` for a push-started turn, so its `<grayboard>` section is current (`adapters/pi/grayboard.ts`, `adapters/pi-family/entry-pi.ts`). Proof: `tests/integration/pi.test.ts` piUnboundScenario (a woken turn's system prompt is the bound name's), piHostedScenario.
- omp L, omp H: one shared plan (`adapters/pi-family/omp-instructions.ts`, #441, #552): `before_provider_request` rewrites stale instructions per request, `context` adds them as a hidden message after a prompt rebuild, and both warn once for main only when the stale text can't be found. omp L reads the current text from its child's last initialize; omp H fetches it. Proof: `tests/integration/omp_instructions.test.ts` (plan, rewrite and the warning), `tests/integration/omp.test.ts` omp local ("a push-started bind reaches the next request's instructions without a user prompt") and omp hosted `/fork`, `/new`, `/resume`.
- OC V1: `experimental.chat.system.transform` adds the latest instructions to every request (`adapters/opencode/grayboard.ts`). Proof: `tests/integration/opencode.test.ts` ("… the system prompt follows in full").
- OC V2: the plugin's `context` hook carries the root's (or a subagent's child) server instructions per request (#531, #535). Proof: `adapters/opencode-v2/tests/host.ts` (REAL_INSTRUCTIONS cases), `adapters/opencode-v2/tests/instructions.test.ts`.
- CC L, CC H: Claude Code reads MCP instructions only at initialize (`plugins/claude-code/src/plugin.ts` instructions comment), so a name change reaches the model as the rebuilt instructions in `bind`/`unbind`'s result, or the next result after a lost one (`instructionsStale`, `src/local/mcp.ts`); the system prompt keeps the connect-time text. Proof: —.

### 4. Bind, unbind, several holds, configured start name

- Local (all four): one local surface (boards.md §3); an explicit `BUS_IDENTITY` in the entry's env binds at start. Proof: `tests/integration/binding.test.ts`, `tests/integration/pi.test.ts` piUnboundScenario (two binds and an unbind), `tests/integration/opencode.test.ts` (bind and rebind), `tests/integration/omp.test.ts` omp local pin.
- pi H, omp H, CC H: `bind`/`unbind` and up to `MAX_HOLDS` holds (#451); an explicit `BUS_IDENTITY` binds at a root's first start (#443, #543). Proof: `tests/integration/pi_family.test.ts` ("an explicit BUS_IDENTITY binds at a new root's start"), `tests/integration/claude_plugin.test.ts` ("an explicit BUS_IDENTITY binds at start"), `tests/integration/hosted_core_root.test.ts` (configured name precedence).
- OC V2: native `bind`/`unbind`; the configured name is the plugin option `name` (`create:false` unless `create`), which binds each new root without enrolling it (README §OpenCode V2). Proof: `adapters/opencode-v2/tests/host.ts` (bind before enroll; configured launcher root).

### 5. Names across an in-process session switch or MCP reconnect

- pi L, CC L: a respawned `grayboard mcp` under the same harness pid (pi `/new`, `/resume`, fork; Claude Code `/mcp reconnect`) binds its names back from the name record (boards.md §3, §9). Proof: `tests/integration/binding.test.ts` (restarts from the name record under `tests/support/harness.ts`, whose SIGUSR1 stands in for `/mcp` reconnect).
- omp L: the main runtime, its process and its names carry across `/new`, `/resume`, `/fork` (boards.md §9 omp). Proof: `tests/integration/omp.test.ts` omp local (`/new` keeps the process and name).
- OC V1: one grayboard per opencode process, shared by every session, so a session switch doesn't touch it (README §Other harnesses).
- pi H, omp H: `/new` and fork carry the outgoing root's holds; pi `/reload` keeps the lease (boards.md §9 Hosted pi, Hosted omp). Proof: `tests/integration/pi.test.ts` piHostedCarryScenario, `tests/integration/pi_family.test.ts` (`/new` carry, reload detach), `tests/integration/omp.test.ts` omp hosted `/fork`, `/new`, `/resume`.
- CC H: the lease is keyed by `CLAUDE_CODE_SESSION_ID`, which survives `/clear` (boards.md §9). Proof: e2e `claude-hosted` (the facts test's root continues across `/clear`).
- OC V2: n/a. Each OpenCode session is its own root that a human enrolls (#226); nothing carries between roots by design, and the `name` option binds each new root.

### 6. Names when a new harness process resumes a conversation

- pi L, omp L, OC V1, CC L: **gap #195.** The name record is keyed by harness pid, so a new process (`claude --resume`, a reopened pi or omp session) starts unbound.
- pi H, omp H, CC H: a root's start takes back its `rememberedHeld` holds with `create:false` before `BUS_IDENTITY` (`RootDelivery.begin`, `adapters/hosted-core/src/root.ts`; `claude --resume <id>`, boards.md §9). Proof: `tests/integration/hosted_core_root.test.ts` ("a resumed session takes back what it held"), `tests/integration/pi_family.test.ts` ("… a later resume rebinds the remembered name").
- OC V2: the plugin persists the bound name and rebinds it on resume (#251). Proof: `adapters/opencode-v2` `test:host` (crosses a host process reload, `adapters/opencode-v2/README.md`).

### 7. Automatic restart after the grayboard process exits

- omp L: an unexpected exit restarts the process after 0, 1 and 5 s (a run of 60 s resets the count); names come back from the name record (`RESTART_DELAYS_MS`, `adapters/omp/grayboard.ts`). Proof: `tests/integration/omp.test.ts` omp local ("a killed grayboard process is restarted and takes its name back").
- pi L: the same policy as omp L (0, 1 and 5 s; a 60 s run resets the count; one more exit gives up and says so); calls during a pending restart wait for it and honor their abort, `/new` and shutdown cancel it, and a live child that hit EPIPE is killed before its replacement (`adapters/pi/grayboard.ts`, #559). Proof: `tests/integration/pi.test.ts` ("pi local: a killed grayboard restarts with its bound name…", "/new during a pending 5 s restart…", "/new aborts a tool awaiting the pending restart…").
- OC V1: **gap #576.** After an exit every call fails with the exit reason and the plugin reports "restart opencode to reconnect"; nothing starts a new process before opencode restarts (`adapters/opencode/grayboard.ts` `fail`, `running`).
- CC L: n/a. Claude Code's own MCP client runs `grayboard mcp`; no grayboard component exists to restart it. Recovery is `/mcp reconnect`, which takes the names back (row 5).
- pi H, omp H, OC V2: n/a. No grayboard process: the extension or package runs inside the harness and talks to the server over HTTP.
- CC H: n/a. The plugin is Claude Code's stdio MCP server, so its process lifecycle is Claude Code's; a restarted plugin takes back the session's remembered holds (row 6).

### 8. Subagents as child sessions, writes attributed (`via`)

- pi L: pi-subagents' detached runner is a child of its parent session and can promote itself by binding (boards.md §3 Local runner children). In-process foreground children load no extensions, so they make no bus calls (#523 step 5). Proof: `tests/integration/pi.test.ts` piRunnerScenario.
- omp L: a `kind: "sub"` runtime's call carries its agent id under `GRAYBOARD_AGENT_META`; subagents get no pushes and no instructions (#523, #526). Proof: `tests/integration/omp.test.ts` omp local task run.
- OC V1: **gap #577.** `execute` sends no `_meta` agent key (`adapters/opencode/grayboard.ts` tool record), so a subagent session's (`parentID`) write reads as its root's, and `experimental.chat.system.transform` gives subagent sessions the root's instructions. #523 left the V1 adapter out.
- pi H, omp H: a child registers under its root before its first call (boards.md §9 Hosted pi, Hosted omp). Proof: `tests/integration/pi_family.test.ts` ("a marked child registers under its root…"), `tests/integration/omp.test.ts` omp hosted task run.
- OC V2: every subagent of an enrolled root registers as a child and gets the server's child instructions (#535). Proof: `adapters/opencode-v2/tests/host.ts` (REAL_INSTRUCTIONS_SUBAGENT_OK), `adapters/opencode-v2/tests/instructions.test.ts`.
- CC L, CC H: hooks write a per-call agent record that the MCP side takes; a call with no record is refused, never run as the root (#551; boards.md §3 Claude Code children). CC H's child is `<session id>/agent/<agent id>`, ended by `SubagentStop` (`plugins/claude-code/src/plugin.ts`). Proof: e2e `claude-local` (`tests/e2e/claude_local.e2e.ts`), `tests/integration/claude_records.test.ts`, `tests/integration/claude_plugin.test.ts` ("a subagent's call runs as a child of the root, with via").

### 9. Sign-in flow

- Local (all four): n/a. Local mode has no accounts; every process on the machine is trusted (README §Limitations of local mode).
- pi H, omp H: `/grayboard login` opens the browser to the server's consent page; every pi (or omp) on the machine shares that sign-in under its built-in client (README §Other harnesses). Proof: `tests/integration/pi.test.ts` piHostedScenario, `tests/integration/omp.test.ts` omp hosted.
- CC H: URL elicitation from the process holding hosted-core's login lock, interactive only (boards.md §9 Hosted Claude Code). Proof: `tests/integration/claude_plugin.test.ts` ("sign-in by URL elicitation…").
- OC V2: OpenCode's native MCP OAuth (`/mcps`, sign in through OpenCode); native OpenCode owns credential storage and refresh, and the package never reads a refresh token (README §OpenCode V2, `adapters/opencode-v2/README.md`). Proof: `adapters/opencode-v2` `test:host` (native CIMD OAuth discovery).

### 10. Sign-in offer in a signed-out tool result

- Local (all four): n/a (row 9).
- pi H, omp H: **gap #499.** A signed-out call answers "run /grayboard login", which the model can't act on.
- CC H: a signed-out result says a sign-in is waiting on the user, never its URL; the plugin's PostToolUse/PostToolUseFailure hook shows the live flow's authorization URL under every grayboard call as a `systemMessage`, which reaches the user and not the model (#497, #500). Proof: `tests/integration/claude_plugin.test.ts` ("a prompt left unanswered (#497, #500)…", "a client without URL elicitation…", "a sign-in prompt that fails with the link…"), `src/shared/claude_agents.test.ts` ("sign-in link (#500)"), e2e `claude-hosted` ("with no grant, the first tool call shows the sign-in link under the call, never in a request").
- OC V2: n/a. Native OpenCode owns OAuth and the tool calls; the package registers no tools, so it has no result to put a URL in.

### 11. Attachments

- Local (all four): paths are checked and read in the session's `grayboard mcp` (`readAttachmentFiles`, boards.md §12). Proof: `tests/integration/local.test.ts` ("attachments: sent with a DM or post…"), `tests/integration/omp.test.ts` omp local (a `local://` attachment reaches grayboard as its path).
- pi H, omp H, CC H: hosted-core uploads paths over authenticated HTTP and saves with a local `attachment_get` (`adapters/hosted-core/src/proxy.ts`). Proof: `tests/integration/pi.test.ts` piHostedScenario, `tests/integration/omp.test.ts` omp hosted, `tests/integration/claude_plugin.test.ts` ("dm_send attaches a file…").
- OC V2: **gap #578.** Native `dm_send`/`board_post` take only previously uploaded `attachment_ids`, and the native tools have no `attachment_get` (`adapters/hosted-core/src/native-tools.json`); the package registers no tools, so an OpenCode V2 agent can neither upload a file nor save a received one.

### 12. Human handle reach and human authority marking

- Local (all four): the declared human (`grayboard human`, local Slack bridge) is a peer every session can DM; `<channel human="true">` marks the human's messages, and the adapters' renderers escape a body's `<channel` so it can't be forged (slack-bridge.md §3; boards.md §9 Hosted core). Proof: `tests/integration/local.test.ts` ("the human's handle…", "grayboard announce reaches live sessions marked human…").
- pi H, omp H, CC H: the org bridge's `email/human` (slack-bridge.md §8), reachable per `canSend` (architecture.md §5); the adapter marks only its own user's human (`HostPort.admit`, `adapters/hosted-core/src/port.ts`). Proof: `tests/integration/pi_family.test.ts` ("… marked human only from the user's own human"), `tests/integration/delegation.test.ts` (server human fallback end to end).
- OC V2: **gap #388** (item 11). DMs to the human work, but every admitted item renders as "untrusted sender content", the user's own Slack-relayed messages included (`render`, `adapters/opencode-v2/src/core/model.ts`), so the human's authority isn't marked.

### 13. Presence and `whoami`

- Local (all four): `peer_list` probes wakeup sockets (boards.md §3 Presence). Proof: `tests/integration/local.test.ts` ("who: …", "peer_list shows where a session runs and its status…").
- Hosted (all four): live delivery sessions count as online (boards.md §3 Presence); open items in #489 (Notes). Proof: `tests/integration/pi_family.test.ts` (model and effort in `peer_list`), `tests/integration/plugin_parity.test.ts` (unbound `whoami`).

### 14. Setup

- Local (all four): `grayboard setup --local` registers Claude Code and installs the pi, omp and opencode adapters with disabled entries (boards.md §9). Proof: `tests/integration/upgrade_install.test.ts` ("… setup --local registers it with every harness").
- pi H, omp H, CC H: `grayboard setup --server <url>` installs the hosted bundles and the Claude Code plugin, removing the local entries. Proof: `tests/integration/upgrade_install.test.ts` ("setup --server …"), `src/cli/pi-family-setup.test.ts`, `src/cli/claude-setup.test.ts`.
- OC V2: explicit `grayboard setup-opencode` with a URL, config and full Git revision, or manual config; ordinary setup preserves the registration and prints the `setup-opencode` hint (README §OpenCode V2). Proof: `src/cli/opencode-setup.test.ts`.

### 15. Delegation launcher declaration

- Local (all four): `BUS_LAUNCHER=1` in the push-mode session's env (boards.md §13). Proof: `tests/integration/delegation.test.ts` (local cases).
- pi H, omp H, CC H: declared in request `_meta` from `BUS_LAUNCHER` (boards.md §13). Proof: `tests/integration/hosted_core_root.test.ts` ("a launcher client gives the Controller's port its launcher flag").
- OC V2: plugin option `launcher: true` (#520), written by `setup-opencode --launcher` (#564). Proof: `adapters/opencode-v2/tests/controller.test.ts` (#520 case), `adapters/opencode-v2/tests/host.ts` (REAL_INSTRUCTIONS_DELEGATION_OK).

### 16. Update

- Local (all four), pi H, omp H: `grayboard update` replaces the binary and runs `refresh-adapters`, which rewrites each installed adapter for the current mode and the Claude Code hooks (README §Other harnesses). Proof: `tests/integration/upgrade_install.test.ts` ("update from … refreshes its adapters", "refresh-adapters disables the grayboard entry…"), `src/cli/pi-family-setup.test.ts` ("refresh-adapters installs the current mode's … adapter").
- CC H: `update` runs `claude plugin update` even when the CLI is current, then compares pin, plugin and CLI (#511). Proof: `tests/integration/upgrade_install.test.ts` ("update with the CLI already current still updates an enabled Claude Code plugin…"), `src/cli/claude-setup.test.ts`.
- OC V2: n/a. The package is pinned to a reviewed full Git revision; `update` preserves the registration, and moving the pin is `setup-opencode --revision` (README §OpenCode V2).

## Notes (known limits, not cells)

- #559 items 2–6: omp L robustness edges (no abort or timeout while a call waits for the process, wrapper scripts not recognised, ACP with on-disk MCP config, advisor calls, Windows).
- #566: hosted child rows are never idle-swept, so an OC V2 launcher root degrades after about 128 subagents (`MAX_CHILDREN`) in one ownership. A capacity limit; pi H and omp H end each child with its run (`tests/integration/pi_family.test.ts`, `tests/integration/omp.test.ts` 130-subagent cases).
- #489: hosted presence and `whoami` items (an unbound native session lists itself twice in `unbound_sessions`; local `whoami` says `aliases` where hosted says `held`).
- OC V1: N root sessions in one opencode process share one binding (boards.md §9 opencode).
- #474: on a signed-in machine, `refresh-adapters` keeps the V1 opencode entry, which serves the local bus.
- #427: pi's `pi update --extensions` doesn't refresh the loose-file adapter; only `grayboard update` does.

## Maintaining parity

- A feature or fix PR names the cells it changes (row number and column) and updates this doc in the same change.
- A new capability lands in every applicable cell, or files a gap issue per cell it leaves and adds the row with those gap cells. An n/a cell states why the capability can't apply.
- Parity by addition: moving a cell to supported never removes a capability from another cell.

## Not covered

Harnesses without an adapter (any MCP client run with `BUS_PUSH=off`, tools only) and the Slack bridges themselves (slack-bridge.md) have no columns.
