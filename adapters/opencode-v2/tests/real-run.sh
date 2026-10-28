#!/bin/sh
set -eu
: "${GRAYBOARD_PACKAGE_TEST_DIR:?Set GRAYBOARD_PACKAGE_TEST_DIR to a fresh approved scratch directory}"
: "${GRAYBOARD_REAL_PREPARED:?Set GRAYBOARD_REAL_PREPARED to the immutable real-prepare.sh snapshot}"
root="$GRAYBOARD_PACKAGE_TEST_DIR"
mkdir -p "$root/real-home/config" "$root/tmp" "$root/project"
if [ "$root" != "$GRAYBOARD_REAL_PREPARED" ]; then
  ln -s "$GRAYBOARD_REAL_PREPARED/node_modules" "$root/node_modules"
  ln -s "$GRAYBOARD_REAL_PREPARED/tool-bin" "$root/tool-bin"
  cp "$GRAYBOARD_REAL_PREPARED/installed.txt" "$root/installed.txt"
fi
cd "$root"
env -i PATH="$root/tool-bin:/usr/bin:/bin:/usr/sbin:/sbin" HOME="$root/real-home" XDG_CONFIG_HOME="$root/real-home/config" XDG_DATA_HOME="$root/real-home/data" XDG_CACHE_HOME="$root/real-home/cache" XDG_STATE_HOME="$root/real-home/state" TMPDIR="$root/tmp" GRAYBOARD_TEST_CRASH_BOUNDARY="${GRAYBOARD_TEST_CRASH_BOUNDARY:-}" GRAYBOARD_TEST_REAL_RACE="${GRAYBOARD_TEST_REAL_RACE:-}" GRAYBOARD_TEST_RACE_BOUNDARY="${GRAYBOARD_TEST_RACE_BOUNDARY:-before}" GRAYBOARD_TEST_CODEMODE="${GRAYBOARD_TEST_CODEMODE:-0}" GRAYBOARD_TEST_CIMD_LIVE="${GRAYBOARD_TEST_CIMD_LIVE:-0}" GRAYBOARD_GIT_TEST_ROOT="$root" bun "$GRAYBOARD_REAL_PREPARED/source/adapters/opencode-v2/tests/host.ts"
