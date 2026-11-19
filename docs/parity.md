# Parity matrix

```doc-meta
owns: capability parity across harnesses and modes: per harness × mode cell, supported, gap (issue) or n/a (reason), and where it is proven
invariants: parity by addition (a cell becomes supported without taking anything from another cell); a feature or fix PR names the cells it changes; a gap cell links an issue or says unfiled; mechanisms stay in their owner docs, this doc holds status; each row's reasons and proof are in parity-delivery.md (rows 1–8) and parity-access.md (rows 9–16)
code-pointers: adapters/pi/, adapters/omp/, adapters/opencode/, adapters/pi-family/, adapters/opencode-v2/, adapters/hosted-core/src/, plugins/claude-code/src/, src/local/mcp.ts, src/server/hosted.ts
companions: parity-delivery.md (rows 1–8), parity-access.md (rows 9–16), adapters.md, adapters-hosted.md (adapter and push mechanics), handles.md, child-sessions.md, sessions.md (handles, child sessions, name record), server-hosted-mcp.md, server-oauth.md (hosted wire and login), slack-bridge.md (human handles)
```

The baseline every later change is measured against: as of v2.4.0, every cell is supported or n/a, with no open gap. A cell says what a user of that harness in that mode gets; how it works is in the owner doc the evidence links. "Proof" names a test or e2e suite only where one exercises that cell; `—` means none does.

## Columns

| Column | What runs |
|---|---|
| pi L | `adapters/pi/`: the extension runs one push-mode `grayboard mcp` child and serves its tools (adapters.md) |
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
| 6 | Names when a new harness process resumes a conversation | yes | yes | yes | yes | yes | yes | yes | yes |
| 7 | Automatic restart after the grayboard process exits | yes | n/a | yes | n/a | yes | n/a | n/a | n/a |
| 8 | Subagents as child sessions, writes attributed (`via`) | yes | yes | yes | yes | yes | yes | yes | yes |
| 9 | Sign-in flow | n/a | yes | n/a | yes | n/a | yes | n/a | yes |
| 10 | Sign-in offer in a signed-out tool result | n/a | yes | n/a | yes | n/a | n/a | n/a | yes |
| 11 | Attachments (send from a path, save with `attachment_get`) | yes | yes | yes | yes | yes | yes | yes | yes |
| 12 | Human handle reach and human authority marking | yes | yes | yes | yes | yes | yes | yes | yes |
| 13 | Presence and `whoami` | yes | yes | yes | yes | yes | yes | yes | yes |
| 14 | Setup | yes | yes | yes | yes | yes | yes | yes | yes |
| 15 | Delegation launcher declaration | yes | yes | yes | yes | yes | yes | yes | yes |
| 16 | Update | yes | yes | yes | yes | yes | n/a | yes | yes |
| 17 | Repo-name suggestion while unbound | yes | yes | yes | yes | yes | yes | yes | yes |
| 18 | Another user's item wakes only under a grant (`msg.wake`) | n/a | yes | n/a | yes | n/a | yes | n/a | yes |
| 19 | Delegation to another user's launcher under a grant (`delegate.to`) | n/a | yes | n/a | yes | n/a | yes | n/a | yes |
| 20 | Runtime role bindings (`org_admin`, `team_owner`) and `grayboard admin role` | n/a | yes | n/a | yes | n/a | yes | n/a | yes |
| 21 | A service's agent signs in with a run token from a service credential (no browser) | n/a | yes | n/a | yes | n/a | yes | n/a | yes |
| 22 | Invoke a service by posting on its board under a `service_invoke` grant; the service's reply wakes the invoker | n/a | yes | n/a | yes | n/a | yes | n/a | yes |

## Evidence by row

Rows 1–8: `parity-delivery.md`. Rows 9–16: `parity-access.md`. Rows 17–22: §Not covered.

## Notes (known limits, not cells)

