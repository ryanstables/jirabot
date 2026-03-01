# JiraBot

An autonomous AI coding agent that monitors a Jira board, interprets tickets, writes code using Claude Code, opens GitHub pull requests, and transitions tickets to review status — all without human intervention.

**v2** adds self-assignment (the agent finds and claims its own tickets), multi-repository support (coordinated changes across multiple repos in a single job), Slack integration (create tickets and receive notifications via Slack), and periodic cron scanning.

---

## How It Works

### Webhook path (ticket assigned to agent)

```
Admin assigns Jira ticket to the agent user
         │
         ▼
Agent receives POST /webhook/jira (Jira sends directly, or via Cloudflare Worker)
         │
         ├── Insufficient info? → Post clarifying comment → Wait for reply
         │
         ▼
Claude Code clones repo(s), implements fix, runs tests
         │
         ├── Tests fail after MAX_ATTEMPTS? → Escalation comment → Needs Clarity
         │
         ▼
Git pushes branch(es) → GitHub PR(s) opened
         │
         ▼
PR link(s) posted to Jira + ticket transitioned to "Ready for Review"
         │
         └── Slack notification posted (if configured)
```

### Cron path (agent self-assigns)

```
BullMQ cron fires (default: every 5 minutes)
         │
         ▼
Agent searches Jira via configured JQL per board
         │
         ▼
Unassigned matching tickets claimed via Redis NX lock
         │
         ▼
Agent assigns ticket to itself → enqueues ticket job
         │
         └── Normal webhook path from here
```

### Slack path (create ticket from Slack)

```
User DMs or @mentions the Slack bot
         │
         ▼
Agent receives POST /webhook/slack (directly, or via Cloudflare Worker)
         │
         ▼
handle-slack-command worker parses intent (Claude Haiku)
         │
         ├── "create a ticket for X" → Jira ticket created → bot replies with ticket key
         └── Unknown intent         → bot replies with a helpful message
```

---

## Architecture

The system can run fully self-hosted (Docker Compose) or on managed cloud services.

| Layer | Self-hosted | Cloud |
|-------|-------------|-------|
| Webhook receiver | Express routes in agent (port 3001) | Cloudflare Worker |
| Job queue | BullMQ (Redis-backed) | Inngest |
| Agent runtime | Docker Compose | Fly.io |
| State store | Local Redis container | Upstash Redis |
| Code generation | Claude Code CLI | Claude Code CLI |

### Worker functions

| Function | Trigger | Purpose |
|----------|---------|---------|
| `process-ticket` | `ticket-jobs` queue | Main coding job (concurrency 5, retries 3) |
| `scan-and-assign` | Cron (`SCAN_CRON_SCHEDULE`) | Self-assignment loop (concurrency 1) |
| `handle-slack-command` | `slack-jobs` queue | Slack message handling (retries 2) |

---

## Prerequisites

Before deploying, you need accounts and credentials for each service below.

### 1. Jira Cloud

