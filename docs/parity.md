# Parity matrix

```doc-meta
owns: capability parity across harnesses and modes: per harness × mode cell, supported, gap (issue) or n/a (reason), and where it is proven
invariants: parity by addition (a cell becomes supported without taking anything from another cell); a feature or fix PR names the cells it changes; a gap cell links an issue or says unfiled; mechanisms stay in their owner docs, this doc holds status, reasons and proof
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

## Evidence by row

Rows 1–8: `parity-delivery.md`. Rows 9–16: `parity-access.md`. Rows 17–19: §Not covered.

## Notes (known limits, not cells)

- #559 items 2–6: omp L robustness edges (no abort or timeout while a call waits for the process, wrapper scripts not recognised, ACP with on-disk MCP config, advisor calls, Windows).
- #489: hosted presence and `whoami` items (an unbound native session lists itself twice in `unbound_sessions`; local `whoami` says `aliases` where hosted says `held`).
- OC V1: N root sessions in one opencode process share one binding (adapters.md §opencode).
- On a signed-in machine, `refresh-adapters` keeps the V1 opencode entry, which serves the local bus, and prints the `setup-opencode` command that reaches the server, with the URL's credentials stripped (#474); the entry's `grayboard mcp` already says on stderr that it serves the local bus (#491). Proof: `src/cli/opencode-setup.test.ts` ("(#474)").
- #475: an ID whose session ended comes back differently per mode, on purpose: hosted reopens its row (the ID is the harness's own and can't change), local refuses it `id_collision` (`registerId`).
- #427: pi's `pi update --extensions` doesn't refresh the loose-file adapter; only `grayboard update` does.

## Maintaining parity

- A feature or fix PR names the cells it changes (row number and column) and updates this doc in the same change.
- A new capability lands in every applicable cell, or files a gap issue per cell it leaves and adds the row with those gap cells. An n/a cell states why the capability can't apply. Local mode is the single-user edition (`vision.md` §1): a capability that only means something with more than one principal (roles, grants, service principals, cross-user policy) is n/a in every local cell, not a gap.
- Parity by addition: moving a cell to supported never removes a capability from another cell.

## Not covered

Harnesses without an adapter (any MCP client run with `BUS_PUSH=off`, tools only) and the Slack bridges themselves (slack-bridge.md) have no columns.

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
