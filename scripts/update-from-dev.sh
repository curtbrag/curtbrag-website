#!/bin/sh
# Pull latest scripts from the dev branch directly
# Run: sh update-from-dev.sh
DEV="claude/setup-cluster-advanced-t3WV0"
BASE="https://raw.githubusercontent.com/curtbrag/curtbrag-website/${DEV}/scripts"
DIR="/home/user"

echo "Updating scripts from dev branch..."
# Self-update first so subsequent runs get the latest script list
wget -q -O "$DIR/update-from-dev.sh.new" "$BASE/update-from-dev.sh" && mv "$DIR/update-from-dev.sh.new" "$DIR/update-from-dev.sh" && chmod +x "$DIR/update-from-dev.sh" && echo "  updated update-from-dev.sh" || echo "  FAILED: update-from-dev.sh"
for s in poll-cluster-commands.sh cluster-nodes.conf push-cluster-status.sh deploy-keys.sh setup-mining-pc.sh; do
  wget -q -O "$DIR/$s.new" "$BASE/$s" && mv "$DIR/$s.new" "$DIR/$s" && chmod +x "$DIR/$s" 2>/dev/null && echo "  updated $s" || echo "  FAILED: $s"
done

echo "Restarting poller..."
pkill -f poll-cluster-commands 2>/dev/null || true
sleep 1
# Source env file directly — poller also self-sources if needed
unset CLUSTER_API_KEY
if [ -f /home/user/.cluster-env ]; then . /home/user/.cluster-env; fi
nohup sh /home/user/poll-cluster-commands.sh >> /home/user/cluster-poll.log 2>&1 &
echo "Poller PID: $!"

# Restart push loop if not running
if ! pgrep -f push-cluster-status >/dev/null 2>&1; then
  echo "Restarting push loop..."
  nohup sh -c 'while true; do sh /home/user/push-cluster-status.sh >> /home/user/push-status.log 2>&1; sleep 300; done' >> /home/user/push-status.log 2>&1 &
  echo "Push loop PID: $!"
fi