- A Jira Cloud account with a project you want the bot to manage
- A **dedicated agent user** (e.g. `jirabot@yourcompany.com`) — tickets assigned to this user trigger the bot
- An **API token** for the agent user: [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
- The **account ID** of the agent user (visible in the user profile URL or via the Jira REST API)
- The **Jira status names** you want for "Ready for Review" and "Needs Clarity" (must match exactly)

### 2. GitHub App

Create a GitHub App for authenticated repo access:

1. Go to **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**
2. Set **Homepage URL** to anything (e.g. your Fly.io app URL)
3. Disable **Webhook** (the bot doesn't receive GitHub webhooks)
4. Under **Permissions → Repository permissions**, grant:
   - `Contents`: Read & write
   - `Pull requests`: Read & write
   - `Metadata`: Read-only
5. Click **Create GitHub App**
6. Note the **App ID** from the app settings page
7. Generate a **private key** (PEM format) — download and keep it safe
8. **Install the app** on your organisation or specific repositories
9. Note the **Installation ID** from the URL after installation: `github.com/organizations/{org}/settings/installations/{INSTALLATION_ID}`

> **Multi-repo:** If tickets span multiple repositories, install the GitHub App on all of them.

### 3. Anthropic API Key

Get a key from [console.anthropic.com](https://console.anthropic.com). The bot uses `claude-sonnet-4-6` for sufficiency checks and `claude-haiku-4-5` for Slack intent parsing.

### 4. Redis

**Self-hosted:** Redis runs automatically as part of Docker Compose — no setup needed.

**Cloud:** Create a free database at [console.upstash.com](https://console.upstash.com) and copy the `rediss://` TLS URL.

### 5. Fly.io *(cloud deployment only)*

1. Install the CLI: `brew install flyctl` (or see [fly.io/docs](https://fly.io/docs/hands-on/install-flyctl/))
2. Log in: `fly auth login`
3. The app name is `jirabot-agent` (set in `packages/agent/fly.toml`)

### 6. Cloudflare Account *(cloud deployment only)*

1. Install Wrangler: `npm install -g wrangler`
2. Log in: `wrangler login`
3. The worker name is `jirabot-webhook` (set in `packages/worker/wrangler.toml`)

### 7. Slack App *(optional — required for Slack features)*

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App → From scratch**
2. Give it a name (e.g. `JiraBot`) and select your workspace
3. Under **OAuth & Permissions → Scopes → Bot Token Scopes**, add:
   - `chat:write` — post messages
   - `im:history` — read DMs
   - `app_mentions:read` — read @mentions
4. Click **Install to Workspace** and copy the **Bot User OAuth Token** (`xoxb-...`) → `SLACK_BOT_TOKEN`
5. Under **Basic Information → App Credentials**, copy the **Signing Secret** → `SLACK_SIGNING_SECRET`
6. Under **Event Subscriptions**:
   - Toggle **Enable Events** on
   - Set **Request URL** to `https://jirabot-webhook.<your-subdomain>.workers.dev/webhook/slack`
   - *(Slack will send a challenge — the Worker handles it automatically once deployed)*
   - Under **Subscribe to bot events**, add: `message.im` (DMs) and `app_mention` (mentions in channels)
7. Save changes and reinstall the app if prompted
8. Invite the bot to the DM or channel where users will interact with it

---

## Environment Variables

### Agent

Set these in `.env` (self-hosted) or via `fly secrets set` (Fly.io). Never commit secrets to source.

| Variable | Required | Description |
|----------|----------|-------------|
| `JIRA_HOST` | ✅ | Your Jira Cloud hostname, e.g. `yourorg.atlassian.net` |
| `JIRA_AGENT_EMAIL` | ✅ | Email address of the agent Jira user |
| `JIRA_API_TOKEN` | ✅ | Jira API token for the agent user |
| `JIRA_AGENT_ACCOUNT_ID` | ✅ | Jira accountId of the agent user |
| `JIRA_WEBHOOK_SECRET` | ✅ | A random string used to sign Jira webhooks (you choose this) |
| `GITHUB_APP_ID` | ✅ | Numeric GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY` | ✅ | PEM private key contents |
| `GITHUB_APP_INSTALLATION_ID` | ✅ | Numeric installation ID |
| `ANTHROPIC_API_KEY` | ✅ | Anthropic API key |
| `REDIS_URL` | ✅ | Redis URL. Self-hosted: `redis://localhost:6379`. Upstash: `rediss://...` |
| `BOARDS_CONFIG` | ✅ | JSON array of board configs (see below) |
| `MAX_ATTEMPTS` | | Max coding attempts before escalation (default: `3`) |
| `SLACK_BOT_TOKEN` | | Slack bot OAuth token (`xoxb-...`). Required for Slack features. |
| `SLACK_SIGNING_SECRET` | | Slack signing secret. Required for Slack features. |
| `SCAN_CRON_SCHEDULE` | | Cron expression for self-assignment scan (default: `*/5 * * * *`) |

### Cloudflare Worker *(cloud deployment only)*

Secrets set via `wrangler secret put`.

| Variable | Required | Description |
|----------|----------|-------------|
| `JIRA_WEBHOOK_SECRET` | ✅ | Must match the agent value |
| `INNGEST_EVENT_KEY` | ✅ | Inngest event key |
| `JIRA_AGENT_ACCOUNT_ID` | ✅ | Jira accountId of the agent user (filters webhook events) |
| `SLACK_SIGNING_SECRET` | | Slack signing secret. Required to receive Slack webhooks. |

---

## BOARDS_CONFIG

The `BOARDS_CONFIG` environment variable maps Jira projects to GitHub repositories. It is a JSON array. All v2 fields are optional and have safe defaults.

```json
[
  {
    "jiraProject": "PROJ",
    "githubRepo": "your-org/your-repo",
    "defaultBranch": "main",
    "targetStatus": "Ready for Review",
    "escalationStatus": "Needs Clarity",

    "secondaryRepos": [
      { "githubRepo": "your-org/another-repo", "defaultBranch": "main" }
    ],
    "multiRepoLabel": "multi-repo",

    "autoAssignJql": "project = PROJ AND assignee is EMPTY AND labels = agent-eligible AND status = 'To Do'",

    "slackChannel": "C012AB3CD"
  }
]
```

| Field | Required | Description |
|-------|----------|-------------|
| `jiraProject` | ✅ | Jira project key (e.g. `PROJ`, `ENG`) |
| `githubRepo` | ✅ | Primary GitHub repository in `org/repo` format |
| `defaultBranch` | ✅ | Branch to open PRs against (e.g. `main`) |
| `targetStatus` | ✅ | Jira status name after PR is opened |
| `escalationStatus` | ✅ | Jira status name when all attempts fail |
| `secondaryRepos` | | Additional repos to clone for multi-repo tickets (default: `[]`) |
| `multiRepoLabel` | | Ticket label that activates secondary repos (default: `"multi-repo"`) |
| `autoAssignJql` | | JQL query for self-assignment cron. Omit to disable scanning for this board. |
| `slackChannel` | | Slack channel ID for job notifications. Omit to disable Slack notifications for this board. |

Multiple boards can be configured. Each `jiraProject` key must be unique.

---

## Local / Self-Hosted Deployment

Run the full system on any machine with Docker — no Cloudflare, Inngest, or Fly.io required. Jira, GitHub, and the Anthropic API are the only external dependencies.

### Prerequisites

- Docker and Docker Compose
- A publicly reachable URL so Jira can send webhooks (use [ngrok](https://ngrok.com) if running locally, or deploy to any VPS)

### Step 1: Configure environment

```bash
cp .env.example .env
```

Fill in `.env` with your credentials. The `REDIS_URL` is overridden automatically by Docker Compose — you can leave it as `redis://localhost:6379` in `.env`.

### Step 2: Start with Docker Compose

```bash
docker-compose up --build
```

This starts two containers:

| Container | Purpose |
|-----------|---------|
| `redis` | Redis 7 on port 6379 — job queue + state store |
| `agent` | JiraBot agent on port 3001 |

Verify it's healthy:

```bash
curl http://localhost:3001/health
# → {"status":"ok"}
```

### Step 3: Expose the agent publicly

Jira needs an HTTPS URL to deliver webhook events. If running on a local machine:

```bash
ngrok http 3001
# Forwarding: https://abc123.ngrok.io -> http://localhost:3001
```

Copy the HTTPS forwarding URL. On a VPS, use the server's public IP or domain with a reverse proxy (nginx, Caddy, etc.) pointing to port 3001.

### Step 4: Configure the Jira Webhook

1. Log in to Jira as an administrator
2. Go to **Settings → System → WebHooks → Create a WebHook**
3. Fill in:
   - **URL:** `https://<your-public-url>/webhook/jira`
   - **Secret:** The value you set for `JIRA_WEBHOOK_SECRET` in `.env`
   - **Events:** Check **Issue → updated**
4. Click **Create**

### Step 5: Configure Slack *(optional)*

1. In your Slack App settings → **Event Subscriptions**
2. Set **Request URL** to `https://<your-public-url>/webhook/slack`
3. Slack sends a verification challenge — the agent responds automatically
4. Save and reinstall the app if prompted

### Logs and monitoring

```bash
# Follow agent logs
docker-compose logs -f agent

# Follow all containers
docker-compose logs -f
```

Key log prefixes to watch:

| Prefix | Meaning |
|--------|---------|
| `[queue]` | Worker startup, cron registration |
| `[scan]` | Self-assignment cron results |
| `[job-*]` | Per-ticket job progress |
| `[webhook/jira]` | Incoming Jira webhook events |
| `[webhook/slack]` | Incoming Slack events |

### Stopping

```bash
docker-compose down           # stop containers, keep Redis data
docker-compose down -v        # stop containers and delete Redis data
```

---

## Cloud Deployment (Cloudflare + Inngest + Fly.io)

### Step 1: Install dependencies

```bash
npm install
```

### Step 2: Deploy the Cloudflare Worker

```bash
cd packages/worker

# Required secrets
wrangler secret put JIRA_WEBHOOK_SECRET
wrangler secret put INNGEST_EVENT_KEY

# Set the agent account ID (or add to wrangler.toml as a plain var)
# Edit wrangler.toml: JIRA_AGENT_ACCOUNT_ID = "your-account-id"

# Required for Slack webhook validation (omit if not using Slack)
wrangler secret put SLACK_SIGNING_SECRET

# Deploy
wrangler deploy
```

After deployment, Wrangler prints a URL like:
```
https://jirabot-webhook.<your-subdomain>.workers.dev
```

Keep this URL — you'll need it for the Jira and Slack webhook configurations.

### Step 3: Deploy the Agent Worker to Fly.io

Run all commands from the **repository root** (required so Docker has access to all workspace packages).

```bash
# Create the Fly.io app (first time only)
fly apps create jirabot-agent

# Set required secrets
fly secrets set \
  JIRA_HOST="yourorg.atlassian.net" \
  JIRA_AGENT_EMAIL="jirabot@yourcompany.com" \
  JIRA_API_TOKEN="your-jira-api-token" \
  JIRA_AGENT_ACCOUNT_ID="your-agent-account-id" \
  JIRA_WEBHOOK_SECRET="your-webhook-secret" \
  GITHUB_APP_ID="123456" \
  GITHUB_APP_INSTALLATION_ID="78901234" \
  ANTHROPIC_API_KEY="sk-ant-..." \
  REDIS_URL="rediss://default:...@...upstash.io:..." \
  INNGEST_SIGNING_KEY="signkey-..." \
  MAX_ATTEMPTS="3"

# Set GitHub private key (multi-line — use a file to preserve newlines)
fly secrets set GITHUB_APP_PRIVATE_KEY="$(cat path/to/private-key.pem)"

# Set boards config (include v2 fields as needed)
fly secrets set BOARDS_CONFIG='[{"jiraProject":"PROJ","githubRepo":"your-org/your-repo","defaultBranch":"main","targetStatus":"Ready for Review","escalationStatus":"Needs Clarity"}]'

# Optional: Slack integration
fly secrets set \
  SLACK_BOT_TOKEN="xoxb-..." \
  SLACK_SIGNING_SECRET="your-slack-signing-secret"

# Optional: override cron schedule (default: every 5 minutes)
fly secrets set SCAN_CRON_SCHEDULE="*/10 * * * *"

# Deploy
fly deploy --config packages/agent/fly.toml
```

Verify it's running:
```bash
fly status --config packages/agent/fly.toml
fly logs --config packages/agent/fly.toml
```

The agent listens on port `3001`. Verify it's running:

```bash
fly status --config packages/agent/fly.toml
# curl https://jirabot-agent.fly.dev/health → {"status":"ok"}
```

### Step 4: Configure the Jira Webhook

1. Log in to Jira as an **administrator**
2. Go to **Settings → System → WebHooks**
3. Click **Create a WebHook** and fill in:
   - **Name:** JiraBot Agent
   - **URL:** `https://jirabot-webhook.<your-subdomain>.workers.dev`
   - **Secret:** The same value you used for `JIRA_WEBHOOK_SECRET`
   - **Events:** Check **Issue → updated**
   - Optionally scope to specific projects: `project = PROJ`
4. Click **Create**

> **Note:** If you are using the self-assignment cron (`autoAssignJql`), the Jira webhook is optional for self-assigned tickets — the agent finds and claims them itself. The webhook is still needed if you also want to support manual assignment.

### Step 6: Configure Slack *(optional)*

After the Cloudflare Worker is deployed:

1. In your Slack App settings → **Event Subscriptions**
2. Set **Request URL** to `https://jirabot-webhook.<your-subdomain>.workers.dev/webhook/slack`
3. Slack will send a verification challenge — the Worker responds to it automatically
4. Save and reinstall the app if prompted

To find a channel ID for `slackChannel` in `BOARDS_CONFIG`: right-click the channel in Slack → **View channel details** → the ID is shown at the bottom (e.g. `C012AB3CD`).

---

## Usage

### Assigning tickets manually

Assign any Jira ticket to the agent user. The bot will receive the webhook, check sufficiency, clone the repo, implement the fix, and open a PR.

### Self-assignment (cron)

Configure `autoAssignJql` on a board in `BOARDS_CONFIG`. The agent will scan for matching unassigned tickets every `SCAN_CRON_SCHEDULE` interval and claim them automatically. A Redis NX lock prevents duplicate processing if multiple agent instances are running.

Recommended JQL pattern:
```
project = PROJ AND assignee is EMPTY AND labels = agent-eligible AND status = "To Do"
```

Use the `agent-eligible` label (or any label you choose) to mark tickets as safe for autonomous processing.

### Multi-repo tickets

1. Add `secondaryRepos` to your board config in `BOARDS_CONFIG`
2. Label the Jira ticket with the value of `multiRepoLabel` (default: `multi-repo`)

When the agent processes the ticket:
- All repos are cloned into named subdirectories (`repo-primary/`, `repo-secondary-0/`, …)
- Claude Code runs once with all repos available and a prompt describing the layout
- A separate PR is opened in each repo
- The Jira comment lists all PR URLs

### Creating tickets from Slack

DM the bot or @mention it in a channel where it's invited:

```
@JiraBot create a ticket for adding a dark mode toggle to the settings page
```

The bot parses your message, creates the Jira ticket in the most appropriate project, and replies with the ticket key. You can then add the `agent-eligible` label to have the cron pick it up, or assign it to the agent manually.

### What makes a good ticket

The bot evaluates each ticket before coding. Tickets are more likely to proceed directly to coding when they include:

- A clear description of the **expected behaviour**
- A description of the **actual (broken) behaviour**
- **Reproduction steps** (for bugs)
- Relevant **file paths or component names** (if known)
- **Acceptance criteria** (for features)

If information is missing, the bot posts clarifying questions and sets the ticket to `awaiting_info`. Reply to the comment and the bot re-evaluates automatically.

### Escalation

If Claude Code cannot produce passing tests after `MAX_ATTEMPTS` attempts:
- A `🚨 JiraBot Escalation` comment summarises each attempt
- Ticket transitions to `escalationStatus` (e.g. `Needs Clarity`)
- A Slack notification is posted (if configured)
- The bot stops retrying until a human adds a new comment

### Branch and PR naming

- **Branch:** `agent/PROJ-123-short-description` (sanitised from ticket title)
- **PR title:** `fix(PROJ-123): ticket summary`
- **PR body:** Ticket summary, description excerpt, commit SHA, cross-links to related PRs (multi-repo), previous attempt summaries

---

## Local Development

### Run tests

```bash
npm test
```

### Build all packages

```bash
npm run build
```

### Run the agent locally (without Docker)

```bash
cp .env.example .env
# Fill in values in .env — point REDIS_URL at a local Redis instance

npm run dev:agent
```

### Run the Cloudflare Worker locally *(cloud deployment only)*

```bash
npm run dev:worker
```

---

## Monitoring

### Self-hosted (Docker Compose)

```bash
docker-compose logs -f agent        # live agent logs
docker-compose logs -f              # all containers
docker-compose ps                   # container status
curl http://localhost:3001/health   # health check
```

### Cloud (Fly.io + Cloudflare)

```bash
fly logs --config packages/agent/fly.toml
fly status --config packages/agent/fly.toml
```

```bash
cd packages/worker
wrangler tail
```

---

## Troubleshooting

### Bot doesn't respond to ticket assignment

1. Check `curl http://localhost:3001/health` returns `{"status":"ok"}`
2. Verify the Jira webhook URL points to the agent and the secret matches `JIRA_WEBHOOK_SECRET`
3. Confirm `JIRA_AGENT_ACCOUNT_ID` matches the agent user's actual Jira account ID
4. Check agent logs: `docker-compose logs -f agent` (self-hosted) or `fly logs` (Fly.io)
5. Look for `[webhook/jira]` log lines — if missing, Jira is not reaching the agent

### Self-assignment cron isn't running

1. Look for `[queue] Workers started. Scan cron: */5 * * * *` in startup logs — if missing, the queue failed to start (usually a Redis connection issue)
2. Verify at least one board in `BOARDS_CONFIG` has an `autoAssignJql` field set
3. Watch for `[scan]` prefixed log lines at each cron interval
4. If the cron schedule was changed via `SCAN_CRON_SCHEDULE`, restart the agent to apply the new schedule

### Slack bot doesn't respond

1. Confirm `SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN` are both set in the agent's environment
2. Verify the Slack Events API **Request URL** is set to `.../webhook/slack` and shows a ✅ tick
3. Confirm the bot is invited to the DM or channel (`/invite @JiraBot`)
4. Check agent logs for `[webhook/slack]` lines — `Invalid Slack signature` means a signing secret mismatch
5. Confirm Slack events are appearing in the `slack-jobs` BullMQ queue (check Redis with `redis-cli llen bull:slack-jobs:wait`)

### "No board config found for project" error

The `BOARDS_CONFIG` JSON does not contain an entry matching the ticket's project key. Verify the `jiraProject` field matches exactly (case-sensitive).

### GitHub authentication errors

- Confirm `GITHUB_APP_ID` and `GITHUB_APP_INSTALLATION_ID` are correct integers
- Confirm the GitHub App is installed on **all** target repositories (primary + secondary repos for multi-repo boards)
- The private key must be the full PEM contents; when setting via `fly secrets set`, use `$(cat key.pem)` to preserve newlines

### Multi-repo: only one PR opened

- Confirm the ticket has the `multi-repo` label (or the custom label set in `multiRepoLabel`)
- Confirm `secondaryRepos` is set in `BOARDS_CONFIG` for that board
- Check Fly.io logs for clone errors on the secondary repos

### Jira transition fails

The `targetStatus` and `escalationStatus` in `BOARDS_CONFIG` must exactly match the status names in your Jira workflow. Find available transitions via:

```
GET https://yourorg.atlassian.net/rest/api/3/issue/{issueKey}/transitions
Authorization: Basic base64(email:api_token)
```

---

## Infrastructure Costs (estimated at ~50 tickets/day)

### Self-hosted

| Service | Estimated Monthly Cost |
|---------|----------------------|
| VPS (2GB RAM, e.g. Hetzner CX22) | ~$5 |
| **Total infra** | **~$5/month** |

### Cloud (Cloudflare + Inngest + Fly.io)

| Service | Estimated Monthly Cost |
|---------|----------------------|
| Cloudflare Workers | Free tier sufficient |
| Fly.io (1 shared-cpu-1x, 512MB) | ~$10–20 |
| Upstash Redis | ~$5–10 |
| Inngest | Free tier sufficient |
| **Total infra** | **~$20–30/month** |

Claude Code API usage (Anthropic) will be the dominant cost at scale regardless of deployment mode. The Slack intent parsing uses the cheaper Haiku model to minimise cost per message.

---

## Repository Structure

```
jirabot/
├── packages/
│   ├── shared/          # Shared TypeScript types and config validation (Zod)
│   │   └── src/
│   │       ├── types.ts         # JiraTicket, JobPayload, RepoResult, SlackIntent, …
│   │       └── config.ts        # Zod schemas + loadConfigFromEnv()
│   ├── agent/           # Fly.io worker: Inngest handler, job orchestrator, services
│   │   └── src/
│   │       ├── services/
│   │       │   ├── jira.ts          # Jira API client (jira.js)
│   │       │   ├── github.ts        # GitHub App client (Octokit)
│   │       │   ├── git.ts           # Git operations (simple-git)
│   │       │   ├── claude.ts        # Sufficiency check, prompt builder, Slack intent parser
│   │       │   ├── slack.ts         # Slack Web API client (@slack/web-api)
│   │       │   ├── code-executor.ts # Claude Code CLI subprocess
│   │       │   └── redis.ts         # Ticket state machine + NX claim locks
│   │       ├── job.ts               # Multi-repo job orchestrator
│   │       ├── inngest.ts           # process-ticket, scan-and-assign, handle-slack-command (plain async handlers)
│   │       ├── queue.ts             # BullMQ queues, workers, cron scheduling
│   │       └── webhook-handler.ts   # Express router — /webhook/jira, /webhook/slack, /health
│   └── worker/          # Cloudflare Worker: webhook receiver (cloud deployment only)
│       └── src/
│           ├── webhook.ts           # Jira HMAC validation + payload extraction
│           ├── slack.ts             # Slack HMAC validation + event extraction
│           └── index.ts             # CF Worker fetch handler (routes /webhook/jira + /webhook/slack)
├── docs/
│   └── prd.md           # Product requirements document
├── docker-compose.yml   # Self-hosted: Redis + agent
├── .env.example         # Environment variable reference
└── package.json         # npm workspaces root
```
