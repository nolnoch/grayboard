#!/usr/bin/env bash
# Docs push gate for one pushed sha. Run by scripts/hooks/pre-push once per pushed ref.
# A trigger, not a judge: on possible drift it exits 1 with a reason, and the pusher decides
# whether to reconcile first or push WIP with the bypass. Fails OPEN (exit 0) on its own errors.
#
# Usage:  scripts/docs_gate.sh <sha>
# Exit:   0 = pass (or bypassed, inert, or errored), 1 = changes not yet reconciled into docs.
# Bypass: DOCS_GATE_BYPASS=1 in the push's environment.
#
# Measures docs-baseline...<sha>: what the pushed commits add since their merge base with the
# baseline, whether the branch was cut before or after the tag. It judges the pushed sha, not
# the checkout's HEAD.
set -u

SHA="${1:-}"
[ -z "$SHA" ] && exit 0
[ "${DOCS_GATE_BYPASS:-}" = "1" ] && exit 0

# Inert until a baseline exists (fresh clone: the tag is local and never pushed).
git rev-parse -q --verify refs/tags/docs-baseline >/dev/null 2>&1 || exit 0

CHANGED=$(git diff --name-only "docs-baseline...$SHA" 2>/dev/null) || exit 0
[ -z "$CHANGED" ] && exit 0
# Loose structural filter; the pusher's judgment is the precise one, so err toward stopping.
# Pass silently only when every changed file is docs, tests, gate tooling, images, or local
# agent config.
SIGNIFICANT=$(printf '%s\n' "$CHANGED" | grep -vE '^(docs/|tests/|scripts/|assets/|\.claude/)|/tests/|\.md$|\.test\.ts$' || true)
[ -z "$SIGNIFICANT" ] && exit 0

N=$(printf '%s\n' "$SIGNIFICANT" | wc -l)
{
  echo "[docs-gate] $SHA changes files since docs-baseline that docs haven't been reconciled against:"
  printf '%s\n' "$SIGNIFICANT" | head -20 | sed 's/^/  /'
  [ "$N" -gt 20 ] && echo "  (+$((N - 20)) more)"
  cat <<'MSG'
- If a unit of work is complete: reconcile first (.claude/commands/reconcile-docs.md; Claude Code: /reconcile-docs), then push.
- If this is a deliberate work-in-progress push: re-run it as DOCS_GATE_BYPASS=1 git push ... and tell the user you did.
Judge which case applies from session context.
MSG
} >&2
exit 1
