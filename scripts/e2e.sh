#!/usr/bin/env bash
# The one entry point for the e2e suites, for CI and by hand:
#   scripts/e2e.sh upgrade-matrix   every v1.x release's databases (and, where
#                                   its own updater runs, `grayboard update`)
#                                   upgrade to this tree; the installers once
#                                   (needs network)
#   scripts/e2e.sh binaries         a release's compiled binaries; needs
#                                   GRAYBOARD_E2E_BIN_DIR and GRAYBOARD_E2E_TAG
#                                   (see tests/e2e/binaries.e2e.ts)
# Each run writes its run dir (GRAYBOARD_E2E_RUN_DIR, default
# .e2e-runs/<suite>-<UTC time>): per bun test run, its output (.log) and JUnit
# report (.xml), plus whatever the tests keep (tests/support/run_dir.ts), and
# the verdict in `result`.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

case "${1:-}" in
  upgrade-matrix | binaries | hosted-strict | hosted-git | hosted-config | hosted-public | hosted-host | hosted-live | hosted-matrix | hosted-native | hosted-durable) suite="$1" ;;
  *)
    echo "usage: $0 upgrade-matrix|binaries|hosted-{strict,git,config,public,host,live,matrix,native,durable}" >&2
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

# The verdict, as one line: to the terminal, to <run dir>/result (e2e.yml's
# tracking issue quotes it) and to the job summary under CI. Exits 1 unless
# it starts with "passed".
verdict() {
  echo "e2e: $suite $1"
  echo "$1" > "$run/result"
  [ -z "${GITHUB_STEP_SUMMARY:-}" ] || echo "\`$suite\`: $1" >> "$GITHUB_STEP_SUMMARY"
  case "$1" in passed*) exit 0 ;; *) exit 1 ;; esac
}

case "$suite" in
  hosted-*)
    export GRAYBOARD_E2E_RUN_DIR="$run"
    # Logs may contain fixture IDs, but never keep auth storage or raw HTTP headers.
    if bash scripts/hosted-e2e.sh "${suite#hosted-}" 2>&1 | sed -E 's/(Bearer )[A-Za-z0-9._~+\/-]+/\1[REDACTED]/g; s/("(access_token|refresh_token|client_secret)"[[:space:]]*:[[:space:]]*")[^"]*/\1[REDACTED]/g' | tee "$run/hosted.log"; then
      verdict 'passed'
    else
      verdict 'failed (hosted.log in the run dir)'
    fi
    ;;
  upgrade-matrix)
    own="v$(jq -r .version package.json)"
    # One line per release: its tag, and whether its own `grayboard update`
    # honours GRAYBOARD_RELEASES_URL (releases.ts: ownUpdater).
    list="$(bun -e 'import { ownUpdater, releases } from "./tests/support/releases.ts"; for (const t of await releases()) console.log(t, ownUpdater(t) ? "own" : "built")')"
    [ -n "$list" ] || verdict "failed: no releases listed"
    failed=()
    ran=0
    # The installers once: only the update test depends on the release, and
    # up to v1.10.0 a build of this tree runs it, the same for every tag.
    echo "e2e: installers"
    suite_run installers ./tests/integration/upgrade_install.test.ts || failed+=(installers)
    # The list comes in on fd 3, so a test reading stdin can't eat it.
    while read -r tag updater <&3; do
      ran=$((ran + 1))
      echo "e2e: databases from $tag"
      GRAYBOARD_UPGRADE_FROM="$tag" suite_run "upgrade-$tag" ./tests/integration/upgrade.test.ts || failed+=("$tag")
      # `grayboard update` has nothing to do from this tree's own version.
      if [ "$updater" = own ] && [ "$tag" != "$own" ]; then
        echo "e2e: update from $tag"
        GRAYBOARD_UPGRADE_FROM="$tag" suite_run "update-$tag" ./tests/integration/upgrade_install.test.ts -t "^update from " || failed+=("update-$tag")
      fi
    done 3<<< "$list"
    if [ ${#failed[@]} -ne 0 ]; then
      verdict "failed: ${failed[*]} (of $ran releases; logs in the run dir)"
    fi
    verdict "passed from all $ran releases"
    ;;
  binaries)
    if suite_run binaries ./tests/e2e/binaries.e2e.ts; then verdict "passed"; else verdict "failed (binaries.log in the run dir)"; fi
    ;;
esac
