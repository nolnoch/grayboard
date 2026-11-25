#!/bin/sh
# #661 on a real OpenCode 2.1.4 host: tests/native-refresh.ts in a scratch HOME.
set -eu
cd "$(dirname "$0")/.."
: "${GRAYBOARD_PACKAGE_TEST_DIR:?Set GRAYBOARD_PACKAGE_TEST_DIR to a fresh approved scratch directory}"
root="$GRAYBOARD_PACKAGE_TEST_DIR"
test ! -e "$root/refresh"
mkdir -p "$root/refresh/home/config" "$root/refresh/tmp" "$root/refresh/native-config" "$root/refresh/project-a" "$root/refresh/project-b"
bun "$PWD/node_modules/typescript/bin/tsc" --noEmit --strict --skipLibCheck --target ESNext --module ESNext --moduleResolution Bundler --allowImportingTsExtensions --resolveJsonModule --types bun tests/native-refresh.ts
exec env -i PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin" HOME="$root/refresh/home" XDG_CONFIG_HOME="$root/refresh/home/config" XDG_DATA_HOME="$root/refresh/home/data" XDG_CACHE_HOME="$root/refresh/home/cache" XDG_STATE_HOME="$root/refresh/home/state" TMPDIR="$root/refresh/tmp" GRAYBOARD_REFRESH_TEST_ROOT="$root/refresh" timeout 300 bun tests/native-refresh.ts
