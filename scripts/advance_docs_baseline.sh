#!/usr/bin/env bash
# The only way the docs-baseline tag moves. Run as the last step of a reconcile, after the doc
# changes are committed. Guards commit-then-tag: the push gate (scripts/docs_gate.sh) measures
# docs-baseline...<sha>, so a baseline on a commit that lacks the doc edits would re-flag the
# same drift on every push.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

DOCS=(docs/ AGENTS.md CLAUDE.md README.md)
if ! git diff --quiet -- "${DOCS[@]}" || ! git diff --cached --quiet -- "${DOCS[@]}"; then
  echo "REFUSING: uncommitted changes in ${DOCS[*]}." >&2
  echo "Commit the reconcile before advancing the baseline (commit-then-tag)." >&2
  exit 1
fi

# Local-only marker: never signed or annotated, even under a global tag.gpgsign.
git -c tag.gpgsign=false tag -f docs-baseline HEAD >/dev/null
echo "docs-baseline → $(git rev-parse --short HEAD)"
