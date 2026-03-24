#!/bin/sh
# Start the push-cluster-status loop in background, fully detached.
# Uses setsid to create a new session so the background process has
# no connection to the calling process's pipes or terminal.
# Run: sh /home/user/start-push-loop.sh

LOG="/home/user/cluster-push.log"
SCRIPT="/home/user/push-cluster-status.sh"

# Kill any existing push loop
pkill -f "push-cluster-status" 2>/dev/null || true
sleep 1

# Start in a new session so it inherits nothing from the caller.
# setsid is in util-linux (available on postmarketOS/Alpine).
# Redirect stdin/stdout/stderr so no fd from the $() pipe is inherited.
if command -v setsid >/dev/null 2>&1; then
  setsid sh -c "while true; do sh \"$SCRIPT\" >> \"$LOG\" 2>&1 || true; sleep 300; done" \
    </dev/null >/dev/null 2>&1 &
  echo "Push loop started via setsid (PID: $!)"
else
  # Fallback: close all known fds before backgrounding
  (
    exec </dev/null >/dev/null 2>&1
    # Close any extra fds (3-9) that may be inherited from the caller
    for _fd in 3 4 5 6 7 8 9; do eval "exec $_fd>&- 2>/dev/null" || true; done
    while true; do
      sh "$SCRIPT" >> "$LOG" 2>&1 || true
      sleep 300
    done
  ) &
  echo "Push loop started via fallback (PID: $!)"
fi
