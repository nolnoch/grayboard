#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
package="$root/adapters/opencode-v2"
: "${GRAYBOARD_E2E_RUN_DIR:?Run through scripts/e2e.sh}"
[[ "$(bun --version)" == 1.4.4 ]] || { echo "Bun 1.4.4 required" >&2; exit 1; }
# Retain logs/provenance, never upload the isolated HOME, auth store or databases.
scratch="$(mktemp -d "${TMPDIR:-/tmp}/grayboard-hosted.XXXXXX")"
export GRAYBOARD_PACKAGE_TEST_DIR="$scratch/fixture"
finish() {
  code=$?
  bun "$root/scripts/hosted-provenance.ts" "$root" "$GRAYBOARD_PACKAGE_TEST_DIR" "$GRAYBOARD_E2E_RUN_DIR/provenance.json" || code=1
  printf 'exit=%s\n' "$code" > "$GRAYBOARD_E2E_RUN_DIR/exit"
  # Scratch is never an uploaded artifact; retain it for local diagnosis.
  exit "$code"
}
trap finish EXIT
mkdir -p "$GRAYBOARD_E2E_RUN_DIR"
git -C "$root" rev-parse HEAD > "$GRAYBOARD_E2E_RUN_DIR/source-revision"
git -C "$root" status --porcelain > "$GRAYBOARD_E2E_RUN_DIR/source-status"
bun -e 'const p = await Bun.file(process.argv[1]).json(); console.log(JSON.stringify({bun:Bun.version,package:p.name,version:p.version,scripts:p.scripts,dependencies:p.dependencies},null,2))' "$package/package.json" > "$GRAYBOARD_E2E_RUN_DIR/package.json"
cd "$package"
case "${1:-}" in
  strict)
    bun install --frozen-lockfile
    bun run typecheck
    bun run test --reporter=junit --reporter-outfile="$GRAYBOARD_E2E_RUN_DIR/unit.xml"
    bun run build:package
    ;;
  git) bun run test:git ;;
  host) bun run test:host ;;
  live) GRAYBOARD_TEST_CODEMODE=1 GRAYBOARD_TEST_CIMD_LIVE=1 bun run test:host ;;
  matrix) bun run test:host-races ;;
  native) bun run test:native-host ;;
  durable) bun run test:durable-host ;;
  config|public)
    public_revision=""
    if [[ "$1" == public ]]; then
      [[ "${GRAYBOARD_PUBLIC_REVISION:-}" =~ ^[a-f0-9]{40}$ ]] || { echo 'Public gate requires an available full40 SHA' >&2; exit 1; }
      public_revision="$GRAYBOARD_PUBLIC_REVISION"
    fi
    sh tests/real-prepare.sh
    prepared="$GRAYBOARD_PACKAGE_TEST_DIR"
    mkdir -p "$prepared/source/tests/e2e"
    cp "$root/tests/e2e/opencode-config.ts" "$prepared/source/tests/e2e/"
    # The CLI helper's JSONC dependency belongs to the root, not the independent package.
    ln -s "$root/node_modules" "$prepared/source/src/cli/node_modules"
    bun node_modules/typescript/bin/tsc --noEmit --strict --skipLibCheck --target ESNext --module ESNext --moduleResolution Bundler --allowImportingTsExtensions --resolveJsonModule --types bun "$prepared/source/tests/e2e/opencode-config.ts"
    mkdir -p "$prepared/config-home/config"
    cd "$prepared"
    env -i PATH="$prepared/tool-bin:/usr/bin:/bin:/usr/sbin:/sbin" HOME="$prepared/config-home" XDG_CONFIG_HOME="$prepared/config-home/config" XDG_DATA_HOME="$prepared/config-home/data" XDG_CACHE_HOME="$prepared/config-home/cache" XDG_STATE_HOME="$prepared/config-home/state" TMPDIR="$prepared/tmp" npm_config_ignore_scripts=true GRAYBOARD_GIT_TEST_ROOT="$prepared" GRAYBOARD_PUBLIC_REVISION="$public_revision" bun "$prepared/source/tests/e2e/opencode-config.ts"
    ;;
  *) echo 'unknown hosted gate' >&2; exit 2 ;;
esac
# Only immutable source identity and installation target, not credentials/private fixture state.
if [[ -f "$GRAYBOARD_PACKAGE_TEST_DIR/target.txt" ]]; then
  sed -E 's|git\+file://[^#]+#|local-fixture#|' "$GRAYBOARD_PACKAGE_TEST_DIR/target.txt" > "$GRAYBOARD_E2E_RUN_DIR/install-target"
fi
printf 'HOSTED_GATE_OK %s\n' "$1"
