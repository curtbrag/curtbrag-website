#!/bin/sh
#
# cluster-fix-greetd.sh
# Run from node1 — fixes greetd display on all 10 nodes
# Installs missing packages, adds render group, adds startup delay,
# normalizes greetd config, resets and restarts greetd, verifies.
#

PASS="0735"
NODES="206 207 208 209 210 211 212 213 214 215"

echo ""
echo "============================================================"
echo "  CLUSTER GREETD FIX — ALL 10 NODES"
echo "  $(date)"
echo "============================================================"
echo ""

##################################################################
# STEP 1: Build the per-node fix script
##################################################################

cat > /tmp/fix-greetd.sh << 'FIXSCRIPT'
#!/bin/sh
set -e

HOSTNAME=$(hostname)
echo ""
echo ">>>>>>>>>> $HOSTNAME — STARTING FIX <<<<<<<<<<"

#---------------------------------------------------------
# 1. Install missing packages if needed
#---------------------------------------------------------
echo "[$HOSTNAME] Checking packages..."
MISSING=""
which cmatrix  >/dev/null 2>&1 || MISSING="$MISSING cmatrix"
which cbonsai  >/dev/null 2>&1 || MISSING="$MISSING cbonsai"
which figlet   >/dev/null 2>&1 || MISSING="$MISSING figlet"
which cage     >/dev/null 2>&1 || MISSING="$MISSING cage"
which foot     >/dev/null 2>&1 || MISSING="$MISSING foot"

if [ -n "$MISSING" ]; then
  echo "[$HOSTNAME] Installing missing packages:$MISSING"
  apk add --no-cache $MISSING 2>&1
else
  echo "[$HOSTNAME] All packages present"
fi

#---------------------------------------------------------
# 2. Add user to render group if missing
#---------------------------------------------------------
if id user 2>/dev/null | grep -q render; then
  echo "[$HOSTNAME] User already in render group"
else
  echo "[$HOSTNAME] Adding user to render group"
  addgroup user render 2>/dev/null || true
fi

#---------------------------------------------------------
# 3. Ensure user is in seat group if it exists
#---------------------------------------------------------
if getent group seat >/dev/null 2>&1; then
  if ! id user 2>/dev/null | grep -q seat; then
    echo "[$HOSTNAME] Adding user to seat group"
    addgroup user seat 2>/dev/null || true
  fi
fi

#---------------------------------------------------------
# 4. Normalize greetd config (use wrapper script)
#---------------------------------------------------------
echo "[$HOSTNAME] Writing greetd config..."

cat > /etc/greetd/config.toml << 'GREETDCONF'
[terminal]
vt = 7

[default_session]
command = "cage -s -- /home/user/display/greetd-wrapper.sh"
user = "user"
GREETDCONF

cp /etc/greetd/config.toml /etc/phrog/greetd-config.toml 2>/dev/null || true

#---------------------------------------------------------
# 5. Make sure wrapper script exists and is correct
#---------------------------------------------------------
echo "[$HOSTNAME] Writing wrapper script..."

mkdir -p /home/user/display

cat > /home/user/display/greetd-wrapper.sh << 'WRAPPER'
#!/bin/sh
MODE="stats"
[ -f /home/user/display/.mode ] && MODE=$(cat /home/user/display/.mode)
SCR="/home/user/display/${MODE}.sh"
[ ! -f "$SCR" ] && SCR="/home/user/display/stats.sh"
exec foot -f monospace:size=10 -e "$SCR"
WRAPPER

chmod +x /home/user/display/greetd-wrapper.sh
chown user:user /home/user/display/greetd-wrapper.sh

#---------------------------------------------------------
# 6. Make sure matrix.sh exists
#---------------------------------------------------------
if [ ! -f /home/user/display/matrix.sh ]; then
  echo "[$HOSTNAME] Creating matrix.sh"
  cat > /home/user/display/matrix.sh << 'MATRIX'
#!/bin/sh
exec cmatrix -b -s -C green
MATRIX
  chmod +x /home/user/display/matrix.sh
  chown user:user /home/user/display/matrix.sh
fi

#---------------------------------------------------------
# 7. Make sure stats.sh exists (fallback)
#---------------------------------------------------------
if [ ! -f /home/user/display/stats.sh ]; then
  echo "[$HOSTNAME] Creating stats.sh (fallback)"
  cat > /home/user/display/stats.sh << 'STATS'
#!/bin/sh
while true; do
  clear
  echo "========== $(hostname) =========="
  echo ""
  echo "  Uptime: $(uptime -p 2>/dev/null || uptime)"
  echo "  Memory: $(free -h 2>/dev/null | awk '/Mem/{print $3 "/" $2}' || echo 'N/A')"
  echo "  Load:   $(cat /proc/loadavg | awk '{print $1, $2, $3}')"
  echo "  K3s:    $(pgrep k3s-agent >/dev/null 2>&1 && echo 'RUNNING' || echo 'STOPPED')"
  echo "  IP:     $(ip -4 addr show wlan0 2>/dev/null | grep -o 'inet [0-9.]*' | cut -d' ' -f2 || echo 'N/A')"
  echo ""
  echo "  $(date)"
  sleep 5
