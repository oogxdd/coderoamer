#!/usr/bin/env bash
# install.sh — set up the remote-agent daemon on a Linux machine.
#
# The daemon is a single static Go binary (no runtime deps). This script obtains
# it (prefers a prebuilt binary shipped alongside; falls back to building from
# source if Go is present), generates an AGENT_TOKEN, and installs a systemd user
# service so it auto-starts on boot — which is what makes "wake" viable: as soon
# as the machine boots, the API is already listening.
#
# Usage:
#   bash install.sh                 # install/refresh the daemon on port 8765
#
# (Tunnel setup — Tailscale / Cloudflare — is layered on in a later revision;
# see docs/custom-vm-providers.md §3.5.)
set -euo pipefail

INSTALL_DIR="$HOME/.remote-agent"
SERVICE_NAME="remote-agent"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN="$INSTALL_DIR/remote-agent"

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo amd64 ;;
    aarch64|arm64) echo arm64 ;;
    *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
  esac
}
ARCH="$(detect_arch)"

mkdir -p "$INSTALL_DIR"

echo "==> Obtaining the remote-agent binary (arch: $ARCH)..."
if [ -x "$SRC_DIR/dist/remote-agent-linux-$ARCH" ]; then
  echo "    Using prebuilt dist/remote-agent-linux-$ARCH"
  cp "$SRC_DIR/dist/remote-agent-linux-$ARCH" "$BIN"
elif [ -x "$SRC_DIR/remote-agent" ] && [ "$SRC_DIR/remote-agent" != "$BIN" ]; then
  echo "    Using prebuilt ./remote-agent"
  cp "$SRC_DIR/remote-agent" "$BIN"
elif command -v go >/dev/null 2>&1; then
  echo "    Building from source with $(go version)"
  ( cd "$SRC_DIR" && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o "$BIN" . )
else
  echo "    No prebuilt binary found and Go is not installed." >&2
  echo "    On your dev machine run 'bash build.sh' and copy dist/remote-agent-linux-$ARCH next to this script," >&2
  echo "    or install Go (https://go.dev/dl/) on this machine and re-run." >&2
  exit 1
fi
chmod +x "$BIN"
echo "    Installed $BIN"

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
ExecStart=$BIN
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable "$SERVICE_NAME"
  systemctl --user restart "$SERVICE_NAME"
  echo "    systemd service enabled and started."
  echo "    Status: systemctl --user status $SERVICE_NAME"
  echo "    Logs:   journalctl --user -u $SERVICE_NAME -f"
else
  echo "    systemd not available. Start the daemon manually:"
  echo "    set -a; source $INSTALL_DIR/.env; set +a; $BIN"
fi

echo ""
echo "Done. The daemon listens on port 8765 (change PORT= in $INSTALL_DIR/.env)."
echo "Expose it over HTTPS (see docs/custom-vm-providers.md) and add it as a connection in the app."
