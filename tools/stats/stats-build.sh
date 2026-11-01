#!/usr/bin/env bash
# Builds the /admin/visitors page from the host nginx log for saybooks.io. Runs every 10 minutes from
# /etc/cron.d/saybooks-stats. Output lands in /opt/saybooks-stats/out, which the saybooks container
# mounts read-only at /stats and serves only to the SAYBOOKS_ADMIN account.
set -euo pipefail
D=/opt/saybooks-stats
L=/var/log/nginx/saybooks
mkdir -p "$D/out"

logs() {
  for f in "$L/access.log" "$L/access.log.1"; do [ -f "$f" ] && cat "$f"; done
  for f in "$L"/access.log.*.gz; do [ -f "$f" ] && zcat "$f"; done
  true
}

logs | STATS_HOME=$D python3 "$D/tools/stats-build.py" > "$D/out/index.html.tmp" && mv "$D/out/index.html.tmp" "$D/out/index.html"
chmod 644 "$D/out/index.html"
