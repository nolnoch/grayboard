#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
: "${GRAYBOARD_PACKAGE_TEST_DIR:?Set GRAYBOARD_PACKAGE_TEST_DIR to a fresh approved scratch directory}"
base="$GRAYBOARD_PACKAGE_TEST_DIR"
GRAYBOARD_PACKAGE_TEST_DIR="$base/prepared" sh tests/real-prepare.sh
export GRAYBOARD_REAL_PREPARED="$base/prepared"
for scenario in pause archive delete rebind enrollment account account-away-back config away-back revocation expiry; do
  for boundary in before after; do
    GRAYBOARD_PACKAGE_TEST_DIR="$base/$scenario-$boundary" GRAYBOARD_TEST_REAL_RACE="$scenario" GRAYBOARD_TEST_RACE_BOUNDARY="$boundary" sh tests/real-run.sh
  done
done
for scenario in outage digest-reload native-refresh; do
  GRAYBOARD_PACKAGE_TEST_DIR="$base/$scenario" GRAYBOARD_TEST_REAL_RACE="$scenario" sh tests/real-run.sh
done
for boundary in before after; do
  GRAYBOARD_PACKAGE_TEST_DIR="$base/crash-$boundary" GRAYBOARD_TEST_CRASH_BOUNDARY="$boundary" sh tests/real-run.sh
done
