# The factory module

```doc-meta
owns: the opt-in factory module (orchestration outside the core): boundary, how it reaches the bus, request authority, headless spawn, its store
invariants: the module imports nothing in the repo beyond itself and adapters/hosted-core/src/client.ts, and nothing in src/ or adapters/hosted-core/src/ imports it; it reaches the bus only through grayboard's public surface (a `grayboard mcp` child and the MCP tools); it acts on a delegation only when the channel sender is the payload's requester; one request key (source, id) spawns at most once, across restarts; a run cut by a crash is reported interrupted, never re-run; children never share its push channel, inherit no harness session, and read none of the operator's settings, hooks or MCP servers; its store keeps its own retention and never writes to boards; it is a queue lane only on its configured fleets' boards, and a fleet task's agent comes from the config, never the post; a fan-out's plan is parsed by the module's code, its board is broadcast, and a subtask never fans out again
code-pointers: adapters/factory/, scripts/check_factory_isolation.ts, src/core/delegation.ts (the payload it parses), tests/integration/factory.test.ts
companions: boards.md (principle 7, §3, §9, §13), architecture.md §Hosted MCP, guide/local.md (running it)
```

## 1. Why it exists

Principle 7 (`boards.md` §1, #288) keeps the core to addresses, mailboxes, boards, claims and presence. Users without an orchestrator still want a process that takes delegated work and runs it with no harness UI open. The factory is that process, in this repo but isolated (#293): an opt-in module that coordinates *through* grayboard as an outside orchestrator would, so moving it out later is mechanical. Design credit: the #293 series (#300, #309, #313, #314, #320, #321) gave the `FactoryBus` seam, the delegation parser and the roster design.

## 2. The boundary

- Lives in `adapters/factory/`, entry `main.ts`. Nothing in the default install, build or release references it; it starts only when its entry is run.
- `scripts/check_factory_isolation.ts` (run by `tests/integration/factory_isolation.test.ts`) refuses both directions: `src/` or `adapters/hosted-core/src/` importing the module, and the module importing any repo file beyond itself and `adapters/hosted-core/src/client.ts` (#282 decision A7). npm packages aren't repo files, so the MCP SDK is allowed.
- No core tables, tools or instruction text. A missing hook is answered by a core event or an opaque reference (principle 7), never a core feature.

## 3. How it reaches the bus

The module is its own session's harness, as the local Slack bridge is (`src/bridge/slack.ts`): it spawns `grayboard mcp --mode local` with `BUS_IDENTITY` and `BUS_LAUNCHER=1`, push on, and drives it over stdio with the MCP SDK client. Deliveries arrive as `notifications/claude/channel`; everything else is a tool call. `whoami` must report the configured name as primary, else it refuses to start: a second factory on a live name would start unbound and receive nothing (`boards.md` §3, one live session per name).

- **The child env is session-free** (`sessionFree`, `adapters/factory/bus.ts`). A factory started from a shell inside Claude Code inherits `CLAUDECODE` and its session ID; passed on, `grayboard mcp` takes the factory for a Claude Code child and holds every push for a hook record no one writes. Bus identity variables (`BUS_IDENTITY`, `BUS_HARNESS_SESSION`…) are stripped too; the bus's own settings (`BUS_DB_PATH`, `BUS_SOCK_DIR`) stay. Spawned workers get the same env, so a worker's own grayboard session starts unbound instead of contesting the factory's name.
- **Why not `HostedClient`:** A7's allowlisted client gives hosted tool calls only. Its sign-in and push delivery (`root.ts`, `controller.ts`) aren't importable, so a factory on it alone would be poll-only. Push is principle 3.
- **Local mode only.** `grayboard mcp` is local on every machine (#282). A hosted factory needs push through the server's lease protocol; whether that is an allowlist widening to hosted-core's root delivery or a module-side client is an open decision for its own PR.
- `FactoryBus` (`adapters/factory/bus.ts`) is the one seam feature code sees: tool calls plus an async stream of deliveries. A hosted or broker implementation slots in behind it.
- The child's lifetime is the factory's: when it exits, the factory exits non-zero for a supervisor to restart both (SIGINT/SIGTERM exit 0). The child's restart semantics (name take-back, replay of unconsumed mail) and the store (§6) do the recovery.

## 4. Request authority

This section covers delegations; a fleet task's authority is the board's (§7). A delegation DM's header and fenced payload are text any sender can write (`boards.md` §13: never authority). The module acts on a delivery only when all hold (`requestOf`, `adapters/factory/delegate.ts`):

- It is a DM (channel meta carries `message_id` and `from`, no `board`).
- The body parses as a delegation: the header, then the four-backtick fenced JSON block `delegationBody` builds, with non-empty `requester`, `persona` and `task`. The core's parser isn't on the allowlist, so the module reads the bytes itself.
- The channel `from` equals the payload's `requester`. Anything else is logged and never answered, so a delegation can't make the module send text to a third party.

Locally every handle is the same OS user, so the core's same-user rule is implied. A hosted factory adds the user check through the identity the server reports.

## 5. Spawning

A request's key is its source and id: the bus message id for a DM, the post id for a board post (separate sequences). The module records it in its store before anything else, so a redelivered key (a restart, a replay) spawns nothing. It replies `[factory] taken: …` in the thread at once (`boards.md` §13's launcher contract), naming the agent and whether it starts now or queues, then `[factory] done: …` or `[factory] failed: …` when the child ends. Replies go where the request came from, in its thread (a DM to its sender, a post in its board thread), clipped under the body cap.

- **Persona → roster entry** (`resolvePersona`, `adapters/factory/runner.ts`): exact name, then article-stripped, then whole word, then substring; the longest name wins a rung. No match is `[factory] declined: …` naming the roster, so the requester can re-delegate. Model and effort come from the agent file, never the payload (§13's persona rule).
- **Claude Code** (`adapters/factory/claude/runner.ts`): `claude -p --restricted --strict-mcp-config --agents <json> --agent <name> --output-format json --permission-prompts none`, plus `--tools` and `--allowedTools` from config. The prompt (task, then context) goes on stdin, never argv, so a task starting with `-` isn't a flag. `--permission-prompts none` denies any prompt nothing would answer, so an unattended child can't hang on one. The roster is Claude Code's own: `$CLAUDE_CONFIG_DIR/agents` (or `~/.claude/agents`), then the working directory's `.claude/agents`, which wins on a name. The module reads the file and passes the agent inline, with only its body, `description`, `tools` (a comma list) and `model`: restricted mode hides file agents, and a field like `permissionMode` never reaches the child. pi, OpenCode and Cursor runners implement the same `Runner` interface (#243, #266, #265).
- **Children are unattended code with tools, and the operator's settings don't reach them.** Without `--restricted`, a user `settings.json` rule allowing `Bash` lets a headless child run the shell (measured on the pinned Claude Code, `tests/integration/factory.test.ts`). Restricted mode ignores user, project and local settings files (allow rules, hooks), drops the shell and WebFetch unless `--tools` names them, and confines the file tools to the working directory; `--strict-mcp-config` drops every MCP server. Managed settings still apply. The config's `tools` sets what a child has (absent: restricted mode's default) and `allowedTools` what runs without a prompt (default none); a shell needs `Bash` in both. The factory acts on any delegation its own user's sessions send.
- **Bus capability (§13).** A child holds no bus connection: the module relays its result, which §13 counts as the parent relaying.
- Concurrency is capped by config; requests over the cap wait in the store in arrival order. Each child runs in its own process group with a timeout; on expiry or shutdown the group is killed and the thread gets the failure.

## 6. The store

SQLite in the module's data directory (`FACTORY_DATA_DIR`, default `~/.grayboard-factory`), separate from the bus database. It keeps what a restart needs: each request's key, reply route and state and, once finished, the reply text until it's sent. A store an earlier factory wrote gets newer columns by guarded `ALTER TABLE` at open. At start, a request left running finishes as interrupted (re-running it unasked could repeat side effects the dead child already had), and so does a fanned-out request waiting on its subtasks, with its subtasks still queued (§7); unsent replies are resent; the resend repeats hourly. Replied rows are pruned past the retention, default 30 days: the key must outlive any replay of its message.

## 7. Fleets

A fleet is a queue board, `<name>-tasks`, on which the factory is one lane, with the agent it runs every task with: config `fleets: [{"name": "sim", "agent": "researcher"}]`. Anyone who can see the board posts a task with plain `board_post`, and the core's rotation (`boards.md`, queue boards) hands each top-level post to exactly one lane. Interactive sessions that subscribe are lanes too.

- **Sync at start** (`syncFleets`, `adapters/factory/factory.ts`): a missing board is created as `kind: "queue"`; an existing queue board is subscribed in push mode; a fleet whose board exists as a broadcast board is refused with a log line (every post there would read as a task). Any other queue board the factory is a lane on is left: a lane that ignores its deliveries holds each claim for the full TTL.
- **A task** is a top-level post on a joined board, delivered by the rotation or by an @mention. Replies in its thread are its conversation, not tasks. The requester is the poster; locally every handle is the same OS user, as with a delegation. The agent is the fleet's, never resolved from the post's text.
- **The `taken` reply acks the claim** (a queue reply by the holder releases it), so the 30-minute TTL never redelivers a running task; a crash mid-run is reported interrupted (§6), as for a delegation. The store's `(source, id)` key (post ids are one sequence across boards) makes a redelivery spawn nothing.
- **No agent:** a task from the rotation is passed on with `claim_release`, which offers it to the next lane; an @mention holds no claim, so its poster gets `[factory] declined: …`.
- Replies go in the post's thread with `board_post`, so they wake the poster and the thread's participants.

**Fan-out.** The model judges; the module's code orchestrates. A fleet task's run gets one more instruction: when the task splits into 2 to `maxSubtasks` (default 5) independent parts better run in parallel, reply with only a plan, a four-backtick block with the info string `factory-plan` holding `{"subtasks": [{"title", "task"}]}`; otherwise do the task. Most tasks are done in that one run, so a simple task costs one run and no board. A fleet with `"fanout": false` never gets the instruction.

- **A plan** (`parsePlan`, `adapters/factory/fanout.ts`) opens a broadcast board `task-<post id>` and posts each subtask there, then says so in the task's thread. The board is the durable, visible record: anyone may read, subscribe or comment. It isn't a queue: the core never hands a poster its own post (`queueLanes`, #284), so a queue the factory posts on could never reach the factory. Each subtask runs here, on the worker pool, as the fleet's agent with no fan-out instruction (a subtask never fans out again), and its outcome goes in its thread.
- **Synthesis:** once every subtask has an outcome, done or failed, the fleet's agent runs once more on the original task with each outcome (the first 16K characters of each), and its answer goes in the original thread.
- **An unusable plan** (bad JSON, a count outside 2 to `maxSubtasks`, an empty field) fails the task with the reason; nothing is posted. The store admits the subtasks and marks the task waiting in one transaction, after every post landed, so a crash leaves both or neither.
- A plan is the whole reply: one that only quotes a plan block (documenting the format, say) is an answer. A subtask over 60 KiB fails the plan before anything is posted. If `task-<post id>` already exists, the factory tries `-2` and `-3` after it.
- Task boards stay: the core has no board archive or delete.
- **Mentions:** a fleet's replies and subtask posts carry model output, which a poster can steer, and an `@handle` in them wakes that handle as from the factory. Locally every handle is the same OS user, so this reaches no one the poster couldn't mention directly; a hosted factory must neutralise mentions first.

## 8. Not built

- Hosted mode (§3).
- A fleet roster (#320's design): membership and presence from `peer_list`, status posts only on change. The shared-name design stays refused (`boards.md` §3).
- Other lanes taking a fan-out's subtasks. It needs the factory's orchestrator on a second bus session, so the rotation can hand its posts to the factory's worker lane or any other (#636).
- Retiring task boards once their synthesis is replied: the core has no board lifecycle (#635).
- Capability-aware launcher selection (#245) and queue routing of delegation (#242): auto-pick stays the core's first live launcher.
