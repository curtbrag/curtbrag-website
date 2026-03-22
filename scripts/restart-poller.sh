#!/bin/sh
# Kill all stale poller instances and start exactly one fresh one.
# Run: sh /home/user/restart-poller.sh

LOG="/home/user/cluster-poll.log"
SCRIPT="/home/user/poll-cluster-commands.sh"

# Start fresh poller in background first, capture its PID
nohup sh "$SCRIPT" >> "$LOG" 2>&1 &
NEW_PID=$!
sleep 1

# Kill every poll-cluster-commands process EXCEPT the new one
for pid in $(pgrep -f poll-cluster-commands); do
  if [ "$pid" != "$NEW_PID" ]; then
    kill -9 "$pid" 2>/dev/null || true
  fi
done

sleep 1
echo "Done. Active pollers after restart:"
pgrep -af poll-cluster-commands
