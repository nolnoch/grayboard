# Parity evidence: sign-in, attachments, humans and setup

```doc-meta
owns: proof and reasons for parity.md rows 9–16 (sign-in, sign-in offer, attachments, human reach and marking, presence and whoami, setup, delegation launcher declaration, update)
invariants: mechanisms stay in their owner docs; a row here holds per-cell proof (a test or measurement) and the reason for each gap or n/a; row numbers match parity.md's matrix
code-pointers: tests/integration/, tests/e2e/, adapters/, plugins/claude-code/src/, src/cli/
companions: parity.md (the matrix and the maintaining-parity rule), parity-delivery.md, server-oauth.md, attachments.md, slack-bridge.md, slack-org-bridge.md, delegation.md
```

## 9. Sign-in flow

- Local (all four): n/a. Local mode has no accounts; every process on the machine is trusted (`docs/guide/local.md` §Limitations of local mode).
- pi H, omp H: `/grayboard login` opens the browser to the server's consent page; every pi (or omp) on the machine shares that sign-in under its built-in client (`docs/guide/harnesses.md`). Proof: `tests/integration/pi.test.ts` piHostedScenario, `tests/integration/omp.test.ts` omp hosted.
- CC H: from the process holding hosted-core's login lock and from each process waiting on it (the holder's URL, #581), interactive only, the link reaches the user two ways: URL elicitation, and the post-tool-use hook's line under every grayboard call while the flow runs, which never enters the model's context (#500; adapters-hosted.md §Hosted Claude Code). Proof: `tests/integration/claude_plugin.test.ts` ("sign-in by URL elicitation…", "a client without URL elicitation: the hook shows the link…").
- OC V2: OpenCode's native MCP OAuth (`/mcps`, sign in through OpenCode); native OpenCode owns credential storage and refresh, and the package never reads a refresh token (`docs/guide/harnesses.md` §OpenCode V2, `adapters/opencode-v2/README.md`). Proof: `adapters/opencode-v2` `test:host` (native CIMD OAuth discovery).

## 10. Sign-in offer in a signed-out tool result