done
STATS
  chmod +x /home/user/display/stats.sh
  chown user:user /home/user/display/stats.sh
fi

#---------------------------------------------------------
# 8. Verify display mode file
#---------------------------------------------------------
echo "[$HOSTNAME] Display mode: $(cat /home/user/display/.mode 2>/dev/null || echo 'NOT SET')"

#---------------------------------------------------------
# 9. Add greetd startup delay override
#    Gives DRM/GPU time to initialize after boot
#---------------------------------------------------------
echo "[$HOSTNAME] Adding greetd startup delay..."

mkdir -p /usr/lib/systemd/system/greetd.service.d

cat > /usr/lib/systemd/system/greetd.service.d/override.conf << 'OVERRIDE'
[Service]
ExecStartPre=-/usr/bin/killall pbsplash
ExecStartPre=/bin/sleep 3
Restart=on-failure
RestartSec=5
StartLimitIntervalSec=60
StartLimitBurst=10

[Unit]
After=systemd-logind.service
After=dbus.service
Wants=systemd-logind.service
OVERRIDE

#---------------------------------------------------------
# 10. Reload systemd, reset failed, restart greetd
#---------------------------------------------------------
echo "[$HOSTNAME] Reloading systemd..."
systemctl daemon-reload

echo "[$HOSTNAME] Resetting greetd failed state..."
systemctl reset-failed greetd 2>/dev/null || true

echo "[$HOSTNAME] Stopping greetd if running..."
systemctl stop greetd 2>/dev/null || true

# Small delay to let things settle
sleep 2

echo "[$HOSTNAME] Starting greetd..."
systemctl start greetd 2>&1 || true

# Wait for it to either succeed or fail
sleep 5

#---------------------------------------------------------
# 11. Check result
#---------------------------------------------------------
echo ""
echo "[$HOSTNAME] === RESULT ==="
STATUS=$(systemctl is-active greetd 2>&1)
echo "[$HOSTNAME] greetd status: $STATUS"

if [ "$STATUS" = "active" ]; then
  echo "[$HOSTNAME] greetd is RUNNING"
  echo "[$HOSTNAME] cage PID: $(pgrep cage || echo NONE)"
  echo "[$HOSTNAME] foot PID: $(pgrep foot || echo NONE)"
  echo "[$HOSTNAME] cmatrix PID: $(pgrep cmatrix || echo NONE)"
  ls /run/user/10000/wayland-* 2>/dev/null && echo "[$HOSTNAME] Wayland socket: FOUND" || echo "[$HOSTNAME] Wayland socket: NOT FOUND"
else
  echo "[$HOSTNAME] greetd FAILED — capturing cage error..."
  # Try running cage directly to capture the real error
  su - user -c 'export XDG_RUNTIME_DIR=/run/user/10000; timeout 5 cage -s -- echo test 2>&1' || true
  echo ""
  echo "[$HOSTNAME] Last 10 journal lines:"
  journalctl -u greetd -n 10 --no-pager 2>&1
fi

echo ""
echo "[$HOSTNAME] User groups: $(id user)"
echo ""
echo ">>>>>>>>>> $HOSTNAME — DONE <<<<<<<<<<"
FIXSCRIPT

chmod +x /tmp/fix-greetd.sh

##################################################################
# STEP 2: Deploy and run on all 10 nodes
##################################################################

for i in $NODES; do
  ip="192.168.1.$i"
  num=$((i - 205))

  echo ""
  echo "################################################################"
  echo "##  NODE $num ($ip)"
  echo "################################################################"

  # Copy script to node
  sshpass -p "$PASS" scp -o StrictHostKeyChecking=no -o ConnectTimeout=10 \
    /tmp/fix-greetd.sh user@$ip:/tmp/fix-greetd.sh 2>&1

  if [ $? -ne 0 ]; then
    echo "  FAILED to copy script to node$num — skipping"
    continue
  fi

  # Run as root
  sshpass -p "$PASS" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 \
    user@$ip "doas sh /tmp/fix-greetd.sh" 2>&1

  if [ $? -ne 0 ]; then
    echo "  FAILED to run script on node$num"
  fi
done

##################################################################
# STEP 3: Final cluster status check
##################################################################

echo ""
echo ""
echo "============================================================"
echo "  FINAL STATUS CHECK"
echo "============================================================"
echo ""

sleep 3

for i in $NODES; do
  ip="192.168.1.$i"
  num=$((i - 205))

  STATUS=$(sshpass -p "$PASS" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 \
    user@$ip "doas systemctl is-active greetd" 2>/dev/null || echo "UNREACHABLE")

  CAGE=$(sshpass -p "$PASS" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 \
    user@$ip "pgrep cage >/dev/null 2>&1 && echo YES || echo NO" 2>/dev/null || echo "?")

  K3S=$(sshpass -p "$PASS" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 \
    user@$ip "pgrep k3s-agent >/dev/null 2>&1 && echo YES || echo NO" 2>/dev/null || echo "?")

  printf "  node%-2s (%s)  greetd: %-10s  cage: %-3s  k3s: %-3s\n" \
    "$num" "$ip" "$STATUS" "$CAGE" "$K3S"
done

echo ""
echo "============================================================"
echo "  DONE — $(date)"
echo "============================================================"
echo ""
