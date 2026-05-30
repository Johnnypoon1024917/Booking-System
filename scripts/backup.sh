#!/usr/bin/env bash
# scripts/backup.sh — operational pg_dump for FSD MRBS.
#
# Produces a custom-format, compressed dump (-Fc) so pg_restore can do
# parallel restore and selective object recovery. The dump is encrypted
# with OpenSSL AES-256 using BACKUP_PASSPHRASE; without that envvar the
# script refuses to write a plaintext backup.
#
# Usage:
#   POSTGRES_PASSWORD=... BACKUP_PASSPHRASE=... ./scripts/backup.sh
#
# Cron suggestion (runs at 02:30 daily, keeps 30 daily + 8 weekly):
#   30 2 * * *  /opt/fsd-mrbs/scripts/backup.sh >> /var/log/mrbs/backup.log 2>&1

set -euo pipefail

: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
: "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE is required (used to encrypt the dump)}"

PG_HOST="${PG_HOST:-postgres_db}"
PG_PORT="${PG_PORT:-5432}"
PG_DB="${PG_DB:-fsd_mrbs}"
PG_USER="${PG_USER:-mrbs_admin}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/mrbs}"
RETAIN_DAILY="${RETAIN_DAILY:-30}"
RETAIN_WEEKLY="${RETAIN_WEEKLY:-8}"

ts="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly"

out="$BACKUP_DIR/daily/mrbs-$ts.dump.enc"
tmp="$(mktemp -t mrbs-backup-XXXXXX)"
trap 'rm -f "$tmp"' EXIT

PGPASSWORD="$POSTGRES_PASSWORD" pg_dump \
    --host="$PG_HOST" --port="$PG_PORT" \
    --username="$PG_USER" --dbname="$PG_DB" \
    --format=custom --compress=9 --no-owner --no-privileges \
    --file="$tmp"

openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
    -pass "env:BACKUP_PASSPHRASE" \
    -in "$tmp" -out "$out"

sha256sum "$out" > "$out.sha256"
echo "wrote $out ($(wc -c <"$out") bytes)"

# Snapshot to weekly on Sundays.
if [ "$(date -u +%u)" = "7" ]; then
    cp -p "$out" "$out.sha256" "$BACKUP_DIR/weekly/"
fi

# Retention.
find "$BACKUP_DIR/daily"  -type f -mtime "+$RETAIN_DAILY"  -delete
find "$BACKUP_DIR/weekly" -type f -mtime "+$((RETAIN_WEEKLY * 7))" -delete
