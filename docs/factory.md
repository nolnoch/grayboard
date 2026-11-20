# The factory module

```doc-meta
owns: the opt-in factory module (orchestration outside the core): boundary, how it reaches the bus, request authority, its store, asking, limits
invariants: the module imports nothing in the repo beyond itself and adapters/hosted-core/src/client.ts, and nothing in src/ or adapters/hosted-core/src/ imports it; it reaches the bus only through grayboard's public surface (a `grayboard mcp` child and the MCP tools); it acts on a delegation only when the channel sender is the payload's requester; a run cut by a crash is reported interrupted, never re-run; a run's transcript is the operator's only (0600) and goes once its run's row has; its store keeps its own retention and never writes to boards; a parked question is answered only by the requester or your user, holds no worker slot, and never parks forever
code-pointers: adapters/factory/, scripts/check_factory_isolation.ts, src/core/delegation.ts (the payload it parses), tests/integration/factory.test.ts, tests/e2e/factory_claude.e2e.ts (e2e `claude-local`)
companions: factory-children.md (spawning, workdirs, thread commands, bus tools), factory-fleets.md (fleets, fan-out, projects, reload), vision.md (principle 7, §1 sidecar), handles.md, child-sessions.md, adapters.md, delegation.md, server-hosted-mcp.md, guide/local.md (running it)
```

## 1. Why it exists

