#!/usr/bin/env bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

if [ ! -f .env ]; then
  echo -e "${RED}.env not found. Run ./scripts/setup.sh first.${NC}"
  exit 1
fi

# Extract individual values from .env (avoids sourcing multiline PEM keys)
get_env() { grep "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2-; }

JIRA_HOST=$(get_env JIRA_HOST)
JIRA_AGENT_EMAIL=$(get_env JIRA_AGENT_EMAIL)
JIRA_API_TOKEN=$(get_env JIRA_API_TOKEN)
JIRA_WEBHOOK_SECRET=$(get_env JIRA_WEBHOOK_SECRET)

# ── Start Docker Compose ──
echo -e "${CYAN}Starting Docker Compose...${NC}"
docker-compose up -d --build 2>&1 | tail -5

echo -n "Waiting for health check... "
for i in $(seq 1 30); do
  if curl -sf http://localhost:3001/health >/dev/null 2>&1; then
    echo -e "${GREEN}ok${NC}"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo -e "${RED}timed out${NC}"
    echo "Check logs: docker-compose logs agent"
    exit 1
  fi
  sleep 1
done

# ── Start ngrok ──
if ! command -v ngrok &>/dev/null; then
  echo ""
  echo -e "${YELLOW}ngrok not found.${NC} Install: brew install ngrok"
  echo "Without ngrok, Jira cannot reach the agent."
  echo ""
  echo -e "Agent running at ${CYAN}http://localhost:3001${NC}"
  echo "Logs: docker-compose logs -f agent"
  exit 0
fi

# Stop any existing ngrok on port 3001
pkill -f "ngrok http 3001" 2>/dev/null || true
sleep 1

echo -e "${CYAN}Starting ngrok...${NC}"
ngrok http 3001 --log=stdout > /tmp/jirabot-ngrok.log 2>&1 &
NGROK_PID=$!

echo -n "Waiting for tunnel... "
NGROK_URL=""
for i in $(seq 1 15); do
  NGROK_URL=$(curl -sf http://localhost:4040/api/tunnels 2>/dev/null \
    | python3 -c "
import sys, json
tunnels = json.load(sys.stdin).get('tunnels', [])
for t in tunnels:
    if t.get('proto') == 'https':
        print(t['public_url'])
        break
" 2>/dev/null) || true
  if [ -n "$NGROK_URL" ]; then
    echo -e "${GREEN}$NGROK_URL${NC}"
    break
  fi
  if [ "$i" -eq 15 ]; then
    echo -e "${RED}timed out${NC}"
    echo "Check: cat /tmp/jirabot-ngrok.log"
    exit 1
  fi
  sleep 1
done

# ── Register or update Jira webhook ──
WEBHOOK_URL="$NGROK_URL/webhook/jira"

echo ""
echo -n "Registering Jira webhook... "

# List existing webhooks to find ours
EXISTING=$(curl -sf -u "$JIRA_AGENT_EMAIL:$JIRA_API_TOKEN" \
  "https://$JIRA_HOST/rest/webhooks/1.0/webhook" 2>/dev/null || echo "[]")

WEBHOOK_ID=$(echo "$EXISTING" | python3 -c "
import sys, json
webhooks = json.load(sys.stdin) if isinstance(json.load(open('/dev/stdin') if False else sys.stdin), list) else []
for w in webhooks:
    if w.get('name') == 'JiraBot (local)':
        print(w.get('self', '').rstrip('/').split('/')[-1])
        break
" 2>/dev/null <<< "$EXISTING") || true

WEBHOOK_BODY="{\"name\":\"JiraBot (local)\",\"url\":\"$WEBHOOK_URL\",\"events\":[\"jira:issue_updated\"],\"excludeBody\":false}"

if [ -n "$WEBHOOK_ID" ]; then
  HTTP_CODE=$(curl -sf -o /dev/null -w "%{http_code}" \
    -X PUT \
    -u "$JIRA_AGENT_EMAIL:$JIRA_API_TOKEN" \
    -H "Content-Type: application/json" \
    "https://$JIRA_HOST/rest/webhooks/1.0/webhook/$WEBHOOK_ID" \
    -d "$WEBHOOK_BODY" 2>/dev/null) || HTTP_CODE="000"

  if [ "$HTTP_CODE" = "200" ]; then
    echo -e "${GREEN}updated${NC}"
  else
    echo -e "${YELLOW}failed (HTTP $HTTP_CODE)${NC}"
    echo -e "  The agent user may not have Jira admin rights."
    echo -e "  Set the webhook URL manually in Jira: ${CYAN}$WEBHOOK_URL${NC}"
    echo -e "  Secret: ${CYAN}$JIRA_WEBHOOK_SECRET${NC}"
  fi
else
  HTTP_CODE=$(curl -sf -o /dev/null -w "%{http_code}" \
    -X POST \
    -u "$JIRA_AGENT_EMAIL:$JIRA_API_TOKEN" \
    -H "Content-Type: application/json" \
    "https://$JIRA_HOST/rest/webhooks/1.0/webhook" \
    -d "$WEBHOOK_BODY" 2>/dev/null) || HTTP_CODE="000"

  if [ "$HTTP_CODE" = "201" ] || [ "$HTTP_CODE" = "200" ]; then
    echo -e "${GREEN}created${NC}"
  else
    echo -e "${YELLOW}failed (HTTP $HTTP_CODE)${NC}"
    echo -e "  The agent user may not have Jira admin rights."
    echo -e "  Create a webhook manually in Jira:"
    echo -e "    URL:    ${CYAN}$WEBHOOK_URL${NC}"
    echo -e "    Secret: ${CYAN}$JIRA_WEBHOOK_SECRET${NC}"
    echo -e "    Events: Issue → updated"
  fi
fi

# ── Summary ──
echo ""
echo -e "${GREEN}JiraBot is running.${NC}"
echo ""
echo -e "  Agent:   ${CYAN}http://localhost:3001${NC}"
echo -e "  Public:  ${CYAN}$NGROK_URL${NC}"
echo -e "  Webhook: ${CYAN}$NGROK_URL/webhook/jira${NC}"

SLACK_TOKEN=$(get_env SLACK_BOT_TOKEN || true)
if [ -n "$SLACK_TOKEN" ]; then
  echo ""
  echo -e "  ${YELLOW}Slack:${NC} Set your Event Subscriptions URL to:"
  echo -e "         ${CYAN}$NGROK_URL/webhook/slack${NC}"
fi

echo ""
echo -e "  Logs:    docker-compose logs -f agent"
echo -e "  Stop:    Ctrl+C (or ./scripts/stop-local.sh)"
echo ""

# Wait for Ctrl+C, then clean up
cleanup() {
  echo ""
  echo "Stopping..."
  kill "$NGROK_PID" 2>/dev/null || true
  docker-compose down
  echo "Done."
}
trap cleanup INT TERM

echo "Press Ctrl+C to stop."
wait "$NGROK_PID" 2>/dev/null || true
