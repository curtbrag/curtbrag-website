#!/usr/bin/env bash
# Curt Cluster Live Bridge
# Runs on Nexus and keeps curtbrag.com/cluster/dashboard synchronized with
# the actual Termux phone fleet. No phone-side agent is required.
set +e

API_URL="${API_URL:-https://curtbrag.com/.netlify/functions/cluster-api}"
WEB_PASSWORD="${WEB_PASSWORD:-${CLUSTER_WEB_PASSWORD:-}}"
WALLET="${WALLET:-}"
POOL="${POOL:-gulf.moneroocean.stream:10128}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
PHONE_USER="${PHONE_USER:-user}"
PHONE_PORT="${PHONE_PORT:-8022}"
PHONE_HINT="${PHONE_HINT:-90}"
PHONES="${PHONES:-173 174 195 176 177 191 253 254}"
NEXUS_IP="${NEXUS_IP:-192.168.1.192}"
POLL_INTERVAL="${POLL_INTERVAL:-5}"
IDLE_INTERVAL="${IDLE_INTERVAL:-30}"
STATUS_INTERVAL="${STATUS_INTERVAL:-90}"
LOG_FILE="${LOG_FILE:-$HOME/curt_cluster_bridge.log}"
BRIDGE_START_MS="$(date +%s%3N 2>/dev/null || echo 0)"
LAST_STATUS_SCAN=0
LAST_HEARTBEAT=0

[ -n "$WEB_PASSWORD" ] || { echo "ERROR: WEB_PASSWORD or CLUSTER_WEB_PASSWORD required" >&2; exit 1; }
[ -n "$WALLET" ] || { echo "ERROR: WALLET required" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "ERROR: curl required" >&2; exit 1; }
command -v ssh >/dev/null 2>&1 || { echo "ERROR: ssh required" >&2; exit 1; }
[ -f "$SSH_KEY" ] || { echo "ERROR: SSH key not found: $SSH_KEY" >&2; exit 1; }

log() { printf '[%(%F %T)T] %s\n' -1 "$*" | tee -a "$LOG_FILE" >&2; }

api_get() {
  curl -fsS --max-time 20 "$API_URL?action=$1" \
    -H "Authorization: Bearer $WEB_PASSWORD"
}

api_post() {
  curl -fsS --max-time 20 -X POST "$API_URL?action=$1" \
    -H "Authorization: Bearer $WEB_PASSWORD" \
    -H "Content-Type: application/json" \
    --data "$2"
}

heartbeat() {
  local body
  body="$(jq -nc --arg h "$(hostname 2>/dev/null || echo nexus)" --arg s "$1" '{hostname:$h,summary:$s}')"
  api_post bridge-heartbeat "$body" >/dev/null 2>&1 || true
}

complete_cmd() {
  local body
  body="$(jq -nc \
    --arg id "$1" --arg target "$2" --arg type "$3" \
    --arg rs "$4" --arg out "$5" \
    '{id:$id,target:$target,type:$type,result_summary:$rs,output:$out}')"
  api_post bridge-complete "$body" >/dev/null 2>&1 || true
}

phone_ssh() {
  local octet="$1"; shift
  timeout 60 ssh -n -p "$PHONE_PORT" -i "$SSH_KEY" \
    -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=5 \
    -o ConnectionAttempts=1 -o ServerAliveInterval=2 -o ServerAliveCountMax=2 \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
    "$PHONE_USER@192.168.1.$octet" "$@"
}

pool_host() {
  printf '%s' "$POOL" | sed -E 's#^[a-zA-Z+]+://##; s#:[0-9]+$##'
}

pool_port() {
  local p
  p="$(printf '%s' "$POOL" | sed -E 's#^[a-zA-Z+]+://##' | awk -F: '{print $NF}')"
  case "$p" in ''|*[!0-9]*) echo 10128;; *) echo "$p";; esac
}

phone_name_for_octet() { echo "phone$1"; }
phone_octet_for_name() { printf '%s' "$1" | sed -n 's/^phone\([0-9][0-9]*\)$/\1/p'; }

get_devices_json() {
  api_get devices 2>/dev/null || echo '{"devices":[]}'
}

