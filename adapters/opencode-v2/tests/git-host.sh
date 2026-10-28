#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
: "${GRAYBOARD_PACKAGE_TEST_DIR:?Set GRAYBOARD_PACKAGE_TEST_DIR to a fresh approved scratch directory}"
test ! -e "$GRAYBOARD_PACKAGE_TEST_DIR"
mkdir -p "$GRAYBOARD_PACKAGE_TEST_DIR/repository/adapters/opencode-v2" "$GRAYBOARD_PACKAGE_TEST_DIR/home/config" "$GRAYBOARD_PACKAGE_TEST_DIR/tmp" "$GRAYBOARD_PACKAGE_TEST_DIR/project" "$GRAYBOARD_PACKAGE_TEST_DIR/tool-bin"
root="$GRAYBOARD_PACKAGE_TEST_DIR"
package="$root/repository/adapters/opencode-v2"
cp package.json index.js tui.js README.md "$package/"
cp -R src "$package/"
# Deliberately exclude ignored dist, dependencies, test fixtures and private files.
git -C "$root/repository" init -q
git -C "$root/repository" add adapters
git -C "$root/repository" -c user.name=Fixture -c user.email=you@example.com -c commit.gpgsign=false commit -qm 'fixture: source-only package'
sha=$(git -C "$root/repository" rev-parse HEAD)
target="git+file://$root/repository#$sha::path:adapters/opencode-v2"
printf '%s\n' "$target" > "$root/target.txt"
mkdir "$root/tests"
cp tests/git-host.ts "$root/tests/git-host.ts"
cp -R src "$root/src"
ln -s "$PWD/node_modules" "$root/node_modules"
ln -s "$(command -v bun)" "$root/tool-bin/bun"
# npm is required by Pacote's Git preparation, even with scripts disabled.
ln -s "$(command -v node)" "$root/tool-bin/node"
ln -s "$(command -v npm)" "$root/tool-bin/npm"
bun "$PWD/node_modules/typescript/bin/tsc" --noEmit --strict --skipLibCheck --target ESNext --module ESNext --moduleResolution Bundler --allowImportingTsExtensions --resolveJsonModule --types bun "$root/tests/git-host.ts"
env -i PATH="$root/tool-bin:/usr/bin:/bin:/usr/sbin:/sbin" HOME="$root/home" XDG_CONFIG_HOME="$root/home/config" XDG_DATA_HOME="$root/home/data" XDG_CACHE_HOME="$root/home/cache" XDG_STATE_HOME="$root/home/state" TMPDIR="$root/tmp" npm_config_ignore_scripts=true GRAYBOARD_GIT_TEST_ROOT="$root" bun "$root/tests/git-host.ts"
