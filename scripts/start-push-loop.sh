#!/bin/sh
# Start the push-cluster-status loop in background.
# Uses exec redirect trick to break the $() pipe so the poller doesn't wait.
# Run: sh /home/user/start-push-loop.sh

LOG="/home/user/cluster-push.log"
SCRIPT="/home/user/push-cluster-status.sh"

# Kill any existing push loop
pkill -f "push-cluster-status" 2>/dev/null || true
sleep 1

# Close our stdout (breaks the $() pipe in the poller — allows this script to return)
# then start the push loop in background
exec 3>&1            # save stdout to fd3 for this echo
exec 1>/dev/null     # close stdout (the $() pipe)

# Start the push-every-5-min loop
# Close fd3 inside subshell so it doesn't keep the parent's $() pipe open
(
  exec 3>&-
  while true; do
    sh "$SCRIPT" >> "$LOG" 2>&1 || true
    sleep 300
  done
) &

# Report PID via saved fd
echo "Push loop started (PID: $!)" >&3
exec 3>&-
