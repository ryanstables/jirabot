#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

pkill -f "ngrok http 3001" 2>/dev/null || true
docker-compose down
echo "JiraBot stopped."