ensure_device() {
  local hostname="$1" ip="$2" klass="$3" role="$4" data body id current
  data="$(get_devices_json)"
  id="$(printf '%s' "$data" | jq -r --arg h "$hostname" '.devices[]? | select(.hostname==$h) | .id' | head -1)"
  current="$(printf '%s' "$data" | jq -r --arg h "$hostname" '.devices[]? | select(.hostname==$h) | .current_ip // empty' | head -1)"

  # create-device cannot change current_ip, so replace a stale pre-seeded record.
  if [ -n "$id" ] && [ -n "$current" ] && [ "$current" != "$ip" ]; then
    body="$(jq -nc --arg id "$id" '{device_id:$id}')"
    api_post delete-device "$body" >/dev/null 2>&1 || true
    id=""
  fi

  if [ -z "$id" ]; then
    body="$(jq -nc --arg h "$hostname" --arg ip "$ip" --arg c "$klass" --arg r "$role" \
      '{hostname:$h,ip:$ip,device_class:$c,cluster_role:$r}')"
    api_post create-device "$body" >/dev/null 2>&1 || true
  fi
}

rebuild_groups() {
  local data phone_ids nexus_id all_ids body
  data="$(get_devices_json)"
  phone_ids="$(printf '%s' "$data" | jq -c '[.devices[]? | select(.hostname|test("^phone(173|174|195|176|177|191|253|254)$")) | .id]')"
  nexus_id="$(printf '%s' "$data" | jq -c '[.devices[]? | select(.hostname=="nexus") | .id]')"
  all_ids="$(jq -nc --argjson a "$phone_ids" --argjson b "$nexus_id" '$a+$b')"

  body="$(jq -nc --argjson ids "$phone_ids" '{group_id:"phones",group_name:"Phones",device_ids:$ids,description:"Current eight OnePlus 6T workers"}')"
  api_post save-group "$body" >/dev/null 2>&1 || true
  body="$(jq -nc --argjson ids "$nexus_id" '{group_id:"pcs",group_name:"Controllers",device_ids:$ids,description:"Active Nexus controller"}')"
  api_post save-group "$body" >/dev/null 2>&1 || true
  body="$(jq -nc --argjson ids "$all_ids" '{group_id:"all",group_name:"Active Fleet",device_ids:$ids,description:"Current live cluster"}')"
  api_post save-group "$body" >/dev/null 2>&1 || true
}

normalize_dead_pool() {
  local data h id old body host port
  data="$(get_devices_json)"
  host="$(pool_host)"; port="$(pool_port)"
  for h in $(for p in $PHONES; do phone_name_for_octet "$p"; done); do
    id="$(printf '%s' "$data" | jq -r --arg h "$h" '.devices[]? | select(.hostname==$h) | .id' | head -1)"
    old="$(printf '%s' "$data" | jq -r --arg h "$h" '.devices[]? | select(.hostname==$h) | .desired.pool_url // empty' | head -1)"
    [ -n "$id" ] || continue
    if [ -z "$old" ] || [ "$old" = "192.168.1.179" ] || [ "$old" = "192.168.1.175" ]; then
      body="$(jq -nc --arg id "$id" --arg u "$host" --argjson p "$port" \
        '{device_id:$id,pool_url:$u,pool_port:$p,thread_count:6,randomx_mode:"light"}')"
      api_post set-pool-config "$body" >/dev/null 2>&1 || true
    fi
  done
}

reconcile_registry() {
  local data stale_id p h
  log "reconciling dashboard registry to live fleet"
  data="$(get_devices_json)"

  # Remove the known dead DHCP identity from the old topology.
  stale_id="$(printf '%s' "$data" | jq -r '.devices[]? | select(.hostname=="phone175") | .id' | head -1)"
  if [ -n "$stale_id" ]; then
    api_post delete-device "$(jq -nc --arg id "$stale_id" '{device_id:$id}')" >/dev/null 2>&1 || true
  fi

  for p in $PHONES; do
    h="$(phone_name_for_octet "$p")"
    ensure_device "$h" "192.168.1.$p" phone worker
  done
  ensure_device nexus "$NEXUS_IP" pc control-plane
  normalize_dead_pool
  rebuild_groups
}

