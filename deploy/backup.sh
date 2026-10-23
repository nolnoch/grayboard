#!/usr/bin/env bash
# Nightly backup to S3: a SQLite snapshot, then a mirror of the attachment
# blob directory. Run via /etc/cron.d/grayboard-backup.
# Requires: aws CLI configured, S3_BUCKET env var set.
# Retention: 30 days (configured on the S3 lifecycle rule, not here). The
# mirror deletes blobs the server deleted; with bucket versioning and a
# noncurrent-version expiry to match, an older snapshot's blobs stay restorable.

set -euo pipefail

DB_PATH="${GRAYBOARD_DB_PATH:-/var/lib/grayboard/bus.db}"
BLOB_DIR="${GRAYBOARD_BLOB_DIR:-$(dirname "$DB_PATH")/blobs}"
S3_BUCKET="${S3_BUCKET:?S3_BUCKET must be set}"
DATE="$(date -u +%Y-%m-%d)"
TMP="/tmp/grayboard-backup-${DATE}.sqlite"

sqlite3 "$DB_PATH" ".backup $TMP"
aws s3 cp "$TMP" "s3://${S3_BUCKET}/grayboard/${DATE}.sqlite" --storage-class STANDARD_IA
rm -f "$TMP"

# After the snapshot, so every blob it names is copied. Blobs are immutable
# (named by their sha256); tmp/ holds puts in flight.
# The server creates the directory at startup: a missing one is a wrong path.
[ -d "$BLOB_DIR" ] || { echo "no blob directory at $BLOB_DIR (set GRAYBOARD_BLOB_DIR)" >&2; exit 1; }
aws s3 sync "$BLOB_DIR" "s3://${S3_BUCKET}/grayboard/blobs/" --delete --exclude "tmp/*" --storage-class STANDARD_IA

echo "Backup complete: s3://${S3_BUCKET}/grayboard/${DATE}.sqlite, blobs in s3://${S3_BUCKET}/grayboard/blobs/"