Principle 7 (`vision.md`, #288) keeps the core to addresses, mailboxes, boards, claims and presence. Users without an orchestrator still want a process that takes delegated work and runs it with no harness UI open. The factory is that process, in this repo but isolated (#293): an opt-in module that coordinates *through* grayboard as an outside orchestrator would, so moving it out later is mechanical. Design credit: the #293 series (#300, #309, #313, #314, #320, #321) gave the `FactoryBus` seam, the delegation parser and the roster design.

## 2. The boundary

- Lives in `adapters/factory/`, entry `main.ts`. Nothing in the default install, build or release references it; it starts only when its entry is run.
- `scripts/check_factory_isolation.ts` (run by `tests/integration/factory_isolation.test.ts`) refuses both directions: `src/` or `adapters/hosted-core/src/` importing the module, and the module importing any repo file beyond itself and `adapters/hosted-core/src/client.ts` (#282 decision A7). npm packages aren't repo files, so the MCP SDK is allowed.
- No core tables, tools or instruction text. A missing hook is answered by a core event or an opaque reference (principle 7), never a core feature.

## 3. How it reaches the bus

The module is its own session's harness, as the local Slack bridge is (`src/bridge/slack.ts`): it spawns `grayboard mcp --mode local` with `BUS_IDENTITY` and `BUS_LAUNCHER=1`, push on, and drives it over stdio with the MCP SDK client. Deliveries arrive as `notifications/claude/channel`; everything else is a tool call. `whoami` must report the configured name as primary, else it refuses to start: a second factory on a live name would start unbound and receive nothing (`handles.md` §1, one live session per name).

- **The child env is session-free** (`sessionFree`, `adapters/factory/bus.ts`). A factory started from a shell inside Claude Code inherits `CLAUDECODE` and its session ID; passed on, a `grayboard mcp` that can't read the process table (`claudeIsHarness` unknown, `child-sessions.md` §Claude Code children) takes the factory for a Claude Code child and holds every push for a hook record no one writes. Bus identity variables (`BUS_IDENTITY`, `BUS_HARNESS_SESSION`…) are stripped too; the bus's own settings (`BUS_DB_PATH`, `BUS_SOCK_DIR`) stay. Spawned workers get the same env and no MCP servers (`--strict-mcp-config`, `factory-children.md` §1) but, with `busTools` on, the factory's relay (`factory-children.md` §2), which is not a session; so a worker holds no bus session at all and can't contest the factory's name.
- **Why not `HostedClient`:** A7's allowlisted client gives hosted tool calls only. Its sign-in and push delivery (`root.ts`, `controller.ts`) aren't importable, so a factory on it alone would be poll-only. Push is principle 3.
- **Local mode only.** `grayboard mcp` is local on every machine (#282). A hosted factory needs push through the server's lease protocol; whether that is an allowlist widening to hosted-core's root delivery or a module-side client is an open decision for its own PR.
- `FactoryBus` (`adapters/factory/bus.ts`) is the one seam feature code sees: tool calls plus an async stream of deliveries. A hosted or broker implementation slots in behind it.
- The child's lifetime is the factory's: when it exits, the factory exits non-zero for a supervisor to restart both (SIGINT/SIGTERM exit 0). The child's restart semantics (name take-back, replay of unconsumed mail) and the store (§5) do the recovery.

## 4. Request authority

This section covers delegations; a fleet task's authority is the board's (`factory-fleets.md`). A delegation DM's header and fenced payload are text any sender can write (`delegation.md`: never authority). The module acts on a delivery only when all hold (`requestOf`, `adapters/factory/delegate.ts`):

- It is a DM (channel meta carries `message_id` and `from`, no `board`).
- The body parses as a delegation: the header, then the four-backtick fenced JSON block `delegationBody` builds, with non-empty `requester`, `persona` and `task`. The core's parser isn't on the allowlist, so the module reads the bytes itself.
- The channel `from` equals the payload's `requester`. Anything else is logged and never answered, so a delegation can't make the module send text to a third party.

Locally every handle is the same OS user, so the core's same-user rule is implied. A hosted factory adds the user check through the identity the server reports.

## 5. The store

SQLite in the module's data directory (`FACTORY_DATA_DIR`, default `~/.grayboard-factory`), separate from the bus database. It keeps what a restart needs: each request's key, reply route and state and, once finished, the reply text until it's sent. A store an earlier factory wrote gets newer columns by guarded `ALTER TABLE` at open. At start, a request left running finishes as interrupted (re-running it unasked could repeat side effects the dead child already had); nothing else is lost (#642). A fanned-out request stays waiting and its queued subtasks, which never started, run as before; a subtask that was running counts as finished, interrupted, so its task still synthesizes, with the interruption among the results (`factory-fleets.md`). Unsent replies are resent; the resend repeats hourly. Replied rows are pruned past the retention, default 30 days: the key must outlive any replay of its message. After each prune, any tree under `trees/` whose request's row is gone is removed, worktrees included (`git worktree prune` in their repository), so a directory never outlives its record and a crash between the two leaves only a directory the next pass removes.

**Runs and transcripts** (#649). Each child is a `runs` row (a fanned-out request has its triage's and each review's): agent, start and end, exit code, outcome (`ok`, `failed`, `timeout`, `budget`, `interrupted`, `cancelled`, `deadline`), its grant (`granted_usd`, §7) and, from its final event, session id, turns and cost. A row left open at start ends as `interrupted`. Cost is the run's own: a resumed run's final event reports its session's running total (measured on the pinned Claude Code), so the runner subtracts what the session's earlier runs cost (§6). Its stream goes to `runs/<run id>.jsonl` as it arrives, one file per run, a resume's included; a request's runs are deleted in the same transaction as the request, and a transcript whose row is gone is removed in the same pass as trees. A transcript holds whatever the child read and wrote, so the data directory is 0700 and each transcript 0600, set at open whatever the umask.

**Questions** (#652). An asking row keeps its question, whether it's addressed to your user, when it was asked and escalated, the answer that resumes it, and the count of questions it asked (`question`, `ask_human`, `asked_at`, `escalated_at`, `answer`, `asks`), all added by guarded `ALTER`.

**Claims** (#669). `claims` holds each tree claim (tree, key, holder, note, taken at, and the bus key when mirrored, `factory-children.md` §2); liveness comes from the holder's row (`factory-children.md` §2), and a prune removes claims whose holder is gone.

**Progress** (#669). A request row's latest progress note and when it came (`progress`, `progress_at`, `factory-children.md` §2), added by guarded `ALTER`; cleared when the row starts a fresh run.

**Threads and commands** (#651). `threads` maps the id of each reply the factory sent to its request's row, so a thread command finds its request; `commands` holds each command's key once it has acted. Both are deleted with their request.

## 6. Asking

A run that can't finish without a fact or decision only a person can give ends with a question instead of a guess (#652, `adapters/factory/ask.ts`). The model decides to ask; code parks, routes and resumes.

- **Format.** Every run but a resume gets one more instruction: reply with only a four-backtick block, info string `factory-ask`, holding `{"question": "…"}`, plus `"to": "human"` for a decision only your user can make. As with a plan (`factory-fleets.md`), the block is the whole reply, so an answer that quotes one is an answer. An unusable block (bad JSON, no question, over 8 KiB, another `to`) fails the run with the reason.
- **Park.** The row goes to `asking` and holds no worker slot. The question goes in the request's thread, a subtask's in its root request's thread (the one the requester watches), as a reply the store maps to the asking row (§5), so a reply to it finds that row. `"to": "human"` also sends it to your user at once; a send that fails is retried on the next clock check.
- **Who answers.** A free-text reply from the requester or your user (`human="true"`); anyone else's is chatter, as with thread commands (`factory-children.md` §1), which still take precedence. A reply to the question (in the thread, or to the DM your user got) answers that row; one elsewhere in the thread answers the tree's only open question, and with several open the factory asks which. A reply to a question that has since closed (answered, given up, cancelled) gets `that question is already closed`, so it isn't silently dropped. Your user's thread commands work in the DM that sent them a question, acting on its request.
- **Resume.** The answer queues the row; its next run is `--resume <session id>` (the last run's) with the answer as the prompt, so the conversation keeps its context and its directory. With no session id recorded, a fresh run gets the task, the question and the answer. A resumed run is a new run row and a new transcript, with the full timeout and budget, under the settings as they are then.
- **Clocks** (config `askEscalateMs`, `askGiveUpMs`, default 1 h and 24 h, checked every 30 s). Unanswered past the first, the question goes to your user once by DM; it's stamped escalated only when the DM went, so a failed send is retried at the next check. Unanswered for the second after that, the run resumes with "no one answered; use your judgement or fail saying what you needed". Both are measured from the stored `asked_at` and `escalated_at` against the config at check time, so a reload changes pending clocks. Your user is a declared human (`grayboard human`): only their replies carry `human="true"`, so only theirs can answer. Config `human` picks which declared handle when there are several; one that isn't declared is logged and the first in the bus's "Humans on this bus" line is used instead. With no declared human, the escalation is only logged and the give-up clock still runs, so no question parks forever.
- **Cap** (`maxAsks`, default 3, per request tree). A question past it isn't parked: the run resumes told to decide; asking again after that fails it. The cap stops a model from turning every step into a question that holds a person hostage.
- **Commands and restart.** `cancel` on an asking row finishes it without a run; `status` shows the question and how long it has waited; `retry` refuses until it's cancelled. An asking row survives a restart as it is (it has no child to interrupt) and its clocks go on from the stored times.

## 7. Limits

Spend and time caps over a whole request tree and over a day (#655), decided in code at each run's start, never asked of a model. Config only: `treeBudgetUsd`, `dailyBudgetUsd`, `deadlineMs` and `maxRounds` (`factory-fleets.md`), each on the top level, a fleet or a project; none is set by default, and `maxRounds` is 1. A fleet's tree budget, deadline and `maxRounds` replace the global ones for its tasks. Day caps stack: the global one counts every run the factory starts, a fleet's only its own board's tasks and their subtasks.

- **Grant.** Each run's `--max-budget-usd` is the least of its per-run `budgetUsd` (`factory-children.md` §1), each day cap's remainder and the tree's remainder over its stages left. A subtask's stages are itself, its queued or asking siblings and the synthesis, so parallel subtasks split the remainder and the synthesis keeps a share; a review that may plan again (`factory-fleets.md`) gets a quarter, leaving the rest for its round (at least two subtasks) and the review after it; a triage, last review or delegation run is one stage, so a triage may spend the whole tree's budget. Claude Code checks its cap after each turn, so each run, and with it the tree and the day, can pass a cap by up to one turn.
- **What counts as spent.** A run's reported cost, or its grant while it runs and when it ended without reporting one (killed, crashed): a run that dies mid-turn is charged everything it was allowed, never nothing. Open grants count, so concurrent runs can't jointly overspend.
- **A spent tree** (its remainder per stage under $0.01) stops the tree through cancel's path (`factory-children.md` §1, `stopTree`): queued and asking members finish, running ones are killed and recorded `budget`, nothing is combined; the request's thread names the cap and, when it fanned out, the work board holding the finished subtasks' outcomes and the tree's post ids there (#668).
- **A spent day** holds work instead of failing it: a held row stays queued, `taken` and `status` say whose budget is spent and about when it frees, and `peer_status` adds `(K held: daily budget spent)`. The window is the last 24 hours of run starts, rechecked at each question tick (§6, 30 s). Pruning it early would undercount, so the config refuses a day cap with `retentionMs` under a day (a reload too, against the running retention, which takes a restart). A day cap alone serializes its scope: with no `budgetUsd`, a run is granted the day's whole remainder and everything else waits until it reports what it spent. Pair a day cap with a per-run `budgetUsd`.
- **Deadline**, measured from the request's admission. A run's timeout is clamped to it; it's checked when a run would start, at each question tick (so trees parked on a question or held stop too) and at the factory's start (one that expired while it was down). Past it the tree stops as above, recorded `deadline`. A deadline shorter than `askEscalateMs` plus `askGiveUpMs` cuts off the give-up resume.
- **Reload.** Limits are read from the config at each decision, so a reload applies to runs not yet started, and to trees and holds already open.

## 8. Not built

- Hosted mode (§3).
- A fleet roster (#320's design): membership and presence from `peer_list`, status posts only on change. The shared-name design stays refused (`handles.md` §1).
- Other lanes taking part in a factory's work. The factory is a self-contained swarm: no outside lane takes from its queue. A first build (#636) was removed before release; the design comes first (#685), with the build archived on branch `archive/636-shared-subtasks`.
- Fleet-sized work routing (#684).
- Publishing a result (push, PR) on a person's OK (#689). A sensitive-action list gating a child's own tools (#659) is refused: `factory-children.md` §1 Outside effects.
- Capability-aware launcher selection (#245) and queue routing of delegation (#242): auto-pick stays the core's first live launcher.
