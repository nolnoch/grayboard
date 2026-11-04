#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
: "${GRAYBOARD_PACKAGE_TEST_DIR:?Set GRAYBOARD_PACKAGE_TEST_DIR to a fresh approved scratch directory}"
sh tests/real-prepare.sh
GRAYBOARD_REAL_PREPARED="$GRAYBOARD_PACKAGE_TEST_DIR" sh tests/real-run.sh
if [ -z "${GRAYBOARD_TEST_REAL_RACE:-}" ]; then
  prepared="$GRAYBOARD_PACKAGE_TEST_DIR"
  for mode in 0 1; do
    GRAYBOARD_PACKAGE_TEST_DIR="$prepared/attachments-$mode" GRAYBOARD_REAL_PREPARED="$prepared" GRAYBOARD_TEST_REAL_RACE=attachments GRAYBOARD_TEST_CODEMODE="$mode" sh tests/real-run.sh
  done
fi
