#!/bin/sh
# #270 step 4: static service-credential mode on a real OpenCode host against a real server (tests/static-host.ts),
# with native tools direct and in code mode. Prepares its own fresh snapshot under GRAYBOARD_PACKAGE_TEST_DIR.
set -eu
cd "$(dirname "$0")/.."
: "${GRAYBOARD_PACKAGE_TEST_DIR:?Set GRAYBOARD_PACKAGE_TEST_DIR to a fresh approved scratch directory}"
sh tests/real-prepare.sh
prepared="$GRAYBOARD_PACKAGE_TEST_DIR"
cp tests/static-host.ts "$prepared/source/adapters/opencode-v2/tests/"
bun "$PWD/node_modules/typescript/bin/tsc" --noEmit --strict --skipLibCheck --target ESNext --module ESNext --moduleResolution Bundler --allowImportingTsExtensions --resolveJsonModule --typeRoots "$PWD/node_modules/@types" --types bun "$prepared/source/adapters/opencode-v2/tests/static-host.ts"
for mode in 0 1; do
  run="$prepared/static-$mode"
  mkdir -p "$run/tmp" "$run/home"
  ln -s "$prepared/node_modules" "$run/node_modules"
  cp "$prepared/installed.txt" "$run/installed.txt"
  # The launcher's environment is all the plugin sees: nothing here sets the static mode; static-host.ts does, as a launcher would.
  (cd "$run" && env -i PATH="$prepared/tool-bin:/usr/bin:/bin:/usr/sbin:/sbin" HOME="$run/home" XDG_CONFIG_HOME="$run/home/config" XDG_DATA_HOME="$run/home/data" XDG_CACHE_HOME="$run/home/cache" XDG_STATE_HOME="$run/home/state" TMPDIR="$run/tmp" GRAYBOARD_TEST_CODEMODE="$mode" GRAYBOARD_GIT_TEST_ROOT="$run" bun "$prepared/source/adapters/opencode-v2/tests/static-host.ts")
done
