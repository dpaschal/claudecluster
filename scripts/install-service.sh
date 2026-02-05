#!/bin/bash
# Install claudecluster as a systemd service

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_FILE="$SCRIPT_DIR/claudecluster.service"

echo "Installing claudecluster systemd service..."

# Copy service file
sudo cp "$SERVICE_FILE" /etc/systemd/system/claudecluster.service

# Reload systemd
sudo systemctl daemon-reload

# Enable service (start on boot)
sudo systemctl enable claudecluster

echo "Service installed. Commands:"
echo "  sudo systemctl start claudecluster   # Start now"
echo "  sudo systemctl status claudecluster  # Check status"
echo "  sudo journalctl -u claudecluster -f  # View logs"
