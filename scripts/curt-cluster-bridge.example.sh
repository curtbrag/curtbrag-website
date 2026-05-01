#!/usr/bin/env bash
set -euo pipefail
API_URL="${API_URL:-https://curtbrag.com/.netlify/functions/cluster-api}"
WEB_PASSWORD="${WEB_PASSWORD:-${CLUSTER_WEB_PASSWORD:-}}"
WALLET="${WALLET:-}"
POOL="${POOL:-moneroocean.stream:10128}"
SSH_KEY="${SSH_KEY:-}"
[ -n "$WEB_PASSWORD" ] || { echo "Set WEB_PASSWORD or CLUSTER_WEB_PASSWORD"; exit 1; }

allowlisted() {
  case "$1" in
    mining-start|mining-stop|mining-status|fresh-connect|reboot|restart|verify-all) return 0 ;;
    *) return 1 ;;
  esac
}

while true; do
  curl -fsS -X POST "$API_URL?action=bridge-heartbeat" \
    -H "Authorization: Bearer $WEB_PASSWORD" -H 'Content-Type: application/json' \
    -d "{\"hostname\":\"$(hostname)\",\"summary\":\"bridge running\"}" >/dev/null || true

  data=$(curl -fsS "$API_URL?action=commands" -H "Authorization: Bearer $WEB_PASSWORD") || { sleep 5; continue; }
  cmd=$(printf '%s' "$data" | jq -c '.queue[0] // empty')
  if [ -z "$cmd" ]; then sleep 3; continue; fi

  id=$(jq -r '.id' <<<"$cmd"); target=$(jq -r '.target' <<<"$cmd"); type=$(jq -r '.type' <<<"$cmd")
  if ! allowlisted "$type"; then
    summary="skipped: command not allowlisted"
    output="Denied command $type"
  else
    # TODO: Add local LAN SSH logic here.
    # Example: ssh -i "$SSH_KEY" -p 8022 u0_a191@192.168.1.173 "<command>"
    # Use target/type to map to your real fleet and run verified commands only.
    summary="ok"
    output="Executed $type on $target (placeholder) pool=$POOL wallet=${WALLET:+set}"
  fi

  curl -fsS -X POST "$API_URL?action=bridge-complete" \
    -H "Authorization: Bearer $WEB_PASSWORD" -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg id "$id" --arg target "$target" --arg type "$type" --arg rs "$summary" --arg out "$output" '{id:$id,target:$target,type:$type,result_summary:$rs,output:$out}')" >/dev/null || true
  sleep 1
done
