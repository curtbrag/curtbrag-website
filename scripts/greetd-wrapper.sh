#!/bin/sh
# greetd-wrapper.sh — Display mode switcher for phone cluster
# Launched by greetd via: cage -s -- foot -f monospace:size=18 -e /home/user/display/greetd-wrapper.sh
#
# Reads /home/user/display/.mode to determine what to display.
# Supported modes: nodeid (default), cmatrix, cbonsai, pipes
#
# Shell: ash (BusyBox) — no bash syntax allowed

MODE_FILE="/home/user/display/.mode"
DISPLAY_DIR="/home/user/display"

# Read mode, default to nodeid
MODE="nodeid"
if [ -f "$MODE_FILE" ]; then
  MODE=$(cat "$MODE_FILE" 2>/dev/null | tr -d '[:space:]')
fi
[ -z "$MODE" ] && MODE="nodeid"

case "$MODE" in
  nodeid)
    if [ -x "$DISPLAY_DIR/nodeid.sh" ]; then
      exec "$DISPLAY_DIR/nodeid.sh"
    else
      # Fallback: basic node info
      while true; do
        clear
        echo "=== NODE ==="
        echo ""
        hostname
        ip -4 addr show wlan0 2>/dev/null | grep -o 'inet [0-9.]*' | cut -d' ' -f2
        echo ""
        echo "nodeid.sh not found"
        sleep 30
      done
    fi
    ;;
  cmatrix)
    if command -v cmatrix >/dev/null 2>&1; then
      exec cmatrix -b -u 6
    else
      echo "cmatrix not installed — run: doas apk add cmatrix"
      sleep 60
    fi
    ;;
  cbonsai)
    if command -v cbonsai >/dev/null 2>&1; then
      exec cbonsai -li -w 5
    else
      echo "cbonsai not installed — run: doas apk add cbonsai"
      sleep 60
    fi
    ;;
  pipes)
    if [ -x /usr/bin/pipes.sh ] || command -v pipes.sh >/dev/null 2>&1; then
      exec pipes.sh -t 0 -p 5 -R
    else
      echo "pipes.sh not installed"
      sleep 60
    fi
    ;;
  *)
    echo "Unknown display mode: $MODE"
    echo "Valid modes: nodeid, cmatrix, cbonsai, pipes"
    sleep 60
    ;;
esac
