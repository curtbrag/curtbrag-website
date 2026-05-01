#!/usr/bin/env bash
set -euo pipefail
ENV_FILE="$HOME/.cluster-env"
[ -f "$ENV_FILE" ] || cat > "$ENV_FILE" <<'ENV'
# Required
# WEB_PASSWORD=...
# or CLUSTER_WEB_PASSWORD=...
# WALLET=...
# Optional
# POOL=moneroocean.stream:10128
# SSH_KEY=~/.ssh/id_ed25519
ENV
chmod 600 "$ENV_FILE"
chmod +x scripts/curt-cluster-bridge.example.sh
if command -v systemctl >/dev/null 2>&1; then
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$HOME/.config/systemd/user/curt-cluster-bridge.service" <<EOF
[Unit]
Description=Curt Cluster Bridge
[Service]
EnvironmentFile=%h/.cluster-env
ExecStart=$(pwd)/scripts/curt-cluster-bridge.example.sh
Restart=always
RestartSec=3
[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload || true
  echo "Run: systemctl --user enable --now curt-cluster-bridge.service"
fi