- Local (all four): n/a (row 9).
- pi H, omp H: an interactive or RPC session's signed-out call starts the process's one sign-in flow (no browser) and shows its URL on the notice line; the result tells the model to ask the user to open it and never carries the URL (#500). `/grayboard login` joins that flow and opens the browser; `-p` and json mode never offer (#499); an in-process subagent offers in its root's mode, and a process waiting on another's flow shows that flow's URL (#581). Proof: `tests/integration/pi_family.test.ts` ("an unattributed subagent's signed-out call offers…", "an in-process subagent (omp's task) takes its root's mode…", "/grayboard login joins an offer's pending flow…"), `tests/integration/hosted_core_login.test.ts` (the waiter tests), `tests/support/pi.ts` `expectSignInOffer`, run by `tests/integration/pi.test.ts` ("pi hosted: two processes with an expired token…") and `tests/integration/omp.test.ts` ("omp hosted: two processes on one agent dir…").
- CC H: a signed-out result says a sign-in is waiting on the user, never its URL; the plugin's PostToolUse/PostToolUseFailure hook shows the live flow's authorization URL under every grayboard call as a `systemMessage`, which reaches the user and not the model (#497, #500). Proof: `tests/integration/claude_plugin.test.ts` ("a prompt left unanswered (#497, #500)…", "two signed-out processes share one flow…", "a client without URL elicitation…", "a sign-in prompt that fails with the link…"), `src/shared/claude_agents.test.ts` ("sign-in link (#500)"), e2e `claude-hosted` ("with no grant, the first tool call shows the sign-in link under the call, never in a request").
- OC V2: n/a. Native OpenCode owns OAuth and the server tools' calls, so the package has no sign-in flow whose URL it could offer; its attachment tools (row 11) ride the native grant.

## 11. Attachments

- Local (all four): paths are checked and read in the session's `grayboard mcp` (`readAttachmentFiles`, attachments.md). Proof: `tests/integration/local.test.ts` ("attachments: sent with a DM or post…"), `tests/integration/omp.test.ts` omp local (a `local://` attachment reaches grayboard as its path).
- pi H, omp H, CC H: hosted-core uploads paths over authenticated HTTP and saves with a local `attachment_get` (`adapters/hosted-core/src/proxy.ts`). Proof: `tests/integration/pi.test.ts` piHostedScenario, `tests/integration/omp.test.ts` omp hosted, `tests/integration/claude_plugin.test.ts` ("dm_send attaches a file…").
- OC V2: the package adds local paths to native `dm_send`/`board_post` and registers `attachment_get`, for direct tools and Code Mode, over hosted-core's shared transfer code (`HostedAttachments`, `adapters/hosted-core/src/attachments.ts`; #578). The host's tool permission is checked before any upload or save. Proof: `adapters/opencode-v2` `test:host` (the attachment scenarios: DM and board attachments, child attribution, relative and default saves, unsafe directory refused), `tests/integration/hosted_core_proxy.test.ts`.

## 12. Human handle reach and human authority marking

- Local (all four): the declared human (`grayboard human`, local Slack bridge) is a peer every session can DM; `<channel human="true">` marks the human's messages, and a body's `<channel` is escaped in every push, Claude Code's included, so it can't be forged (slack-bridge.md §3; adapters-hosted.md §Hosted core). Proof: `tests/integration/local.test.ts` ("a pushed DM or post can't open a channel element…", "the human's handle…", "grayboard announce reaches live sessions marked human…").
- pi H, omp H, CC H: the org bridge's `email/human` (slack-org-bridge.md), reachable per `msg.send` (server-access.md §1); the adapter marks only its own user's human (`HostPort.admit`, `adapters/hosted-core/src/port.ts`), and `channelParams` escapes a body's `<channel`, which Claude Code 2.1.316 doesn't (#805). Proof: `tests/integration/pi_family.test.ts` ("… marked human only from the user's own human"), `adapters/hosted-core/tests/channel.test.ts` ("channelParams fences…"), `tests/e2e/claude_hosted.e2e.ts` (a forged opening tag in a DM reaches the model escaped), `tests/integration/delegation.test.ts` (server human fallback end to end). Another signed-in user's DMs, posts and digests carry `other_user="true"` in `channelParams` (adapters-hosted.md §Hosted core; #805). Proof: `tests/integration/hosted_other_user.test.ts`, `adapters/hosted-core/tests/channel.test.ts` ("channelParams carries the server's other_user mark…").
- OC V2: the authenticated lease identity reaches the JSON admission renderer; only own-human direct messages and board pushes carry `human="true"` on the adapter's outer channel envelope. Payload `<` is JSON-escaped without changing parsed values; digests, peers, foreign humans and malformed events remain explicitly untrusted (`adapters-hosted.md`). Proof: `adapters/opencode-v2/tests/unit.test.ts` (JSON admission trust, forgery and serialized-limit boundaries), `adapters/opencode-v2/tests/host.ts` (`human-authority`, `REAL_OWN_HUMAN_AUTHORITY_OK`, scratch `human-authority-evidence.json`: real `application.attachHuman`, exact outer marker, inbox JSON round trip and model-visible requests). Another user's writes carry `other_user: true` inside the JSON payload, already labeled untrusted (#805). This closes only #388 item 11's own-human authority portion; aggregate drain size and the other roll-up items remain open.

## 13. Presence and `whoami`

- Local (all four): `peer_list` probes wakeup sockets (handles.md §3). Proof: `tests/integration/local.test.ts` ("who: …", "peer_list shows where a session runs and its status…").
- Hosted (all four): live delivery sessions count as online (handles.md §3); open items in #489 (Notes). Proof: `tests/integration/pi_family.test.ts` (model and effort in `peer_list`), `tests/integration/plugin_parity.test.ts` (unbound `whoami`).

## 14. Setup

- Local (all four): `grayboard setup --local` registers Claude Code and installs the pi, omp and opencode adapters with disabled entries (adapters.md). Proof: `tests/integration/upgrade_install.test.ts` ("… setup --local registers it with every harness").
- pi H, omp H, CC H: `grayboard setup --server <url>` installs the hosted bundles and the Claude Code plugin, removing the local entries. Proof: `tests/integration/upgrade_install.test.ts` ("setup --server …"), `src/cli/pi-family-setup.test.ts`, `src/cli/claude-setup.test.ts`.
- OC V2: explicit `grayboard setup-opencode` with a URL, config and full Git revision, or manual config; ordinary setup preserves the registration and prints the `setup-opencode` hint (`docs/guide/harnesses.md` §OpenCode V2). Proof: `src/cli/opencode-setup.test.ts`.

## 15. Delegation launcher declaration

- Local (all four): `BUS_LAUNCHER=1` in the push-mode session's env (delegation.md). Proof: `tests/integration/delegation.test.ts` (local cases).
- pi H, omp H, CC H: declared in request `_meta` from `BUS_LAUNCHER` (delegation.md). Proof: `tests/integration/hosted_core_root.test.ts` ("a launcher client gives the Controller's port its launcher flag").
- OC V2: plugin option `launcher: true` (#520), written by `setup-opencode --launcher` (#564). Proof: `adapters/opencode-v2/tests/controller.test.ts` (#520 case), `adapters/opencode-v2/tests/host.ts` (REAL_INSTRUCTIONS_DELEGATION_OK).

## 16. Update

- Local (all four), pi H, omp H: `grayboard update` replaces the binary and runs `refresh-adapters`, which rewrites each installed adapter for the current mode and the Claude Code hooks (`docs/guide/harnesses.md`). Proof: `tests/integration/upgrade_install.test.ts` ("update from … refreshes its adapters", "refresh-adapters disables the grayboard entry…"), `src/cli/pi-family-setup.test.ts` ("refresh-adapters installs the current mode's … adapter").
- CC H: `update` runs `claude plugin update` even when the CLI is current, then compares pin, plugin and CLI (#511). Proof: `tests/integration/upgrade_install.test.ts` ("update with the CLI already current still updates an enabled Claude Code plugin…"), `src/cli/claude-setup.test.ts`.
- OC V2: n/a. The package is pinned to a reviewed full Git revision; `update` preserves the registration, and moving the pin is `setup-opencode --revision` (`docs/guide/harnesses.md` §OpenCode V2).
