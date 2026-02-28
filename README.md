# JiraBot

An autonomous AI coding agent that monitors a Jira board, interprets tickets, writes code using Claude Code, opens GitHub pull requests, and transitions tickets to review status — all without human intervention beyond the initial ticket assignment.

---

## How It Works

```
Admin assigns Jira ticket to the agent user
         │
         ▼
Cloudflare Worker validates webhook + enqueues job
         │
         ▼
Inngest delivers job to Fly.io agent container
         │
         ├── Insufficient info? → Post clarifying comment → Wait for reply
         │
         ▼
Claude Code clones repo, implements fix, runs tests
         │
         ├── Tests fail after 3 attempts? → Escalation comment → Needs Clarity
         │
         ▼
Git pushes branch → GitHub PR opened
         │
         ▼
PR link posted to Jira + ticket transitioned to "Ready for Review"
```

---

## Architecture

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Webhook receiver | Cloudflare Worker | Validates Jira webhook, enqueues job, returns 200 immediately |
| Job queue | Inngest | Durable job storage, retries, concurrency limiting |
| Agent worker | Fly.io (Docker/Node 22) | Runs Claude Code, manages Git, calls Jira/GitHub APIs |
| State store | Upstash Redis | Tracks ticket state machine and attempt history |
| Code generation | Claude Code CLI | Reads files, runs tests, iterates until passing |

---

## Prerequisites

Before deploying, you need accounts and credentials for each of the following services.

### 1. Jira Cloud