binary_path_remote='export HOME=/data/data/com.termux/files/home; export PREFIX=/data/data/com.termux/files/usr; export PATH="$PREFIX/bin:$HOME/bin:$PATH"'

phone_raw_status() {
  local p="$1"
  phone_ssh "$p" "
    $binary_path_remote
    pid=\$(pgrep -x xmrig 2>/dev/null | head -1)
    echo PID=\$pid
    if [ -n \"\$pid\" ]; then echo RUNNING=true; else echo RUNNING=false; fi
    log=\$HOME/xmrig.log
    hr=0
    if [ -f \"\$log\" ]; then
      hr=\$(grep 'miner    speed' \"\$log\" 2>/dev/null | tail -1 | awk '{for(i=1;i<=NF;i++) if(\$i ~ /^10s\\/60s\\/15m$/){v=\$(i+2); if(v ~ /^[0-9.]+$/) print v; else print 0; exit}}')
    fi
    echo HASHRATE=\${hr:-0}
    if [ -x \$HOME/bin/xmrig ]; then
      echo BINHASH=\$(sha256sum \$HOME/bin/xmrig 2>/dev/null | awk '{print \$1}')
    else
      echo BINHASH=
    fi
    echo ARGS=\$(tr '\\0' ' ' < /proc/\$pid/cmdline 2>/dev/null)
  " 2>&1
}

push_phone_state() {
  local p="$1" out running hr pid hash body h
  h="$(phone_name_for_octet "$p")"
  out="$(phone_raw_status "$p")"
  if echo "$out" | grep -Eq 'Permission denied|Connection refused|Connection timed out|No route to host|Could not resolve'; then
    return 1
  fi
  running="$(printf '%s\n' "$out" | sed -n 's/^RUNNING=//p' | head -1)"
  hr="$(printf '%s\n' "$out" | sed -n 's/^HASHRATE=//p' | head -1)"
  pid="$(printf '%s\n' "$out" | sed -n 's/^PID=//p' | head -1)"
  hash="$(printf '%s\n' "$out" | sed -n 's/^BINHASH=//p' | head -1)"
  [ "$running" = true ] || running=false
  [[ "$hr" =~ ^[0-9]+([.][0-9]+)?$ ]] || hr=0
  [[ "$pid" =~ ^[0-9]+$ ]] || pid=0
  body="$(jq -nc --arg h "$h" --argjson run "$running" --argjson hr "$hr" --argjson pid "$pid" --arg bh "$hash" \
    '{hostname:$h,observed:{xmrig_running:$run,hashrate_60s:$hr,custom_pid:$pid,binary_hash:$bh,agent_version:"bridge-2.0",workload_type:"mining",workload_enabled:$run,preflight_status:"ok"}}')"
  api_post bridge-touch-device "$body" >/dev/null 2>&1 || true
  printf '%s\n' "$out"
}

push_nexus_state() {
  local running=false pid hr=0 hash="" body
  pid="$(pgrep -x xmrig 2>/dev/null | head -1)"
  [ -n "$pid" ] && running=true
  if [ -f "$HOME/xmrig.log" ]; then
    hr="$(grep 'miner    speed' "$HOME/xmrig.log" 2>/dev/null | tail -1 | awk '{for(i=1;i<=NF;i++) if($i ~ /^10s\/60s\/15m$/){v=$(i+2); if(v ~ /^[0-9.]+$/) print v; else print 0; exit}}')"
  fi
  [ -x "$HOME/bin/xmrig" ] && hash="$(sha256sum "$HOME/bin/xmrig" 2>/dev/null | awk '{print $1}')"
  [[ "$hr" =~ ^[0-9]+([.][0-9]+)?$ ]] || hr=0
  [[ "$pid" =~ ^[0-9]+$ ]] || pid=0
  body="$(jq -nc --argjson run "$running" --argjson hr "$hr" --argjson pid "$pid" --arg bh "$hash" \
    '{hostname:"nexus",observed:{xmrig_running:$run,hashrate_60s:$hr,custom_pid:$pid,binary_hash:$bh,agent_version:"bridge-2.0",workload_type:"mining",workload_enabled:$run}}')"
  api_post bridge-touch-device "$body" >/dev/null 2>&1 || true
}

phone_device_json() {
  local h="$1" data
  data="$(get_devices_json)"
  printf '%s' "$data" | jq -c --arg h "$h" '.devices[]? | select(.hostname==$h)' | head -1
}

phone_start() {
  local p="$1" force="${2:-0}" h dev desired poolh poolp threads rx approved actual current_args user
  h="$(phone_name_for_octet "$p")"
  dev="$(phone_device_json "$h")"
  desired="$(printf '%s' "$dev" | jq -c '.desired // {}')"
  poolh="$(printf '%s' "$desired" | jq -r '.pool_url // empty')"
  poolp="$(printf '%s' "$desired" | jq -r '.pool_port // empty')"
  threads="$(printf '%s' "$desired" | jq -r '.thread_count // empty')"
  rx="$(printf '%s' "$desired" | jq -r '.randomx_mode // "light"')"
  approved="$(printf '%s' "$desired" | jq -r '.approved_binary_hash // empty')"

  [ -n "$poolh" ] || poolh="$(pool_host)"
  [ -n "$poolp" ] || poolp="$(pool_port)"
  [ "$poolh" = "192.168.1.179" ] && poolh="$(pool_host)"
  [[ "$threads" =~ ^[0-9]+$ ]] || threads=6
  case "$rx" in light|fast|auto) ;; *) rx=light;; esac
  user="$WALLET.$h"

  phone_ssh "$p" "
    $binary_path_remote
    BIN=\$HOME/bin/xmrig
    [ -x \"\$BIN\" ] || { echo NO_BIN; exit 0; }
    if [ -n '$approved' ]; then
      ACTUAL=\$(sha256sum \"\$BIN\" 2>/dev/null | awk '{print \$1}')
      [ \"\$ACTUAL\" = '$approved' ] || { echo BLOCKED_BINARY_HASH_MISMATCH; exit 0; }
    fi
    OLD=\$(pgrep -af xmrig 2>/dev/null | grep -v grep)
    if [ '$force' != 1 ] && echo \"\$OLD\" | grep -q '$user' && echo \"\$OLD\" | grep -q '$poolh:$poolp'; then
      echo ALREADY_RUNNING_CORRECT
    else
      pkill -9 xmrig 2>/dev/null || true
      sleep 1
      : > \$HOME/xmrig.log
      nohup \"\$BIN\" \
        -o '$poolh:$poolp' \
        -u '$user' -p x -k \
        --threads='$threads' \
        --randomx-mode='$rx' \
        --print-time=10 \
        --log-file=\$HOME/xmrig.log \
        --no-color >/dev/null 2>&1 &
      sleep 4
    fi
    pgrep -af xmrig 2>/dev/null | grep -v grep || echo NO_PROCESS
    tail -20 \$HOME/xmrig.log 2>/dev/null | grep -E 'miner    speed|new job|accepted|error' | tail -5 || true
  "
}

phone_stop() {
  local p="$1"
  phone_ssh "$p" "$binary_path_remote; pkill -9 xmrig 2>/dev/null || true; sleep 1; pgrep -x xmrig >/dev/null && echo STILL_RUNNING || echo STOPPED"
}

phone_diagnostic() {
  local p="$1"
  phone_ssh "$p" "
    $binary_path_remote
    echo HOST=\$(hostname 2>/dev/null)
    echo USER=\$(whoami)
    echo UPTIME=\$(uptime 2>/dev/null)
    echo DISK=\$(df -h \$HOME 2>/dev/null | tail -1)
    echo MEM=\$(free -h 2>/dev/null | head -2 | tail -1)
    echo XMRIG=\$(pgrep -x xmrig 2>/dev/null | tr '\\n' ',')
    echo SSHD=\$(pgrep -x sshd 2>/dev/null | head -1)
    echo BIN=\$(test -x \$HOME/bin/xmrig && echo READY || echo MISSING)
    echo HASH=\$(sha256sum \$HOME/bin/xmrig 2>/dev/null | awk '{print \$1}')
    tail -25 \$HOME/xmrig.log 2>/dev/null || true
  "
}

controller_status() {
  echo "HOST=$(hostname 2>/dev/null || echo nexus)"
  pgrep -af xmrig 2>/dev/null | grep -v grep || echo NO_XMRIG
  grep 'miner    speed' "$HOME/xmrig.log" 2>/dev/null | tail -3 || echo NO_SPEED
}

controller_start() {
  local bin="" log="$HOME/xmrig.log"
  [ -x "$HOME/bin/xmrig" ] && bin="$HOME/bin/xmrig"
  [ -z "$bin" ] && [ -x "$HOME/xmrig/xmrig" ] && bin="$HOME/xmrig/xmrig"
  [ -z "$bin" ] && { echo NO_BIN; return; }
  pkill -9 xmrig 2>/dev/null || true
  : > "$log"
  nohup "$bin" -o "$POOL" -u "$WALLET.nexus" -p x -k --print-time=10 --log-file="$log" --no-color >/dev/null 2>&1 &
  sleep 4
  controller_status
}

controller_stop() {
  pkill -9 xmrig 2>/dev/null || true
  sleep 1
  pgrep -x xmrig >/dev/null && echo STILL_RUNNING || echo STOPPED
}

resolve_target_list() {
  local target="$1" data name ids id
  case "$target" in
    all|"") for p in $PHONES; do printf 'phone%s ' "$p"; done; echo nexus; return;;
    phones) for p in $PHONES; do printf 'phone%s ' "$p"; done; echo; return;;
    pcs) echo nexus; return;;
    nexus|controller|skynet) echo nexus; return;;
    phone*) echo "$target"; return;;
  esac

  data="$(get_devices_json)"
  name="$(printf '%s' "$data" | jq -r --arg t "$target" '.devices[]? | select(.id==$t || .hostname==$t) | .hostname' | head -1)"
  if [ -n "$name" ]; then echo "$name"; return; fi

  ids="$(api_get groups 2>/dev/null | jq -r --arg g "$target" '.groups[]? | select(.id==$g) | .device_ids[]?' 2>/dev/null)"
  if [ -n "$ids" ]; then
    for id in $ids; do
      name="$(printf '%s' "$data" | jq -r --arg id "$id" '.devices[]? | select(.id==$id) | .hostname' | head -1)"
      [ -n "$name" ] && printf '%s ' "$name"
    done
    echo
    return
  fi
  echo "$target"
}

