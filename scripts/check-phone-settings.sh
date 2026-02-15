#!/bin/bash
# Check settings across all cluster phones and show a comparison report
# Run from node1: bash /home/user/scripts/check-phone-settings.sh
# Shows: lock screen, idle delay, font, theme, brightness, greetd, apps, etc.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/cluster-nodes.conf" ]; then
  . "$SCRIPT_DIR/cluster-nodes.conf"
  load_node_config
else
  ALL_NODES="node1:192.168.1.206 node2:192.168.1.207 node3:192.168.1.208 node4:192.168.1.209 node5:192.168.1.210 node6:192.168.1.211 node7:192.168.1.212 node8:192.168.1.213 node9:192.168.1.214 node10:192.168.1.215"
fi

LOCAL_IP=$(ip -4 addr show wlan0 2>/dev/null | grep -o 'inet [0-9.]*' | cut -d' ' -f2)
[ -z "$LOCAL_IP" ] && LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -z "$LOCAL_IP" ] && LOCAL_IP="192.168.1.206"
ALL_LOCAL_IPS=$(ip -4 addr 2>/dev/null | grep -o 'inet [0-9.]*' | cut -d' ' -f2 | tr '\n' ' ')

is_local_ip() {
  [ "$1" = "$LOCAL_IP" ] && return 0
  for _lip in $ALL_LOCAL_IPS; do [ "$1" = "$_lip" ] && return 0; done
  return 1
}

TMP_DIR=$(mktemp -d /tmp/phone-settings-XXXXXX)
trap 'rm -rf "$TMP_DIR"' EXIT

# ── Settings probe command (runs on each phone) ──────────────────────
SETTINGS_CMD='
UID_NUM=$(id -u)
export XDG_RUNTIME_DIR=/run/user/$UID_NUM
export WAYLAND_DISPLAY=wayland-0
export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$UID_NUM/bus

echo "=== LOCK SCREEN ==="
echo "lock-enabled=$(dconf read /org/gnome/desktop/screensaver/lock-enabled 2>/dev/null || echo "(unset)")"
echo "idle-delay=$(dconf read /org/gnome/desktop/session/idle-delay 2>/dev/null || echo "(unset)")"
echo "disable-lock-screen=$(dconf read /org/gnome/desktop/lockdown/disable-lock-screen 2>/dev/null || echo "(unset)")"

echo "=== DCONF OVERRIDE ==="
if [ -f /etc/dconf/db/local.d/00-no-lock ]; then
  echo "override-file=EXISTS"
  cat /etc/dconf/db/local.d/00-no-lock 2>/dev/null | tr "\n" "|"
  echo
else
  echo "override-file=MISSING"
fi
if [ -f /etc/dconf/profile/user ]; then
  echo "dconf-profile=EXISTS"
else
  echo "dconf-profile=MISSING"
fi

echo "=== DISPLAY ==="
for f in /sys/class/backlight/*/brightness; do
  echo "brightness=$(cat "$f" 2>/dev/null || echo "N/A")"
  break
done
for f in /sys/class/backlight/*/bl_power; do
  echo "bl_power=$(cat "$f" 2>/dev/null || echo "N/A")"
  break
done

echo "=== FONT & THEME ==="
echo "font-name=$(gsettings get org.gnome.desktop.interface font-name 2>/dev/null || dconf read /org/gnome/desktop/interface/font-name 2>/dev/null || echo "(unset)")"
echo "text-scaling=$(gsettings get org.gnome.desktop.interface text-scaling-factor 2>/dev/null || dconf read /org/gnome/desktop/interface/text-scaling-factor 2>/dev/null || echo "(unset)")"
echo "gtk-theme=$(gsettings get org.gnome.desktop.interface gtk-theme 2>/dev/null || dconf read /org/gnome/desktop/interface/gtk-theme 2>/dev/null || echo "(unset)")"
echo "icon-theme=$(gsettings get org.gnome.desktop.interface icon-theme 2>/dev/null || dconf read /org/gnome/desktop/interface/icon-theme 2>/dev/null || echo "(unset)")"
echo "color-scheme=$(gsettings get org.gnome.desktop.interface color-scheme 2>/dev/null || dconf read /org/gnome/desktop/interface/color-scheme 2>/dev/null || echo "(unset)")"

