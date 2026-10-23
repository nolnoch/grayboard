#!/usr/bin/env bash
# The one entry point for the e2e suites, for CI and by hand:
#   scripts/e2e.sh upgrade-matrix   every v1.x release's databases and installs
#                                   upgrade to this tree (needs network)
#   scripts/e2e.sh binaries         a release's compiled binaries; needs
#                                   GRAYBOARD_E2E_BIN_DIR and GRAYBOARD_E2E_TAG
#                                   (see tests/e2e/binaries.e2e.ts)
# Each run writes its run dir (GRAYBOARD_E2E_RUN_DIR, default
# .e2e-runs/<suite>-<UTC time>): per bun test run, its output (.log) and JUnit
# report (.xml), plus whatever the tests keep (tests/support/run_dir.ts).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

case "${1:-}" in
  upgrade-matrix | binaries) suite="$1" ;;
  *)
    echo "usage: $0 upgrade-matrix|binaries" >&2
    exit 2
    ;;
esac
run="${GRAYBOARD_E2E_RUN_DIR:-$root/.e2e-runs/$suite-$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$run"
echo "e2e: run dir $run"

# One bun test run as <name> in the run dir: its output to <name>.log as well
# as the terminal, its JUnit report to <name>.xml, and its kept files under
# <name>/. Further arguments go to bun test.
suite_run() {
  local name="$1"
  shift
  GRAYBOARD_E2E_RUN_DIR="$run/$name" bun test --reporter=junit --reporter-outfile="$run/$name.xml" "$@" 2>&1 | tee "$run/$name.log"
}

case "$suite" in
  upgrade-matrix)
    own="v$(jq -r .version package.json)"
    tags="$(bun -e 'import { releases } from "./tests/support/releases.ts"; console.log((await releases()).join("\n"))')"
    [ -n "$tags" ] || { echo "e2e: no releases listed" >&2; exit 1; }
    failed=()
    ran=0
    for tag in $tags; do
      ran=$((ran + 1))
      files=(./tests/integration/upgrade.test.ts)
      # `grayboard update` has nothing to do from this tree's own version.
      [ "$tag" = "$own" ] || files+=(./tests/integration/upgrade_install.test.ts)
      echo "e2e: upgrade from $tag"
      GRAYBOARD_UPGRADE_FROM="$tag" suite_run "upgrade-$tag" "${files[@]}" || failed+=("$tag")
    done
    if [ ${#failed[@]} -ne 0 ]; then
      echo "e2e: upgrade-matrix failed from ${failed[*]} (logs in $run)" >&2
      exit 1
    fi
    echo "e2e: upgrade-matrix passed from all $ran releases"
    ;;
  binaries)
    suite_run binaries ./tests/e2e/binaries.e2e.ts
    ;;
esac
