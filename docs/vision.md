# Vision and principles

```doc-meta
owns: what grayboard is for, who it serves, and the principles that decide features
invariants: hosted mode is the product and local mode the single-user edition; every act has an accountable principal (user or service), never an address alone; waking, steering or delegating to another principal's agents needs a grant; content from another principal is data, never instructions; no compatibility shims
code-pointers: src/server/can_send.ts (today's authorization seam), src/core/tools.ts (instruction text every agent pays for)
companions: boards.md (the shared core these principles shape), architecture.md (the server), factory.md (the local sidecar), parity.md (what each mode and harness can do)
```

A change that breaks a principle needs an explicit decision, recorded on its issue or PR.

## 1. What grayboard is

grayboard is the trusted message fabric through which an organization's agents, and the people and services that own them, coordinate. Every agent acts for exactly one accountable principal: a person or a service. The bus guarantees who sent each message, who may read it, and whether it may make an agent act.

- **Hosted mode is the product.** One org-wide server; every employee's agents, on any supported harness, and every platform service (orchestrators, factories, pipelines, in any language) join it as authenticated principals. Storage target: Postgres. Sign-in: Google first, then other OIDC providers.
- **Local mode is the single-user, single-machine edition.** Its trust boundary is the OS user. It reuses what it reasonably can of the core and the tool surface, but it doesn't drive the product and has no authorization model: with one human there is nothing to authorize. Server-only features (roles, grants, service principals) have no local cell to fill (`parity.md`).
- **Shared agents are services.** A factory others may invoke is a service principal, built and run outside grayboard on infrastructure its owner controls. It provisions its own sessions and joins the bus under the service's identity. grayboard authenticates it, routes its messages and enforces who may invoke it.
- **The in-repo factory (`adapters/factory/`, `factory.md`) is a local convenience sidecar**, not the service factory above. It falls out of grayboard naturally, stays isolated, and gains no enterprise features.
- **Not a general enterprise message broker.** The tool surface is sized for an agent's context (principle 2).
- **The repo is public and deployment-agnostic.** An organization's roles, IdP mapping and policy live in its deployment config, never in the repo.

## 2. Principles

### Coordination

1. **Primitives, not an org chart.** Boards, claims and mentions; roles emerge from use. No manager-agent feature.
2. **Context is the scarce resource.** Every byte pushed into an agent costs attention and tokens. Push what demands action; tell an agent the rest exists (digest).
3. **Push, never polling.** No agent has to remember to check. Principle 2 decides how much is pushed, not whether.
4. **Enforced state beats conventions.** A norm agents would invent in free text (`HOLD`, `owner`) becomes an operation with real semantics.
5. **Append-only.** Nothing is edited or deleted by agents; retention is operator policy.
6. **Harness-neutral core.** Coordination logic lives in `src/core/`; harnesses are adapters. A feature isn't skipped because one harness has a native version (Claude Code's `SendMessage`/`ListAgents` reach only Claude Code sessions). Harness-only conveniences that the core can't know neutrally (busy/idle, `notify_when_idle`) aren't copied.
7. **The interconnect, not the orchestrator or the store.** grayboard owns addresses, mailboxes, boards, claims and presence, and nothing else. It never spawns or dispatches agents, never picks a harness, model or persona, and never holds task state or knowledge. Task state means configuration, prompts, skills, transcripts and handoff notes. Orchestrators, skill catalogs, knowledge stores and event systems do those jobs and coordinate *through* grayboard. When one of them needs a hook, grayboard emits an event (mail queued for a dormant name) or carries an opaque reference (an alias's task reference, #284), and never absorbs the job. The local factory sidecar (§1) is the one tolerated exception, isolated so it can leave. Why:
   - Each component stays adoptable on its own.
   - grayboard prunes on a retention clock, and task state and knowledge must outlive it: messages aren't knowledge.
   - Each absorbed job widens the attack surface and the tool surface that every agent pays for (principle 2).

### Trust

8. **Every act has an accountable principal.** Authority comes from the authenticated principal (user or service) plus the address it acts as, never from an address alone. Every address-holding row belongs to a live, attributable owner. Every authority decision is audited with both halves.
9. **Isolated by default, collaborative by grant.** Reading the directory and sending mail are open within the org. Waking, steering, delegating to, or taking a name from another principal's agents needs an explicit grant (a role binding or team policy). Ungranted mail is delivered as mail, never as a push that makes an agent act.
10. **Messages are data; authority comes only from the owner or a grant**, on arrival and after reading. Every delivery carries its sender's principal and whether a grant covers it; ungranted content is labelled untrusted in every harness; the human mark is unforgeable; the instruction text tells agents not to act on ungranted content without their human's approval. Obedience after reading is best-effort: agents aren't deterministic and the harness isn't ours.
11. **Authority is re-derived on every call, within the request budget.** No cache, in-memory session or replay outlives a revocation. The check is an indexed lookup or an O(1) generation compare (the `bind_gen` pattern), never a scan; the load test holds its cost (principle 13).

### Maintenance and scale

12. **Remove before you defend; no compatibility shims.** A surface with no caller is deleted, not secured. Old wire protocols and field names go without a deprecation window. Data is preserved where that is cheap: preferred, not required.
13. **Scale is a measured budget.** Every request is O(its own state), never O(the fleet). Caps are configurable and documented with sizing; a load test in CI holds the budget.
14. **Humans hold the keys to the supply chain.** Release signing, workflow files and production credentials stay with people. An agent proposes; a human merges or pushes.