run_node_cmd() {
  local node="$1" type="$2" p
  case "$node" in
    phone*)
      p="$(phone_octet_for_name "$node")"
      [ -n "$p" ] || { echo UNKNOWN_PHONE; return; }
      case "$type" in
        mining-start|fresh-connect|start) phone_start "$p" 0;;
        restart) phone_start "$p" 1;;
        mining-stop|stop|kill-rogue) phone_stop "$p";;
        mining-status|verify-all|status|fetch-logs) push_phone_state "$p";;
        run-diagnostic) phone_diagnostic "$p";;
        reconcile) apply_desired_one "$p" 1; push_phone_state "$p";;
        reset-restart-count) echo RESET_OK;;
        reboot) echo REBOOT_UNSUPPORTED_NO_ROOT;;
        *) echo "UNSUPPORTED_COMMAND_FOR_PHONE $type";;
      esac
      ;;
    nexus|controller|skynet)
      case "$type" in
        mining-start|fresh-connect|start|restart) controller_start;;
        mining-stop|stop|kill-rogue) controller_stop;;
        mining-status|verify-all|status|run-diagnostic|fetch-logs|reconcile) controller_status;;
        reboot) echo REBOOT_SKIPPED_SAFETY;;
        *) echo "UNSUPPORTED_COMMAND_FOR_NEXUS $type";;
      esac
      ;;
    *) echo "UNKNOWN_TARGET $node";;
  esac
}

