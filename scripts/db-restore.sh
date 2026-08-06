#!/usr/bin/env bash
# Restore the HireCraft Postgres DB from a host-side dump created by db-backup.sh.
# Usage:  ./scripts/db-restore.sh backups/hirecraft_YYYYMMDD_HHMMSS.sql
set -euo pipefail
cd "$(dirname "$0")/.."
dump="${1:?usage: ./scripts/db-restore.sh backups/<file>.sql}"
[ -f "$dump" ] || { echo "No such file: $dump" >&2; exit 1; }
echo "Restoring $dump into the running Postgres container…"
docker compose exec -T postgres psql -U hirecraft -d hirecraft < "$dump"
echo "Restore complete."