- #559 items 3, 6: omp L robustness edges (a renamed entry running grayboard through its own script, or one an ACP client declares, is reported but not refused (#1140), except an exactly named `grayboard` over HTTP, through its own script or an unlisted wrapper, or on Windows; Windows). A child that wedges after it initializes (in a call, or omp's switch-time handshake) holds calls until abort; `tools/call` has no deadline, since a timed-out send may have landed (item 2). An omp advisor gets built-in tools only, so it never calls grayboard (item 5, omp 18.14).
- #489: hosted presence and `whoami` items (an unbound native session lists itself twice in `unbound_sessions`; local `whoami` says `aliases` where hosted says `held`).
- OC V1: N root sessions in one opencode process share one binding (adapters.md §opencode).
- On a signed-in machine, `refresh-adapters` keeps the V1 opencode entry, which serves the local bus, and prints the `setup-opencode` command that reaches the server, with the URL's credentials stripped (#474); the entry's `grayboard mcp` already says on stderr that it serves the local bus (#491). Proof: `src/cli/opencode-setup.test.ts` ("(#474)").
- #475: an ID whose session ended comes back differently per mode, on purpose: hosted reopens its row (the ID is the harness's own and can't change), local refuses it `id_collision` (`registerId`).
- #427: pi's `pi update --extensions` doesn't refresh the loose-file adapter; only `grayboard update` does.

## Maintaining parity

- A feature or fix PR names the cells it changes (row number and column) and updates this doc and the row's proof (`parity-delivery.md`, rows 1–8; `parity-access.md`, rows 9–16) in the same change.
- A new capability lands in every applicable cell, or files a gap issue per cell it leaves and adds the row with those gap cells. An n/a cell states why the capability can't apply. Local mode is the single-user edition (`vision.md` §1): a capability that only means something with more than one principal (roles, grants, service principals, cross-user policy) is n/a in every local cell, not a gap.
- Parity by addition: moving a cell to supported never removes a capability from another cell.

## Not covered

Harnesses without an adapter (any MCP client run with `BUS_PUSH=off`, tools only) and the Slack bridges themselves (slack-bridge.md) have no columns.

The Rust client SDK (`sdk/rust`, #929) is a library for services, not a harness adapter: no column, no cell. Its envelope is proved equal to hosted-core's by `tests/integration/rust_fixtures.test.ts` and the Rust test `requests_match_the_reference_clients_recording`, and its round trip by `tests/integration/rust_sdk.test.ts` (`scripts/e2e.sh rust-sdk`); its push delivery stream (`sdk-rust.md` §2), a typed method per native tool (`sdk-rust.md` §3) and its conformance driver, which runs every hosted scenario of `tests/conformance/` as `hosted/rust` (`sdk-rust.md` §4), are built, and so is its use of the server's service credential (row 21): `ClientCredentials` mints its own run tokens with a `generic` credential, which the example and the conformance run use (`sdk-rust.md` §5).

### 17. Repo-name suggestion while unbound

- Local (all four): `grayboard mcp` offers `sessionIdentity` first among an unbound session's candidates (handles.md §1). Proof: `tests/integration/binding.test.ts`.
- pi H, omp H, CC H: the adapter's `HostedClient` sends `sessionIdentity(env, cwd)` for its root on every wire (#522); the server offers it first while free (server-sessions.md). Proof: `tests/integration/hosted_core_wire.test.ts` ("a wire's suggested name reaches the server"), `src/server/hosted.test.ts` (suggested name).
- OC V2: its `HostPort.suggested` sends `sessionIdentity({}, directory)` for the plugin's directory on every wire, from a generated copy of `src/shared/naming.ts` (#696; the `name` plugin option, not `BUS_IDENTITY`, is its explicit name). Proof: `adapters/opencode-v2/tests/instructions.test.ts` ("the suggested name is local mode's", and the native fetcher's meta), with the server half above.

### 18. Another user's item wakes only under a grant (`msg.wake`)

- Local (all four): n/a. Local mode is single-user (`vision.md` §1): every session is the same user's.
- Server side, every hosted cell: `application.pending()` marks another user's DM or push that no grant covers `ungranted` and not actionable, per pull (server-access.md §1 `msg.wake`, #806). The pull-free reads (`dm_inbox`, `dm_thread`, `dm_history`, `board_read`, a board resource's snapshot) carry the same `other_user`/`ungranted` fields per call, and every hosted session's instructions, poll, unbound and child ones included, say not to act on `ungranted` content without the user's approval (#825). Proof: `tests/integration/hosted_wake_grant.test.ts`, `tests/integration/hosted_read_marks.test.ts`, `src/server/hosted.test.ts` (bind result and initialize text).
- pi H, omp H: hosted-core's `wakes()` refuses an `ungranted` item whatever the actionable flag (adapters-hosted.md §Hosted core). Proof: `adapters/hosted-core/tests/channel.test.ts` ("an ungranted item never wakes…").
- OC V2: admits the item with `resume: item.actionable` (`adapters/opencode-v2/src/lifecycle.ts`), so it lands as context. Proof: the server half above; no host test sends a cross-user item.
- CC H: Claude Code wakes on any channel notification, so the plugin opens its lease with `context: false` and the server withholds a lone non-waking item, ungranted among them, until a waking one carries it (#854; adapters-hosted.md §Hosted Claude Code). Not a wake bound: a full page of 100 non-waking items still goes out, each item its own channel notification, so a sender who fills a page can still start turns. Proof: `tests/integration/hosted_context_off.test.ts`, `adapters/hosted-core/tests/controller.test.ts` ("context: false opens the lease…"); no Claude Code test sends a cross-user item.

### 19. Delegation to another user's launcher under a grant (`delegate.to`)

- Local (all four): n/a. Local mode is single-user (`vision.md` §1).
- Server side, every hosted cell: an explicit `to` naming another user's launcher is refused unless the two share a `delegating` team (delegation.md, #256); the launcher's reads and pull mark such a request `delegated` per call, and the launcher instruction acts on another user's request only with that mark. Proof: `tests/integration/delegation_grant.test.ts`.
- pi H, omp H, CC H: hosted-core's `channelParams` carries `delegated="true"` (`dmNotification`, `src/shared/notifications.ts`). Proof: `adapters/hosted-core/tests/channel.test.ts` ("channelParams carries the server's delegated mark…").
- OC V2: the item's JSON carries the field as the server sent it; no host test sends a cross-user delegation.

### 20. Runtime role bindings (`org_admin`, `team_owner`) and `grayboard admin role`

- Local (all four): n/a. Local mode is single-user (`vision.md` §1): there is no authorization model to grant into.
- Every hosted cell: server-side HTTP routes and the CLI, the same for every harness (server-access.md §1 Role bindings, #927); no MCP tool. Proof: `tests/integration/role_bindings.test.ts` (grant, revoke and list through the CLI against a server process; bootstrap admins; audit rows; `team_owner` scoping; stale authority), `tests/integration/authz_decision.test.ts`.

### 21. A service's agent signs in with a run token from a service credential (no browser)

- Local (all four): n/a. A service principal means something only with more than one principal (`vision.md` §1).
- The server side is built for every hosted cell (#270 step 3; `server-oauth.md` §2 Service credentials, `server-services.md` §1): an admin adds a credential, the launcher mints a run token with `client_credentials`, and any client that sends it as a bearer on `/mcp` with a mapped session key is the service. Proof: `tests/integration/service_credentials.test.ts` (against a compiled server process: the CLI's credential, a token with no browser, bind and post, revoke and disable ending the session).
- OC V2: supported by its static credential mode (#270 step 4; `adapters-hosted-login.md` §OpenCode V2 static mode): the launcher sets the mode, the pinned issuer and the native entry's bearer header from its environment, and a root enrolls itself only when the server's `whoami` reports a service. Proof: `adapters/opencode-v2/tests/static-host.ts` (`test:native-host`: a real OpenCode host and server, a token minted by `client_credentials`, two roots auto-enroll, bind, post and receive a push, in direct and code mode; revoke pauses both with no OAuth fallback, and no file holds the token), `adapters/opencode-v2/tests/static.test.ts`.
- pi H, omp H, CC H: supported by hosted core's static mode (#1243; `adapters-hosted-login.md` §Hosted core static mode): the launcher sets the mode, the pinned issuer, the run token and optionally the service in the environment; the pin and a keyless `whoami` (a service, the launcher's when named) are checked before the token is used, a 401 ends the run, and no sign-in surface runs. Proof: `tests/integration/hosted_core_static.test.ts` (against a real server: the environment rules, a pin on another origin or naming another issuer and a 4xx metadata refused with no request carrying the token, an outage not remembered, a person's or another service's token refused with no hosted session, a root bound as `ingest/w-1` under the `svc_` client receiving a push, a revoke pausing it with no retry or token request, a revoke at a restore's resume ending the run through its 401 with the token spent and the root paused, a revoke landing after the restore's rebind or a `BUS_IDENTITY` bind was admitted drawing the server's 401 (the root paused `login_required`, the token spent; a person's grant at the same point signs the store out) while a server stopping there ends nothing, a stored grant byte-identical, no file holding the token), `tests/integration/pi.test.ts` and `tests/integration/omp.test.ts` (`hostedStaticScenario`: the real harness binds its `BUS_IDENTITY` name, a DM from the service's other session starts a turn whose reply goes out as the service, a subagent (pi's detached runner, omp's task subagent) inheriting the run token registers as a child under the `svc_` root, writes as the service's name and ends with its run, status names the static run, `/grayboard login` and `logout` refuse, a revoke ends the run with no sign-in offer, browser or token request), `tests/integration/claude_plugin.test.ts` (static mode: lease with no prompt or link, revoke, the dotenv and project-settings refusals, the logout command leaving a grant untouched), `tests/e2e/claude_hosted.e2e.ts` (the real Claude Code: a lease as the service with no prompt or link, a revoke answering the next call with the new-run text). Open: the session's harness label shows `svc_…` (#1298), and `BUS_LAUNCHER` is ignored for a service session (#1299); OC V2's variables differ from hosted core's (#1300).

### 22. Invoke a service by posting on its board under a `service_invoke` grant; the service's reply wakes the invoker

- Local (all four): n/a. A grant means something only with more than one principal (`vision.md` §1).
- Every hosted cell: server-side, through the shared `board_post` and `claim_take` and the pull's writer marks, the same for every harness (#270 step 5; `server-services.md` §2, `boards.md` §3 Service boards). The service's own side needs its run token (row 21). Proof: `tests/integration/service_invoke.test.ts` (hosted-core wire sessions: one service lane, actionable; the reply wakes a direct and a team holder; a team-bound session, a non-holder and a removed member refused as a missing board with deny rows; no invoker lane on rotation, decline or mention; `ungranted` after a revoke; hidden on every listing and read), `tests/integration/role_bindings.test.ts` (the CLI grants a team).
