# Reconcile docs

Bring `AGENTS.md`, `docs/` and `README.md` back into accuracy with the code that changed over a commit range, then advance the `docs-baseline` tag. The only bar is accuracy against code. **Read `docs/CONTRACT.md` first**: it is the contract this command enforces (§3 authoring rules, §4 ownership map, §6 `doc-meta`). Harness-neutral: an agent on any harness can follow these steps by hand.

Run every `scripts/*.sh` from the git root (`"$(git rev-parse --show-toplevel)/scripts/<name>.sh"`); the shell's cwd isn't guaranteed to be the root.

## Arguments

`$ARGUMENTS` may hold a commit range (e.g. `abc123..HEAD`). Default: `docs-baseline..HEAD`. If the tag doesn't exist, ask the user which commit to diff from.

## Phase 1: Scope and significance

1. `git log --oneline <range>` and `git diff --stat <range> -- ':(exclude)docs/' ':(exclude)*.md'`: what changed and why.
2. Decide whether anything is doc-relevant. Doc-relevant: a new, removed or renamed module, mode, tool, frame, route, flag, adapter or data flow; a changed invariant, gotcha, default or cross-cutting pattern; a user-visible behavior or install/setup step (README); a change to commands, hooks or the release workflow (AGENTS.md). Not doc-relevant: a change whose only doc effect would be a count, signature or file list (Tier 3, never documented), a bug fix that restores documented behavior, or a test-only change.
3. **No doc-relevant drift:** report that with the reason, then go straight to Phase 5 step 4 and advance the tag. A reviewed range must not keep tripping the push gate.

## Phase 2: Route drift to owners

For each doc-relevant change, name the concept it touches and map it to its single owner (CONTRACT §4). `grep -A5 doc-meta docs/*.md docs/future/*.md` shows each doc's `owns:` line. Produce a punch list keyed by owner:

```
<owner doc>:
  - <concept>: <what changed; code paths to read for current state>
  - doc-meta: <stated invariant or code-pointer now wrong, if any>
```

- Server-only mechanics → `docs/architecture.md`; anything both modes share → `docs/boards.md`; Slack bridge → `docs/slack-bridge.md`; human steps → `README.md`; commands, gotchas, release, hooks → `AGENTS.md`.
- A change that builds something in `docs/future/` moves its as-built facts to the owner doc and deletes the future doc.
- A bug or missing feature found along the way is a GitHub issue (`gh issue create`), not a doc section.

## Phase 3: Edit

Default to editing inline; most reconciles touch one to three docs. Spawn one agent per owner doc only when several docs each have a substantial, independent punch list. Every edit follows CONTRACT §3:

- Agent-only terse register everywhere except `README.md`, which keeps its human register. No intros, transitions, "Note that…", or restated purpose. Test: if a competent agent would re-derive it from code in one read, or already knows it, cut it. Keep invariants, gotchas, the non-obvious why behind a constraint, and pointers.
- Why over what; prefer a code pointer to describing code. Read the whole target section before editing; edit only what's stale.
- No catalogs or counts; write "verify against `<path>`" if orientation needs a number.
- Delete on removal; no tombstones. No changelog markers, dates or version pins (except `docs/future/` `last-verified:`).
- Convert ASCII diagrams to Mermaid in sections you meaningfully edit.
- Update `doc-meta` when an invariant or code location changed; `owns:` must still match the CONTRACT §4 row.
- Change `AGENTS.md` only if a load-bearing rule changed: "would an agent make a wrong or expensive move without this line?"
- Public repo: no employer, client or private project names.

## Phase 4: Verify

Spawn one fresh general-purpose agent (Claude Code: `model: "opus"`; use `"fable"` when the drift changes a security, access or delivery invariant or a cross-mode seam) with this prompt:

> Verify the accuracy of doc edits just made to: `<touched files>`. For each claim the edits added or changed, confirm it against the code at HEAD (read the cited paths). Assume nothing is right. Report, per file: statements that are wrong, invented or stale; any reintroduced catalog or count; any human-facing register outside README.md (teaching, motivating, narrating, intros, anything a grep-capable agent would re-derive); and whether each touched doc's `doc-meta owns:` matches its CONTRACT.md §4 row. Don't rewrite; report defects with `file:line` and the corrected fact. If a file is clean, say so in one line with what you checked.

Apply corrections. Re-verify only if a correction was substantive.

## Phase 5: Commit and advance

1. Show `git diff --stat` and the full diff of the touched docs.
2. Sanity checks: no new catalog section or hand-maintained count (grep the diff for bare integers in prose); no link to a deleted or renamed doc (`grep -rn '\.md' docs AGENTS.md README.md`); no `meta/` citation; no private names in the staged diff.
3. On the user's go-ahead, commit with an explicit pathspec (`git commit -- docs AGENTS.md README.md -m "Docs: reconcile <range>"`), never `-a`.
4. Run `scripts/advance_docs_baseline.sh`. It refuses while doc files have uncommitted changes. Never move the tag by hand.

## When to run

- After a coherent unit of work has landed, or when the push gate refuses a push of finished work.
- Not at a mid-task handoff: the code is in an intermediate state. Push WIP with `DOCS_GATE_BYPASS=1` instead.