echo "=== GREETD ==="
if [ -f /etc/greetd/config.toml ]; then
  echo "greetd-config=EXISTS"
  cat /etc/greetd/config.toml 2>/dev/null | tr "\n" "|"
  echo
else
  echo "greetd-config=MISSING"
fi

echo "=== SCREENSAVER ==="
echo "screensaver-active=$(dbus-send --session --dest=org.gnome.ScreenSaver --type=method_call --print-reply /org/gnome/ScreenSaver org.gnome.ScreenSaver.GetActive 2>/dev/null | grep boolean | awk "{print \$2}" || echo "unknown")"

echo "=== APPS ==="
# List user-visible .desktop apps (non-system)
ls /usr/share/applications/*.desktop 2>/dev/null | wc -l | xargs -I{} echo "desktop-apps={}"
# Check key apps
for app in firefox-esr chromium epiphany phosh-mobile-settings gnome-text-editor; do
  if command -v "$app" >/dev/null 2>&1; then
    echo "app-${app}=installed"
  else
    echo "app-${app}=not-found"
  fi
done

echo "=== MISC ==="
echo "hostname=$(hostname 2>/dev/null)"
echo "uptime=$(uptime -p 2>/dev/null || uptime 2>/dev/null)"
echo "phosh-running=$(pgrep -x phosh >/dev/null 2>&1 && echo yes || echo no)"
echo "cage-running=$(pgrep -x cage >/dev/null 2>&1 && echo yes || echo no)"
'

# ── Run on all nodes in parallel ─────────────────────────────────────
echo "Checking settings on all phones..."
echo ""

for entry in $ALL_NODES; do
  name="${entry%%:*}"
  ip="${entry#*:}"
  (
    if is_local_ip "$ip"; then
      sh -c "$SETTINGS_CMD" > "$TMP_DIR/${name}.txt" 2>/dev/null
    else
      ssh -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
        "user@${ip}" "$SETTINGS_CMD" > "$TMP_DIR/${name}.txt" 2>/dev/null
    fi
    if [ ! -s "$TMP_DIR/${name}.txt" ]; then
      echo "UNREACHABLE" > "$TMP_DIR/${name}.txt"
    fi
  ) &
done
wait

# ── Parse & display results ──────────────────────────────────────────

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# Collect values for each setting across nodes to detect differences
declare -A NODE_VALS

extract_val() {
  local file="$1" key="$2"
  grep "^${key}=" "$file" 2>/dev/null | head -1 | cut -d'=' -f2-
}

SETTINGS_KEYS="lock-enabled idle-delay disable-lock-screen override-file dconf-profile brightness bl_power font-name text-scaling gtk-theme icon-theme color-scheme greetd-config screensaver-active phosh-running cage-running"

# Print header
printf "\n${BOLD}%-14s" "SETTING"
for entry in $ALL_NODES; do
  name="${entry%%:*}"
  printf "%-14s" "$name"
done
printf "${NC}\n"
printf '%.0s─' $(seq 1 $((14 + 14 * 10)))
echo ""

# For each setting, print row and flag differences
for key in $SETTINGS_KEYS; do
  vals=""
  first_val=""
  differs=0

  for entry in $ALL_NODES; do
    name="${entry%%:*}"
    file="$TMP_DIR/${name}.txt"
    if [ "$(cat "$file" 2>/dev/null)" = "UNREACHABLE" ]; then
      val="OFFLINE"
    else
      val=$(extract_val "$file" "$key")
      [ -z "$val" ] && val="--"
    fi
    NODE_VALS["${name}_${key}"]="$val"

    if [ -z "$first_val" ]; then
      first_val="$val"
    elif [ "$val" != "$first_val" ] && [ "$val" != "OFFLINE" ] && [ "$first_val" != "OFFLINE" ]; then
      differs=1
    fi
  done

  # Print row
  if [ "$differs" -eq 1 ]; then
    printf "${YELLOW}%-14s" "$key"
  else
    printf "%-14s" "$key"
  fi

  for entry in $ALL_NODES; do
    name="${entry%%:*}"
    val="${NODE_VALS["${name}_${key}"]}"
    if [ "$val" = "OFFLINE" ]; then
      printf "${RED}%-14s${NC}" "$val"
    elif [ "$differs" -eq 1 ]; then
      printf "${YELLOW}%-14s${NC}" "$val"
    else
      printf "${GREEN}%-14s${NC}" "$val"
    fi
  done
  echo ""
done

# ── Highlight differences ────────────────────────────────────────────
echo ""
printf "${BOLD}=== DIFFERENCES DETECTED ===${NC}\n"
found_diff=0
for key in $SETTINGS_KEYS; do
  vals_list=""
  for entry in $ALL_NODES; do
    name="${entry%%:*}"
    val="${NODE_VALS["${name}_${key}"]}"
    [ "$val" = "OFFLINE" ] && continue
    vals_list="$vals_list|$val"
  done

  unique=$(echo "$vals_list" | tr '|' '\n' | sort -u | grep -c .)
  if [ "$unique" -gt 1 ]; then
    found_diff=1
    printf "${YELLOW}  $key:${NC}\n"
    for entry in $ALL_NODES; do
      name="${entry%%:*}"
      val="${NODE_VALS["${name}_${key}"]}"
      [ "$val" = "OFFLINE" ] && continue
      printf "    %-10s = %s\n" "$name" "$val"
    done
  fi
done
if [ "$found_diff" -eq 0 ]; then
  printf "${GREEN}  None — all phones have identical settings.${NC}\n"
fi

# ── Per-node app list ────────────────────────────────────────────────
echo ""
printf "${BOLD}=== INSTALLED APPS ===${NC}\n"
for entry in $ALL_NODES; do
  name="${entry%%:*}"
  file="$TMP_DIR/${name}.txt"
  if [ "$(cat "$file" 2>/dev/null)" = "UNREACHABLE" ]; then
    printf "  ${RED}%-10s OFFLINE${NC}\n" "$name:"
    continue
  fi
  apps=""
  for app in firefox-esr chromium epiphany phosh-mobile-settings gnome-text-editor; do
    val=$(extract_val "$file" "app-${app}")
    if [ "$val" = "installed" ]; then
      apps="$apps $app"
    fi
  done
  count=$(extract_val "$file" "desktop-apps")
  printf "  %-10s %s desktop files | installed: %s\n" "$name:" "${count:-?}" "${apps:- (none detected)}"
done

echo ""
printf "${BOLD}=== GREETD CONFIG (per node) ===${NC}\n"
for entry in $ALL_NODES; do
  name="${entry%%:*}"
  file="$TMP_DIR/${name}.txt"
  if [ "$(cat "$file" 2>/dev/null)" = "UNREACHABLE" ]; then
    printf "  ${RED}%-10s OFFLINE${NC}\n" "$name:"
    continue
  fi
  greetd_status=$(extract_val "$file" "greetd-config")
  if [ "$greetd_status" = "EXISTS" ]; then
    raw=$(grep "^\\[terminal\\]\\|^vt\\|^command\\|^user" "$file" 2>/dev/null | head -4)
    greetd_line=$(grep "|" "$file" 2>/dev/null | grep -i "command\|terminal\|vt" | head -1)
    printf "  %-10s %s\n" "$name:" "$(echo "$greetd_line" | tr '|' ' ' | sed 's/  */ /g')"
  else
    printf "  %-10s %s\n" "$name:" "NO CONFIG"
  fi
done

echo ""
echo "Done. Any yellow rows above indicate settings that differ between phones."
