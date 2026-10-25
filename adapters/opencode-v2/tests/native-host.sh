#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
: "${GRAYBOARD_PACKAGE_TEST_DIR:?Set GRAYBOARD_PACKAGE_TEST_DIR to a fresh approved scratch directory}"
bun run test:git
root="$GRAYBOARD_PACKAGE_TEST_DIR"
cp tests/native-host.ts "$root/tests/native-host.ts"
bun "$PWD/node_modules/typescript/bin/tsc" --noEmit --strict --skipLibCheck --target ESNext --module ESNext --moduleResolution Bundler --allowImportingTsExtensions --resolveJsonModule --types bun "$root/tests/native-host.ts"
for mode in direct code disabled; do
  mkdir -p "$root/$mode/home/config" "$root/$mode/tmp" "$root/$mode/native-config" "$root/$mode/project"
  cp "$root/installed.txt" "$root/$mode/installed.txt"
  ln -s "$root/node_modules" "$root/$mode/node_modules"
  env -i PATH="$root/tool-bin:/usr/bin:/bin:/usr/sbin:/sbin" HOME="$root/$mode/home" XDG_CONFIG_HOME="$root/$mode/home/config" XDG_DATA_HOME="$root/$mode/home/data" XDG_CACHE_HOME="$root/$mode/home/cache" XDG_STATE_HOME="$root/$mode/home/state" TMPDIR="$root/$mode/tmp" npm_config_ignore_scripts=true GRAYBOARD_GIT_TEST_ROOT="$root/$mode" GRAYBOARD_NATIVE_MODE="$mode" bun "$root/tests/native-host.ts"
done
