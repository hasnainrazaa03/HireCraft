#!/usr/bin/env bash
# Dump the HireCraft Postgres DB to a host-side file that survives Docker/volume
# loss. Run before any risky rebuild/reset:  ./scripts/db-backup.sh
# Restore with:  ./scripts/db-restore.sh backups/<file>.sql
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p backups
stamp=$(date +%Y%m%d_%H%M%S)
out="backups/hirecraft_${stamp}.sql"
docker compose exec -T postgres pg_dump -U hirecraft --clean --if-exists hirecraft > "$out"
echo "Backup written: $out ($(du -h "$out" | cut -f1))"
# Keep the 20 most recent, prune the rest.
ls -1t backups/hirecraft_*.sql 2>/dev/null | tail -n +21 | xargs -r rm -f
