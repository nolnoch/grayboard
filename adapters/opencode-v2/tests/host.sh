#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
: "${GRAYBOARD_PACKAGE_TEST_DIR:?Set GRAYBOARD_PACKAGE_TEST_DIR to a fresh approved scratch directory}"
sh tests/git-host.sh
root="$GRAYBOARD_PACKAGE_TEST_DIR"
mkdir -p "$root/source/adapters/opencode-v2/tests" "$root/source/tests/helpers" "$root/real-home/config"
cp -R ../../src "$root/source/"
cp ../../package.json "$root/source/package.json"
cp ../../tests/helpers/hosted.ts "$root/source/tests/helpers/"
cp -R src "$root/source/adapters/opencode-v2/"
cp tests/host.ts "$root/source/adapters/opencode-v2/tests/host.ts"
ln -s "$PWD/node_modules" "$root/source/node_modules"
fixture="$root/source/adapters/opencode-v2/tests/host.ts"
bun "$PWD/node_modules/typescript/bin/tsc" --noEmit --strict --skipLibCheck --target ESNext --module ESNext --moduleResolution Bundler --allowImportingTsExtensions --resolveJsonModule --typeRoots "$PWD/node_modules/@types" --types bun "$fixture"
cd "$root"
env -i PATH="$root/tool-bin:/usr/bin:/bin:/usr/sbin:/sbin" HOME="$root/real-home" XDG_CONFIG_HOME="$root/real-home/config" XDG_DATA_HOME="$root/real-home/data" XDG_CACHE_HOME="$root/real-home/cache" XDG_STATE_HOME="$root/real-home/state" TMPDIR="$root/tmp" GRAYBOARD_TEST_SKIP_RESTART="${GRAYBOARD_TEST_SKIP_RESTART:-0}" GRAYBOARD_TEST_CHALLENGE_DIAGNOSTIC="${GRAYBOARD_TEST_CHALLENGE_DIAGNOSTIC:-0}" GRAYBOARD_GIT_TEST_ROOT="$root" bun "$fixture"