apply_desired_one() {
  local p="$1" force="${2:-0}" h dev updated enabled running out
  h="$(phone_name_for_octet "$p")"
  dev="$(phone_device_json "$h")"
  [ -n "$dev" ] || return 0
  updated="$(printf '%s' "$dev" | jq -r '.desired.updated_at // 0')"
  [[ "$updated" =~ ^[0-9]+$ ]] || updated=0
  if [ "$force" != 1 ] && [ "$updated" -lt "$BRIDGE_START_MS" ]; then return 0; fi
  enabled="$(printf '%s' "$dev" | jq -r 'if (.quarantined==true) then false else (.desired.miner_enabled // .desired.workload_enabled // false) end')"
  out="$(phone_raw_status "$p")"
  running="$(printf '%s\n' "$out" | sed -n 's/^RUNNING=//p' | head -1)"
  [ "$running" = true ] || running=false
  if [ "$enabled" = true ]; then
    phone_start "$p" "$force" >/dev/null 2>&1 || true
  elif [ "$running" = true ]; then
    phone_stop "$p" >/dev/null 2>&1 || true
  fi
}

refresh_fleet() {
  local p
  heartbeat "live fleet scan"
  LAST_HEARTBEAT="$(date +%s)"
  for p in $PHONES; do
    apply_desired_one "$p" 0
    push_phone_state "$p" >/dev/null 2>&1 || true
  done
  push_nexus_state
  LAST_STATUS_SCAN="$(date +%s)"
}

