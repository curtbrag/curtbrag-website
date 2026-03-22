#!/bin/sh
# Pull latest scripts from the dev branch directly
# Run: sh update-from-dev.sh
DEV="claude/setup-cluster-advanced-t3WV0"
BASE="https://raw.githubusercontent.com/curtbrag/curtbrag-website/${DEV}/scripts"
DIR="/home/user"

echo "Updating scripts from dev branch..."
for s in poll-cluster-commands.sh cluster-nodes.conf push-cluster-status.sh deploy-keys.sh; do
  wget -q -O "$DIR/$s.new" "$BASE/$s" && mv "$DIR/$s.new" "$DIR/$s" && chmod +x "$DIR/$s" 2>/dev/null && echo "  updated $s" || echo "  FAILED: $s"
done

echo "Restarting poller..."
pkill -f poll-cluster-commands 2>/dev/null || true
sleep 1
export CLUSTER_API_KEY=$(grep CLUSTER_API_KEY /home/user/.cluster-env | cut -d= -f2 | tr -d '"')
nohup sh /home/user/poll-cluster-commands.sh >> /home/user/cluster-poll.log 2>&1 &
echo "Done (PID: $!)"
