#!/bin/sh
# Display mode wrapper for greetd
# Reads /home/user/display/.mode and launches the appropriate display program
# This script is launched by greetd via: cage -s -- foot -f monospace:size=18 -e /home/user/display/greetd-wrapper.sh
#
# Supported modes: nodeid (default), cmatrix, cbonsai, pipes
# To change mode: echo "cmatrix" > /home/user/display/.mode && doas reboot

MODE_FILE="/home/user/display/.mode"
DISPLAY_DIR="/home/user/display"

# Read mode, default to nodeid
MODE="nodeid"
if [ -f "$MODE_FILE" ]; then
  MODE=$(cat "$MODE_FILE" | tr -d '[:space:]')
fi

# Fallback to nodeid if mode is empty or unrecognized
case "$MODE" in
  nodeid|cmatrix|cbonsai|pipes) ;;
  *) MODE="nodeid" ;;
esac

case "$MODE" in
  nodeid)
    exec "$DISPLAY_DIR/nodeid.sh"
    ;;
  cmatrix)
    if command -v cmatrix >/dev/null 2>&1; then
      exec cmatrix -bs -C red
    else
      echo "cmatrix not installed. Install with: doas apk add cmatrix"
      sleep 30
      exec "$DISPLAY_DIR/nodeid.sh"
    fi
    ;;
  cbonsai)
    if command -v cbonsai >/dev/null 2>&1; then
      exec cbonsai -li -w 10
    else
      echo "cbonsai not installed. Install with: doas apk add cbonsai"
      sleep 30
      exec "$DISPLAY_DIR/nodeid.sh"
    fi
    ;;
  pipes)
    if [ -x /usr/bin/pipes.sh ] || command -v pipes.sh >/dev/null 2>&1; then
      exec pipes.sh -t 0 -p 5 -R
    elif [ -x /usr/bin/pipes ] || command -v pipes >/dev/null 2>&1; then
      exec pipes -t 0 -p 5 -R
    else
      echo "pipes not installed."
      sleep 30
      exec "$DISPLAY_DIR/nodeid.sh"
    fi
    ;;
esac