execute_command() {
  local id="$1" target="$2" type="$3" output="" node node_out
  log "executing id=$id target=$target type=$type"
  for node in $(resolve_target_list "$target"); do
    node_out="$(run_node_cmd "$node" "$type" 2>&1)"
    output+=$'\n===== '"$node / $type"$' =====\n'"$node_out"$'\n'
    case "$node" in phone*) push_phone_state "$(phone_octet_for_name "$node")" >/dev/null 2>&1 || true;; nexus) push_nexus_state;; esac
  done
  printf '%s' "$output"
}

run_once() {
  local now
  now="$(date +%s)"
  if [ $((now - LAST_HEARTBEAT)) -ge 30 ]; then
    heartbeat "polling website"
    LAST_HEARTBEAT="$now"
  fi
  local data cmd id target type output
  data="$(api_get commands 2>/dev/null)" || { log "could not fetch command queue"; return 2; }
  cmd="$(printf '%s' "$data" | jq -c '.queue[0] // empty')"
  [ -n "$cmd" ] || return 1
  id="$(printf '%s' "$cmd" | jq -r '.id // empty')"
  target="$(printf '%s' "$cmd" | jq -r '.target // "all"')"
  type="$(printf '%s' "$cmd" | jq -r '.type // .command // empty')"
  [ -n "$id" ] || return 2
  [ -n "$type" ] || { complete_cmd "$id" "$target" unknown "skipped: missing type" "missing type"; return 0; }
  case "$type" in
    mining-start|mining-stop|mining-status|fresh-connect|restart|start|stop|status|verify-all|kill-rogue|reconcile|run-diagnostic|fetch-logs|reset-restart-count|reboot) ;;
    *) complete_cmd "$id" "$target" "$type" "skipped: not allowlisted" "Denied $type"; return 0;;
  esac
  output="$(execute_command "$id" "$target" "$type")"
  complete_cmd "$id" "$target" "$type" "completed $type -> $target" "$output"
  log "completed id=$id"
  return 0
}

case "${1:---loop}" in
  --once)
    reconcile_registry
    refresh_fleet
    run_once
    ;;
  --loop)
    log "live bridge starting api=$API_URL phones=$PHONES nexus=$NEXUS_IP"
    reconcile_registry
    refresh_fleet
    while true; do
      run_once
      rc=$?
      now="$(date +%s)"
      if [ $((now - LAST_STATUS_SCAN)) -ge "$STATUS_INTERVAL" ]; then refresh_fleet; fi
      if [ "$rc" -eq 0 ]; then sleep "$POLL_INTERVAL"; else sleep "$IDLE_INTERVAL"; fi
    done
    ;;
  *)
    echo "Usage: $0 [--once|--loop]" >&2
    exit 2
    ;;
esac
