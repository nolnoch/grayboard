#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
: "${GRAYBOARD_PACKAGE_TEST_DIR:?Set GRAYBOARD_PACKAGE_TEST_DIR to a fresh approved scratch directory}"
bun run test:git
root="$GRAYBOARD_PACKAGE_TEST_DIR"
cp tests/native-host.ts tests/durable-cases.ts tests/reload-state.ts tests/causal.ts tests/subscriber-work.ts tests/effect-host.ts tests/effect-instrument.ts "$root/tests/"
bun "$PWD/node_modules/typescript/bin/tsc" --noEmit --strict --skipLibCheck --target ESNext --module ESNext --moduleResolution Bundler --allowImportingTsExtensions --resolveJsonModule --types bun "$root/tests/native-host.ts"
for scenario in ${GRAYBOARD_DURABLE_CASES:-pause archive delete rebind expiry revocation account account-away-back config away-back late-away-back reload}; do
  for boundary in before after; do
    base="$root/$scenario-$boundary"
    mkdir -p "$base/home/config" "$base/tmp" "$base/native-config" "$base/project"
    cp "$root/installed.txt" "$base/installed.txt"
    ln -s "$root/node_modules" "$base/node_modules"
    for phase in admit reload; do
      if [ "$scenario" != reload ] && [ "$phase" = reload ]; then continue; fi
      env -i PATH="$root/tool-bin:/usr/bin:/bin:/usr/sbin:/sbin" HOME="$base/home" XDG_CONFIG_HOME="$base/home/config" XDG_DATA_HOME="$base/home/data" XDG_CACHE_HOME="$base/home/cache" XDG_STATE_HOME="$base/home/state" TMPDIR="$base/tmp" npm_config_ignore_scripts=true GRAYBOARD_GIT_TEST_ROOT="$base" GRAYBOARD_NATIVE_MODE=durable GRAYBOARD_DURABLE_CASE="$scenario" GRAYBOARD_DURABLE_BOUNDARY="$boundary" GRAYBOARD_DURABLE_PHASE="$phase" bun "$root/tests/native-host.ts"
    done
    if [ "$scenario" = reload ]; then break; fi
  done
done
