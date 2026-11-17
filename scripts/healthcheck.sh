#!/usr/bin/env bash
# Health check for Agent Flow. Usage: scripts/healthcheck.sh [base-url] [host-header]
# Default checks from inside the container (no published port needed).
# Exit 0 = UI and /stats both OK. Roll back with `docker compose down` on failure.
set -u
if [ $# -ge 1 ]; then
  base=$1; hdr=${2:-}
  ui=$(curl -fsS -m 10 ${hdr:+-H "Host: $hdr"} -o /dev/null -w '%{http_code}' "$base/") || ui=fail
  st=$(curl -fsS -m 10 ${hdr:+-H "Host: $hdr"} "$base/stats" | head -c 1) || st=fail
else
  ui=$(docker exec agent-flow node -e "fetch('http://127.0.0.1:3001/',{headers:{host:'agent-flow:3001'}}).then(r=>console.log(r.status))" 2>/dev/null) || ui=fail
  st=$(docker exec agent-flow node -e "fetch('http://127.0.0.1:3001/stats',{headers:{host:'agent-flow:3001'}}).then(r=>r.text()).then(t=>console.log(t[0]))" 2>/dev/null) || st=fail
fi
echo "ui=$ui stats_first_char=$st"
[ "$ui" = 200 ] && [ "$st" = "{" ]
