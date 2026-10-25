#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
: "${GRAYBOARD_PACKAGE_TEST_DIR:?Set GRAYBOARD_PACKAGE_TEST_DIR to a fresh approved scratch directory}"
sh tests/real-prepare.sh
GRAYBOARD_REAL_PREPARED="$GRAYBOARD_PACKAGE_TEST_DIR" sh tests/real-run.sh
