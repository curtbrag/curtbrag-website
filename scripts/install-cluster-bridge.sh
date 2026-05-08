#!/usr/bin/env bash
set -euo pipefail
ENV_FILE="$HOME/.cluster-env"
[ -f "$ENV_FILE" ] || cat > "$ENV_FILE" <<'ENV'
# Required
# WEB_PASSWORD=...        # or CLUSTER_WEB_PASSWORD
# WALLET=...

# Optional — pool / SSH defaults
# POOL=gulf.moneroocean.stream:10128
# SSH_KEY=~/.ssh/id_ed25519

# Optional — phone fleet (Termux SSH)
# PHONE_USER=u0_a191
# PHONE_PORT=8022
# PHONE_HINT=90
# PHONES="173 174 175 176 177 191 253 254"

# Optional — PC overrides (defaults: nexus@neo:192.168.1.178, viki@neo:192.168.1.180, steamdeck@deck:192.168.1.166)
# NEXUS_USER=neo
# NEXUS_IP=192.168.1.178
# NEXUS_THREADS=6
# VIKI_USER=neo
# VIKI_IP=192.168.1.180
# VIKI_THREADS=4
# STEAMDECK_USER=deck
# STEAMDECK_IP=192.168.1.166
# STEAMDECK_THREADS=6
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
