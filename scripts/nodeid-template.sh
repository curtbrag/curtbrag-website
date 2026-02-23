#!/bin/sh
# Node identification display — shows on each phone's screen via greetd/cage/foot
# NODE_NUM is replaced per-phone during deployment (e.g., sed 's/__NODE_NUM__/3/g')

NODE_NUM="__NODE_NUM__"

# Network IPs for this node
case "$NODE_NUM" in
  1)  ETH_IP="10.0.0.11";  WIFI_IP="192.168.1.206" ;;
  2)  ETH_IP="10.0.0.2";   WIFI_IP="192.168.1.207" ;;
  3)  ETH_IP="10.0.0.3";   WIFI_IP="192.168.1.208" ;;
  4)  ETH_IP="10.0.0.4";   WIFI_IP="192.168.1.209" ;;
  5)  ETH_IP="10.0.0.5";   WIFI_IP="192.168.1.210" ;;
  6)  ETH_IP="10.0.0.6";   WIFI_IP="192.168.1.211" ;;
  7)  ETH_IP="10.0.0.7";   WIFI_IP="192.168.1.212" ;;
  8)  ETH_IP="10.0.0.8";   WIFI_IP="192.168.1.213" ;;
  9)  ETH_IP="10.0.0.9";   WIFI_IP="192.168.1.214" ;;
  10) ETH_IP="10.0.0.10";  WIFI_IP="192.168.1.215" ;;
  *)  ETH_IP="unknown";    WIFI_IP="unknown" ;;
esac

while true; do
  clear

  # Check connectivity
  ONLINE="OFFLINE"
  if ping -c 1 -W 2 192.168.1.1 >/dev/null 2>&1 || ping -c 1 -W 2 8.8.8.8 >/dev/null 2>&1; then
    ONLINE="ONLINE"
  fi

  # Battery info
  BATT_LVL=""
  BATT_STATUS=""
  for d in /sys/class/power_supply/*; do
    [ "$(cat "$d/type" 2>/dev/null)" = "Battery" ] || continue
    _CAP=$(cat "$d/capacity" 2>/dev/null || echo -1)
    # If capacity > 100, device reports raw charge — compute from charge_now/charge_full
    if [ "$_CAP" -gt 100 ] 2>/dev/null; then
      _CNOW=$(cat "$d/charge_now" 2>/dev/null || echo 0)
      _CFULL=$(cat "$d/charge_full" 2>/dev/null || echo 0)
      if [ "$_CFULL" -gt 0 ] 2>/dev/null; then
        _CAP=$(( _CNOW * 100 / _CFULL ))
      else
        _CAP=-1
      fi
    fi
    [ "$_CAP" -ge 0 ] 2>/dev/null && BATT_LVL="${_CAP}%"
    BATT_STATUS=$(cat "$d/status" 2>/dev/null || echo "Unknown")
    break
  done

  # Uptime
  UPTIME=""
  if [ -r /proc/uptime ]; then
    _SECS=$(cut -d. -f1 /proc/uptime)
    _DAYS=$(( _SECS / 86400 ))
    _HRS=$(( (_SECS % 86400) / 3600 ))
    _MIN=$(( (_SECS % 3600) / 60 ))
    if [ "$_DAYS" -gt 0 ] 2>/dev/null; then
      UPTIME="${_DAYS}d ${_HRS}h ${_MIN}m"
    elif [ "$_HRS" -gt 0 ] 2>/dev/null; then
      UPTIME="${_HRS}h ${_MIN}m"
    else
      UPTIME="${_MIN}m"
    fi
  fi

  echo ""
  echo "  ================================="
  echo "       CURTBRAG PHONE CLUSTER"
  echo "  ================================="
  echo ""
  echo "         NODE  $NODE_NUM"
  echo ""
  echo "  ---------------------------------"
  echo "  Ethernet:  $ETH_IP"
  echo "  WiFi:      $WIFI_IP"
  echo "  Status:    $ONLINE"
  if [ -n "$BATT_LVL" ]; then
    echo "  Battery:   $BATT_LVL ($BATT_STATUS)"
  fi
  if [ -n "$UPTIME" ]; then
    echo "  Uptime:    $UPTIME"
  fi
  echo "  ---------------------------------"
  echo ""
  echo "  $(date '+%Y-%m-%d %H:%M:%S')"
  echo ""

  sleep 30
done
