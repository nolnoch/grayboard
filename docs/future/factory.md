# The factory module

```doc-meta
owns: the opt-in factory module (orchestration and memory outside the core): boundary, bus contract, layout, enable path, test harness
invariants: the module imports nothing from src/ beyond the published client and protocol types, and nothing in src/ imports it; every bus interaction flows through the FactoryBus contract, which is message-shaped and transport-free; one live session per name and one delivery owner per handle hold for anything it spawns; the module's stores keep their own retention and never write to boards
code-pointers: adapters/factory/ (when built), src/plugin/client.ts (the published client it builds against)
companions: boards.md (principle 7, §13 delegation, §3, §9 — the boundaries this module must not cross)
trigger: being built under #293
last-verified: 2026-10-25
```

## 1. Why it exists

Principle 7 (`docs/boards.md` §1, #288) keeps the core to addresses, mailboxes, boards, claims and presence. Users without a separate orchestrator still want orchestration: spawning specialists, routing by capability, keeping fleet rosters and long-term memory. The factory is that orchestrator, in-repo but isolated — an opt-in module that coordinates *through* grayboard like any outside orchestrator would (#293). Because it is held to the public surface, porting it out to a real orchestrator later is mechanical.

## 2. The boundary

- The module lives in `adapters/factory/`. The default install excludes it; enabling it is an explicit step.
- It builds only against grayboard's public surface: the MCP tools and the bus protocol — the same contract an outside orchestrator would use. It imports nothing from `src/` beyond the published client and protocol types.
- CI refuses both directions: anything under `src/` importing `adapters/factory/`, and the module importing `src/` beyond the allowlist.
- It adds no core tables, tools or instruction text. If it needs a hook the core doesn't have, the answer is an event or an opaque reference from the core (principle 7's existing treatment of orchestrators), never a core feature.
- `docs/boards.md` §3 (one live session per name) and §9 (one delivery owner per handle) hold for everything it spawns.

## 3. The FactoryBus contract

Every bus interaction the module performs goes through one interface, `FactoryBus`. Feature code never touches the client directly.

The contract is deliberately message-shaped, not transport-shaped, so a broker adapter can sit between the module and grayboard later without reworking the module:

- Operations are request/response pairs plus an async stream of event envelopes (an envelope is a subject, a payload, and a reply handle), matching how a stream broker (e.g. a JetStream-style filter shared by many services) would deliver them. No vocabulary that assumes a socket, a frame, or a hello.
- Identity on the contract is a handle string plus a capabilities map, never a connection object.
- Every outbound operation carries a caller-supplied idempotency key; duplicate delivery is the caller's reality, not an error.

The in-repo implementation wraps the published client (`src/plugin/client.ts`) one adapter deep. The broker adapter itself — subject naming, broker auth, stream topology — is out of scope here and must not be designed by implication: the contract's only job is to not foreclose it.

## 4. Layout and enable path

- `adapters/factory/` holds the module: the `FactoryBus` contract and its in-repo implementation, the per-harness spawn translators, the fleet roster, and the module's own store.
- Opt-in: a separate build/install step produces the module's entry; nothing in the default `grayboard` install references it.

## 5. How it reaches the bus

The factory is an ordinary session from the core's point of view: a launcher identity (`BUS_LAUNCHER=1`, §13) whose process runs the module instead of a harness UI. Delegation requests arrive through the unchanged core path — explicit `to`, or auto-pick, which stays "the first live launcher of the requester's user" (#246's ruling; smarter selection lives module-side). The module resolves the persona to a harness spawn and manages the resulting child as a bus participant per §9.

## 6. Spawn translators

A translator maps the harness-neutral delegation payload (persona + task brief) to the harness's native spawn surface. One per harness, each small:

- **pi:** render the native `subagent` invocation into the delivered request (the #268 approach, re-homed from `adapters/pi/` into the module); the child can hold its own bus connection (#267's path).
- **Claude Code:** render the `Agent` tool invocation (roster from the user's `.claude/agents`); a child needing its own bus connection spawns headless instead.
- **OpenCode:** render the `Task` invocation; a child needing its own connection runs as a server session.

A launcher whose harness has no translator declines, and the request rotates on (#242) or falls to the human (§13's degrade).

## 7. Fleet roster (#124's rescoped shape)

A fleet is a set of distinct task names the module manages as one unit: roster state lives in the module's own store, membership is explicit, and work spreads across the roster through public claims and queue boards (#131). The shared-name design stays refused (§3) — nothing here lets two live sessions share a name.

## 8. What this spec does not build now

- The broker adapter for the FactoryBus contract (§3 keeps the seam open; designing the broker itself is a separate future decision).
- The scoped-memory store (#108 moves here and keeps its own retention — never boards) and capability-aware selection (#245 moves here): both are module features with their own PRs after the skeleton lands.
- Cursor's translator (#266) follows the same pattern when a Cursor harness is available to test against.
