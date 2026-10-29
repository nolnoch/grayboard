#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
: "${GRAYBOARD_PACKAGE_TEST_DIR:?Set GRAYBOARD_PACKAGE_TEST_DIR to a fresh approved scratch directory}"
sh tests/git-host.sh
root="$GRAYBOARD_PACKAGE_TEST_DIR"
mkdir -p "$root/source/adapters/opencode-v2/tests"
cp -R ../../src "$root/source/"
cp ../../package.json "$root/source/package.json"
cp -R src "$root/source/adapters/opencode-v2/"
cp tests/host.ts tests/real-races.ts tests/real-reload.ts tests/reload-state.ts tests/causal.ts tests/subscriber-work.ts tests/failed-continuation.ts tests/effect-host.ts tests/effect-instrument.ts tests/cimd-fixture.ts "$root/source/adapters/opencode-v2/tests/"
mkdir -p "$root/source/adapters/opencode-v2/tests/fixtures"
cp tests/fixtures/opencode-client.json tests/fixtures/opencode-client.source.json "$root/source/adapters/opencode-v2/tests/fixtures/"
ln -s "$PWD/node_modules" "$root/source/node_modules"
bun "$PWD/node_modules/typescript/bin/tsc" --noEmit --strict --skipLibCheck --target ESNext --module ESNext --moduleResolution Bundler --allowImportingTsExtensions --resolveJsonModule --typeRoots "$PWD/node_modules/@types" --types bun "$root/source/adapters/opencode-v2/tests/host.ts" "$root/source/adapters/opencode-v2/tests/real-reload.ts"
