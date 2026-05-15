#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Start Cloudflare Quick Tunnel + send URL to Telegram
PORT=${1:-18800}
ENGINE_ROOT="$HOME/constellation-engine"
if [ -f "$ENGINE_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$ENGINE_ROOT/.env"
  set +a
fi
BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
CHAT_ID="${OWNER_USER_ID:-}"
AUTH_TOKEN="${DASHBOARD_AUTH_TOKEN:-}"
if [ -z "$BOT_TOKEN" ] || [ -z "$CHAT_ID" ]; then
  echo "❌ TELEGRAM_BOT_TOKEN or OWNER_USER_ID missing from .env" >&2
  exit 1
fi

echo "🌐 Starting Cloudflare Tunnel for port $PORT..."

cloudflared tunnel --url http://localhost:$PORT 2>&1 | while IFS= read -r line; do
  echo "$line"
  if echo "$line" | grep -qo 'https://[a-z0-9-]*\.trycloudflare\.com'; then
    URL=$(echo "$line" | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com')
    echo ""
    echo "═══════════════════════════════════════"
    echo "🌌 Dashboard: $URL"
    echo "═══════════════════════════════════════"
    echo ""
    curl -s "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
      -d chat_id="$CHAT_ID" \
      -d parse_mode="Markdown" \
      -d "text=🌌 *Constellation Engine Dashboard*

🔗 ${URL}" \
      > /dev/null 2>&1
    echo "📱 URL sent to Telegram"
  fi
done
