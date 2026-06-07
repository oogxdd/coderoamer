#!/usr/bin/env bash
# install.sh — set up remote-agent on a fresh Linux machine.
# Run as a regular user with sudo access.
# Usage: bash install.sh

set -euo pipefail

INSTALL_DIR="$HOME/.remote-agent"
SERVICE_NAME="remote-agent"

echo "==> Checking Node.js (need 18+)..."
if ! command -v node &>/dev/null; then
  echo "Node not found. Installing via nvm..."
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1091
  source "$NVM_DIR/nvm.sh"
  nvm install 20 && nvm use 20
fi

NODE_MAJOR=$(node -e "process.stdout.write(process.version.slice(1).split('.')[0])")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Node $NODE_MAJOR is too old (need 18+). Please upgrade."
  exit 1
fi
echo "    Node $(node --version) OK"

echo "==> Copying daemon files to $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR"
cp "$(dirname "$0")/index.js"   "$INSTALL_DIR/"
cp "$(dirname "$0")/package.json" "$INSTALL_DIR/"

echo "==> Installing npm dependencies..."
cd "$INSTALL_DIR"
npm install --omit=dev --loglevel=error

echo "==> Configuring token..."
if [ ! -f "$INSTALL_DIR/.env" ]; then
  TOKEN=$(openssl rand -hex 32)
  cat > "$INSTALL_DIR/.env" <<EOF
AGENT_TOKEN=$TOKEN
PORT=8765
EOF
  echo "    Generated token: $TOKEN"
  echo "    Saved to $INSTALL_DIR/.env — copy this token into the app."
else
  echo "    .env already exists — keeping existing token."
  grep AGENT_TOKEN "$INSTALL_DIR/.env" || true
fi

echo "==> Setting up systemd user service..."
if command -v systemctl &>/dev/null && systemctl --user daemon-reload 2>/dev/null; then
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/$SERVICE_NAME.service" <<EOF
[Unit]
Description=remote-agent (sprites-rn-manager daemon)
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$INSTALL_DIR/.env
ExecStart=$(command -v node) $INSTALL_DIR/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable "$SERVICE_NAME"
  systemctl --user start  "$SERVICE_NAME"
  echo "    systemd service enabled and started."
  echo "    Check status: systemctl --user status $SERVICE_NAME"
  echo "    View logs:    journalctl --user -u $SERVICE_NAME -f"
else
  echo "    systemd not available. Start the daemon manually:"
  echo "    cd $INSTALL_DIR && source .env && node index.js"
fi

echo ""
echo "Done. The daemon listens on port 8765 (change PORT= in $INSTALL_DIR/.env)."
echo "Expose it over HTTPS (see MIGRATION.md) and add it as a connection in the app."
