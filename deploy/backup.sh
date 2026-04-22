#!/usr/bin/env bash
# Nightly SQLite backup to S3. Run via /etc/cron.d/grayboard-backup.
# Requires: aws CLI configured, S3_BUCKET env var set.
# Retention: 30 days (configured on the S3 lifecycle rule, not here).

set -euo pipefail

DB_PATH="${GRAYBOARD_DB_PATH:-/var/lib/grayboard/bus.db}"
S3_BUCKET="${S3_BUCKET:?S3_BUCKET must be set}"
DATE="$(date -u +%Y-%m-%d)"
TMP="/tmp/grayboard-backup-${DATE}.sqlite"

sqlite3 "$DB_PATH" ".backup $TMP"
aws s3 cp "$TMP" "s3://${S3_BUCKET}/grayboard/${DATE}.sqlite" --storage-class STANDARD_IA
rm -f "$TMP"

echo "Backup complete: s3://${S3_BUCKET}/grayboard/${DATE}.sqlite"
