#!/bin/sh
# nodeid.sh — Node identification display for phone cluster
# Rendered by: greetd -> cage -> foot -> this script
# Shell: ash (BusyBox) — no bash syntax allowed
#
# Template variables (replaced by deploy-everything.sh):
#   %%NODE_NUM%%  — node number (1-10)
#   %%ETH_IP%%   — ethernet subnet IP
#   %%WIFI_IP%%  — WiFi network IP

NODE_NUM="%%NODE_NUM%%"
ETH_IP="%%ETH_IP%%"
WIFI_IP="%%WIFI_IP%%"

while true; do
  clear

  # Get live network IPs (fall back to configured values)
  LIVE_WIFI=$(ip -4 addr show wlan0 2>/dev/null | grep -o 'inet [0-9.]*' | cut -d' ' -f2)
  LIVE_ETH=$(ip -4 addr show eth0 2>/dev/null | grep -o 'inet [0-9.]*' | cut -d' ' -f2)
  [ -z "$LIVE_WIFI" ] && LIVE_WIFI="$WIFI_IP"
  [ -z "$LIVE_ETH" ] && LIVE_ETH="$ETH_IP"

  # Battery info
  BAT_CAP="?"
  BAT_STATUS="?"
  if [ -f /sys/class/power_supply/battery/capacity ]; then
    BAT_CAP=$(cat /sys/class/power_supply/battery/capacity 2>/dev/null)
  fi
  if [ -f /sys/class/power_supply/battery/status ]; then
    BAT_STATUS=$(cat /sys/class/power_supply/battery/status 2>/dev/null)
  fi

  # Uptime
  UPTIME=$(uptime 2>/dev/null | sed 's/.*up /up /' | sed 's/,.*load.*//')

  # Mining status
  MINING="OFF"
  if pgrep -x xmrig >/dev/null 2>&1; then
    MINING="MINING"
  fi

  # Worker status
  WORKER="OFF"
  WORKER_TASK=""
  if pgrep -f "worker.py" >/dev/null 2>&1; then
    WORKER="RUNNING"
    # Try to get last log line for current task
    WORKER_TASK=$(tail -1 /home/user/worker.log 2>/dev/null | cut -c1-40)
  fi

  # Online check (can we reach the gateway?)
  ONLINE="OFFLINE"
  if ping -c1 -W2 192.168.1.1 >/dev/null 2>&1; then
    ONLINE="ONLINE"
  fi

  # CPU load
  LOAD=$(cat /proc/loadavg 2>/dev/null | cut -d' ' -f1-3)

  echo "=================================="
  echo ""
  echo "         NODE  ${NODE_NUM}"
  echo ""
  echo "=================================="
  echo ""
  echo "  WiFi:     ${LIVE_WIFI}"
  echo "  Ethernet: ${LIVE_ETH}"
  echo ""
  echo "  Battery:  ${BAT_CAP}% (${BAT_STATUS})"
  echo "  Status:   ${ONLINE}"
  echo "  Mining:   ${MINING}"
  echo "  Worker:   ${WORKER}"
  if [ -n "$WORKER_TASK" ]; then
    echo "  Task:     ${WORKER_TASK}"
  fi
  echo "  Load:     ${LOAD}"
  echo "  ${UPTIME}"
  echo ""
  echo "=================================="

  sleep 30
done
