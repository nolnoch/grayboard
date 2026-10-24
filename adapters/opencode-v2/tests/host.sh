#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
: "${GRAYBOARD_PACKAGE_TEST_DIR:?Set GRAYBOARD_PACKAGE_TEST_DIR to an approved isolated scratch directory}"
mkdir -p "$GRAYBOARD_PACKAGE_TEST_DIR/home" "$GRAYBOARD_PACKAGE_TEST_DIR/tmp" "$GRAYBOARD_PACKAGE_TEST_DIR/source/adapters/opencode-v2/tests"
cp -R ../../src "$GRAYBOARD_PACKAGE_TEST_DIR/source/"
cp ../../package.json "$GRAYBOARD_PACKAGE_TEST_DIR/source/package.json"
cp -R src "$GRAYBOARD_PACKAGE_TEST_DIR/source/adapters/opencode-v2/"
cp tests/host.ts "$GRAYBOARD_PACKAGE_TEST_DIR/source/adapters/opencode-v2/tests/host.ts"
ln -sfn "$PWD/node_modules" "$GRAYBOARD_PACKAGE_TEST_DIR/source/node_modules"
fixture="$GRAYBOARD_PACKAGE_TEST_DIR/source/adapters/opencode-v2/tests/host.ts"
tooling="$PWD/node_modules"
bun run build
npm pack --ignore-scripts --pack-destination "$GRAYBOARD_PACKAGE_TEST_DIR"
cd "$GRAYBOARD_PACKAGE_TEST_DIR"
mkdir -p tool-bin
ln -sfn "$(command -v bun)" "$PWD/tool-bin/bun"
probePath="$PWD/tool-bin:/usr/bin:/bin:/usr/sbin:/sbin"
cat > package.json <<'JSON'
{"name":"grayboard-package-install-test","private":true,"type":"module","dependencies":{"grayboard-opencode":"file:./grayboard-opencode-1.10.0.tgz"}}
JSON
env -i PATH="$probePath" HOME="$PWD/home" XDG_CONFIG_HOME="$PWD/home/config" XDG_DATA_HOME="$PWD/home/data" XDG_CACHE_HOME="$PWD/home/cache" XDG_STATE_HOME="$PWD/home/state" TMPDIR="$PWD/tmp" bun install --ignore-scripts --force
cat > exports.mjs <<'JS'
import plugin, { Grayboard } from 'grayboard-opencode';
const tui = import.meta.resolve('grayboard-opencode/tui');
if (!plugin || !Grayboard || !tui.endsWith('/tui.js')) throw new Error('Missing package exports');
JS
env -i PATH="$probePath" HOME="$PWD/home" TMPDIR="$PWD/tmp" bun exports.mjs
env -i PATH="$probePath" HOME="$PWD/home" TMPDIR="$PWD/tmp" bun "$tooling/typescript/bin/tsc" --noEmit --strict --skipLibCheck --target ESNext --module ESNext --moduleResolution Bundler --allowImportingTsExtensions --resolveJsonModule --typeRoots "$tooling/@types" --types bun "$fixture"
env -i PATH="$probePath" HOME="$PWD/home" XDG_CONFIG_HOME="$PWD/home/config" XDG_DATA_HOME="$PWD/home/data" XDG_CACHE_HOME="$PWD/home/cache" XDG_STATE_HOME="$PWD/home/state" TMPDIR="$PWD/tmp" GRAYBOARD_INSTALLED_PACKAGE="$PWD/node_modules/grayboard-opencode" bun "$fixture"