- A Jira Cloud account with a project you want the bot to manage
- A **dedicated agent user** (e.g. `jirabot@yourcompany.com`) — tickets assigned to this user trigger the bot
- An **API token** for the agent user: [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
- The **account ID** of the agent user (visible in the user profile URL or via the Jira REST API)
- The **Jira status names** you want to use for "Ready for Review" and "Needs Clarity" (must match exactly, e.g. `"In Review"`, `"Needs Clarity"`)

### 2. GitHub App

Create a GitHub App for authenticated repo access (preferred over PATs for org repos):

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

### 3. Anthropic API Key

Get a key from [console.anthropic.com](https://console.anthropic.com). The bot uses `claude-sonnet-4-6` for ticket sufficiency checks and builds Claude Code prompts.

### 4. Upstash Redis

1. Create a free database at [console.upstash.com](https://console.upstash.com)
2. Copy the **Redis URL** (the `rediss://` TLS URL, not the plain `redis://` one)

### 5. Inngest

1. Create a free account at [inngest.com](https://www.inngest.com)
2. From the dashboard, copy your **Event Key** and **Signing Key**
3. After deploying the agent to Fly.io, register the worker URL in the Inngest dashboard (see below)

### 6. Fly.io

1. Install the CLI: `brew install flyctl` (or see [fly.io/docs/hands-on/install-flyctl](https://fly.io/docs/hands-on/install-flyctl/))
2. Log in: `fly auth login`
3. The app name is `jirabot-agent` (set in `packages/agent/fly.toml`)

### 7. Cloudflare Account

1. Install Wrangler: `npm install -g wrangler`
2. Log in: `wrangler login`
3. The worker name is `jirabot-webhook` (set in `packages/worker/wrangler.toml`)

---

## Environment Variables

### Agent Worker (Fly.io)

All secrets are set via `fly secrets set`. Never commit these to source.

| Variable | Description |
|----------|-------------|
| `JIRA_HOST` | Your Jira Cloud hostname, e.g. `yourorg.atlassian.net` |
| `JIRA_AGENT_EMAIL` | Email address of the agent Jira user |
| `JIRA_API_TOKEN` | Jira API token for the agent user |
| `JIRA_AGENT_ACCOUNT_ID` | Jira accountId of the agent user |
| `JIRA_WEBHOOK_SECRET` | A random string used to sign Jira webhooks (you choose this) |
| `GITHUB_APP_ID` | Numeric GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY` | PEM private key contents (include `\n` newlines as literal `\n`) |
| `GITHUB_APP_INSTALLATION_ID` | Numeric installation ID |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `REDIS_URL` | Upstash Redis URL (`rediss://...`) |
| `INNGEST_SIGNING_KEY` | Inngest signing key |
| `BOARDS_CONFIG` | JSON array of board configs (see below) |
| `MAX_ATTEMPTS` | Max coding attempts before escalation (default: `3`) |

### Cloudflare Worker

Secrets are set via `wrangler secret put`. The `JIRA_AGENT_ACCOUNT_ID` can also be set as a plain var in `wrangler.toml`.

| Variable | Description |
|----------|-------------|
| `JIRA_WEBHOOK_SECRET` | Must match the value set on the agent worker |
| `INNGEST_EVENT_KEY` | Inngest event key |
| `JIRA_AGENT_ACCOUNT_ID` | Jira accountId of the agent user (filters webhook events) |

---

## BOARDS_CONFIG

The `BOARDS_CONFIG` environment variable maps Jira projects to GitHub repositories. It is a JSON array:

```json
[
  {
    "jiraProject": "PROJ",
    "githubRepo": "your-org/your-repo",
    "defaultBranch": "main",
    "targetStatus": "Ready for Review",
    "escalationStatus": "Needs Clarity"
  }
]
```

| Field | Description |
|-------|-------------|
| `jiraProject` | Jira project key (e.g. `PROJ`, `ENG`) |
| `githubRepo` | GitHub repository in `org/repo` format |
| `defaultBranch` | Branch to open PRs against (e.g. `main`) |
| `targetStatus` | Jira status name to transition to after PR is opened |
| `escalationStatus` | Jira status name to transition to when all attempts fail |

Multiple boards can be configured. Each project key must be unique.

---

## Deployment

### Step 1: Install dependencies

```bash
npm install
```

### Step 2: Deploy the Cloudflare Worker

```bash
cd packages/worker

# Set secrets
wrangler secret put JIRA_WEBHOOK_SECRET
# (paste your chosen secret string when prompted)

wrangler secret put INNGEST_EVENT_KEY
# (paste your Inngest event key when prompted)

# Set the agent account ID as a var (or also as a secret)
# Edit wrangler.toml: set JIRA_AGENT_ACCOUNT_ID = "your-account-id"

# Deploy
wrangler deploy
```

After deployment, Wrangler prints a URL like:
```
https://jirabot-webhook.<your-subdomain>.workers.dev
```

Keep this URL — you'll need it for the Jira webhook configuration.

### Step 3: Deploy the Agent Worker to Fly.io

Run all commands from the **repository root** (required so Docker has access to all workspace packages).

```bash
# Create the Fly.io app (first time only)
fly apps create jirabot-agent

# Set all required secrets
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

# Set GitHub private key (multi-line — use a file or escape newlines)
fly secrets set GITHUB_APP_PRIVATE_KEY="$(cat path/to/private-key.pem)"

# Set boards config
fly secrets set BOARDS_CONFIG='[{"jiraProject":"PROJ","githubRepo":"your-org/your-repo","defaultBranch":"main","targetStatus":"Ready for Review","escalationStatus":"Needs Clarity"}]'

# Deploy
fly deploy --config packages/agent/fly.toml
```

Verify it's running:
```bash
fly status --config packages/agent/fly.toml
fly logs --config packages/agent/fly.toml
```

The agent listens on port `3001` with the Inngest handler at `/api/inngest`.

### Step 4: Register the Agent with Inngest

1. Go to your [Inngest dashboard](https://app.inngest.com)
2. Navigate to **Apps → Sync new app**
3. Enter your Fly.io app URL: `https://jirabot-agent.fly.dev/api/inngest`
4. Inngest will sync the `process-ticket` function
5. Verify the function appears in **Functions** with status `Active`

### Step 5: Configure the Jira Webhook

1. Log in to Jira as an **administrator**
2. Go to **Settings → System → WebHooks** (or visit `https://yourorg.atlassian.net/plugins/servlet/webhooks`)
3. Click **Create a WebHook**
4. Fill in:
   - **Name:** JiraBot Agent
   - **URL:** `https://jirabot-webhook.<your-subdomain>.workers.dev`
   - **Secret:** The same value you used for `JIRA_WEBHOOK_SECRET`
   - **Events:** Check **Issue → updated** (which covers assignment changes)
   - Optionally scope to specific projects with a JQL filter: `project = PROJ`
5. Click **Create**

---

## Usage

### Triggering the Bot

Assign any Jira ticket to the agent user (`jirabot@yourcompany.com`). The bot will:

1. **Receive the webhook** via the Cloudflare Worker
2. **Check ticket sufficiency** — if the title and description don't provide enough information to write code, the bot posts a comment listing specific questions and sets the ticket state to `awaiting_info`. It re-evaluates each time a new comment is added.
3. **Clone the repository** and create a branch: `agent/PROJ-123-short-description`
4. **Invoke Claude Code** to diagnose and fix the issue (up to `MAX_ATTEMPTS` times)
5. **Open a GitHub PR** with a structured description linking back to the Jira ticket
6. **Post the PR link** as a Jira comment and transition the ticket to your configured `targetStatus`

### What Makes a Good Ticket

The bot evaluates each ticket against a rubric. Tickets are more likely to proceed directly to coding when they include:

- A clear description of the **expected behaviour**
- A description of the **actual (broken) behaviour**
- **Reproduction steps** (for bugs)
- Relevant **file paths or component names** (if known)
- **Acceptance criteria** (for features)

If information is missing, the bot asks. Reply to its comment with the requested details and the bot will re-evaluate automatically.

### Escalation

If Claude Code cannot produce passing tests after `MAX_ATTEMPTS` attempts, the bot:
- Posts a `🚨 JiraBot Escalation` comment summarising each attempt (what was tried, what failed)
- Transitions the ticket to your configured `escalationStatus` (e.g. `Needs Clarity`)
- Stops retrying until a human adds a new comment (which re-triggers the sufficiency check)

### Branch and PR Naming

- **Branch:** `agent/PROJ-123-short-description-of-ticket` (sanitised from ticket title)
- **PR title:** Ticket key + title, e.g. `[PROJ-123] Fix null pointer in user service`
- **PR body:** Includes ticket summary, root cause analysis, approach taken, and a link to the Jira ticket

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

### Run the agent locally

```bash
# Copy and fill in environment variables
cp .env.example .env

# Start the agent
cd packages/agent
npm run dev
```

### Run the Cloudflare Worker locally

```bash
cd packages/worker
wrangler dev
```

---

## Monitoring

### Inngest Dashboard

The [Inngest dashboard](https://app.inngest.com) provides:
- Real-time job status (running, completed, failed)
- Full event logs and step traces
- Retry history and error details
- Concurrency and throughput metrics

### Fly.io Logs

```bash
# Tail live logs
fly logs --config packages/agent/fly.toml

# Check machine status
fly status --config packages/agent/fly.toml
```

### Cloudflare Worker Logs

```bash
cd packages/worker
wrangler tail
```

---

## Troubleshooting

### Bot doesn't respond to ticket assignment

1. Check the Cloudflare Worker is receiving requests: `wrangler tail` in `packages/worker`
2. Verify the Jira webhook URL and secret match
3. Confirm the `JIRA_AGENT_ACCOUNT_ID` matches the agent user's actual Jira account ID (get it from `GET /rest/api/3/myself` using the agent's credentials)
4. Check Inngest dashboard for queued or failed events

### "No board config found for project" error

The `BOARDS_CONFIG` JSON does not contain an entry matching the ticket's project key. Verify the `jiraProject` field matches the Jira project key exactly (case-sensitive).

### GitHub authentication errors

- Confirm `GITHUB_APP_ID` and `GITHUB_APP_INSTALLATION_ID` are correct integers (no quotes in the env var)
- Confirm the GitHub App is installed on the target repository
- The private key must be the full PEM contents including header/footer lines; when setting via `fly secrets set`, use `$(cat key.pem)` to preserve newlines

### Claude Code fails immediately

- Confirm `ANTHROPIC_API_KEY` is set and valid
- Check Fly.io logs: `fly logs --config packages/agent/fly.toml`
- The claude CLI is installed inside the Docker image at build time. If it's missing, re-deploy with `fly deploy`

### Jira transition fails

The `targetStatus` and `escalationStatus` in `BOARDS_CONFIG` must exactly match the status names in your Jira workflow (including capitalisation and spacing). Find available transitions via:

```
GET https://yourorg.atlassian.net/rest/api/3/issue/{issueKey}/transitions
Authorization: Basic base64(email:api_token)
```

---

## Infrastructure Costs (estimated at ~50 tickets/day)

| Service | Estimated Monthly Cost |
|---------|----------------------|
| Cloudflare Workers | Free tier sufficient |
| Fly.io (1 shared-cpu-1x, 512MB) | ~$10–20 |
| Upstash Redis | ~$5–10 |
| Inngest | Free tier sufficient |
| **Total infra** | **~$20–30/month** |

Claude Code API usage (Anthropic) will be the dominant cost at scale.

---

## Repository Structure

```
jirabot/
├── packages/
│   ├── shared/          # Shared TypeScript types and config validation (Zod)
│   ├── agent/           # Fly.io worker: Inngest handler, job orchestrator, services
│   │   ├── src/
│   │   │   ├── services/
│   │   │   │   ├── jira.ts          # Jira API client (jira.js)
│   │   │   │   ├── github.ts        # GitHub App client (Octokit)
│   │   │   │   ├── git.ts           # Git operations (simple-git)
│   │   │   │   ├── claude.ts        # Claude API (sufficiency check + prompt builder)
│   │   │   │   ├── code-executor.ts # Claude Code CLI subprocess
│   │   │   │   └── redis.ts         # Ticket state machine (ioredis)
│   │   │   ├── job.ts               # Main job orchestrator
│   │   │   └── inngest.ts           # Inngest function + HTTP server
│   │   ├── Dockerfile
│   │   └── fly.toml
│   └── worker/          # Cloudflare Worker: webhook receiver
│       ├── src/
│       │   ├── webhook.ts           # HMAC validation + payload extraction
│       │   └── index.ts             # CF Worker fetch handler
│       └── wrangler.toml
├── docs/
│   └── prd.md           # Product requirements document
├── .env.example         # Environment variable reference
└── package.json         # npm workspaces root
```
