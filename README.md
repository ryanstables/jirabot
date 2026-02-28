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
Cloudflare Worker validates Jira webhook + enqueues job
         │
         ▼
Inngest delivers job to Fly.io agent container
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
Inngest cron fires (default: every 5 minutes)
         │
         ▼
Agent searches Jira via configured JQL per board
         │
         ▼
Unassigned matching tickets claimed via Redis NX lock
         │
         ▼
Agent assigns ticket to itself → fires jirabot/ticket.assigned
         │
         └── Normal webhook path from here
```

### Slack path (create ticket from Slack)

```
User DMs or @mentions the Slack bot
         │
         ▼
Cloudflare Worker validates Slack signature + enqueues event
         │
         ▼
Inngest handle-slack-command function parses intent (Claude Haiku)
         │
         ├── "create a ticket for X" → Jira ticket created → bot replies with ticket key
         └── Unknown intent         → bot replies with a helpful message
```

---

## Architecture

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Webhook receiver | Cloudflare Worker | Validates Jira + Slack webhooks, enqueues to Inngest |
| Job queue | Inngest | Durable jobs, retries, concurrency limiting, cron scheduling |
| Agent worker | Fly.io (Docker/Node 22) | Runs Claude Code, manages Git, calls Jira/GitHub/Slack APIs |
| State store | Upstash Redis | Ticket state machine, attempt history, self-assignment NX locks |
| Code generation | Claude Code CLI | Reads files, runs tests, iterates until passing |

### Inngest functions

| Function | Trigger | Purpose |
|----------|---------|---------|
| `process-ticket` | `jirabot/ticket.assigned` event | Main coding job |
| `scan-and-assign` | Cron (`SCAN_CRON_SCHEDULE`) | Self-assignment loop |
| `handle-slack-command` | `jirabot/slack.command` event | Slack message handling |

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

### 4. Upstash Redis

1. Create a free database at [console.upstash.com](https://console.upstash.com)
2. Copy the **Redis URL** (the `rediss://` TLS URL, not the plain `redis://` one)

### 5. Inngest

1. Create a free account at [inngest.com](https://www.inngest.com)
2. From the dashboard, copy your **Event Key** and **Signing Key**
3. After deploying the agent to Fly.io, register the worker URL in the Inngest dashboard (see deployment steps)

### 6. Fly.io

1. Install the CLI: `brew install flyctl` (or see [fly.io/docs](https://fly.io/docs/hands-on/install-flyctl/))
2. Log in: `fly auth login`
3. The app name is `jirabot-agent` (set in `packages/agent/fly.toml`)

### 7. Cloudflare Account

1. Install Wrangler: `npm install -g wrangler`
2. Log in: `wrangler login`
3. The worker name is `jirabot-webhook` (set in `packages/worker/wrangler.toml`)

### 8. Slack App *(optional — required for Slack features)*

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

### Agent Worker (Fly.io)

All secrets are set via `fly secrets set`. Never commit these to source.

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
| `REDIS_URL` | ✅ | Upstash Redis URL (`rediss://...`) |
| `INNGEST_SIGNING_KEY` | ✅ | Inngest signing key |
| `BOARDS_CONFIG` | ✅ | JSON array of board configs (see below) |
| `MAX_ATTEMPTS` | | Max coding attempts before escalation (default: `3`) |
| `SLACK_BOT_TOKEN` | | Slack bot OAuth token (`xoxb-...`). Required for Slack features. |
| `SLACK_SIGNING_SECRET` | | Slack signing secret. Required for Slack features. |
| `SCAN_CRON_SCHEDULE` | | Cron expression for self-assignment scan (default: `*/5 * * * *`) |

### Cloudflare Worker

Secrets set via `wrangler secret put`.

| Variable | Required | Description |
|----------|----------|-------------|
| `JIRA_WEBHOOK_SECRET` | ✅ | Must match the agent worker value |
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

## Deployment

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

The agent listens on port `3001` with the Inngest handler at `/api/inngest`.

### Step 4: Register the Agent with Inngest

1. Go to your [Inngest dashboard](https://app.inngest.com)
2. Navigate to **Apps → Sync new app**
3. Enter your Fly.io app URL: `https://jirabot-agent.fly.dev/api/inngest`
4. Inngest will sync all three functions: `process-ticket`, `scan-and-assign`, `handle-slack-command`
5. Verify all functions appear in **Functions** with status `Active`
6. The `scan-and-assign` cron function will begin firing on its configured schedule automatically

### Step 5: Configure the Jira Webhook

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

### Run the agent locally

```bash
cp .env.example .env
# Fill in values in .env

npm run dev:agent
```

### Run the Cloudflare Worker locally

```bash
npm run dev:worker
```

---

## Monitoring

### Inngest Dashboard

The [Inngest dashboard](https://app.inngest.com) provides:
- Real-time job status (running, completed, failed) for all three functions
- Full event logs and step traces
- Retry history and error details
- Cron function execution history (`scan-and-assign`)

### Fly.io Logs

```bash
fly logs --config packages/agent/fly.toml
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

1. Check the Worker is receiving requests: `wrangler tail` in `packages/worker`
2. Verify the Jira webhook URL and secret match
3. Confirm `JIRA_AGENT_ACCOUNT_ID` matches the agent user's actual Jira account ID
4. Check the Inngest dashboard for queued or failed events

### Self-assignment cron isn't running

1. Confirm `scan-and-assign` appears as **Active** in the Inngest dashboard → Functions
2. Verify at least one board in `BOARDS_CONFIG` has an `autoAssignJql` field set
3. Check Fly.io logs for `[scan]` prefixed lines
4. If the cron schedule was changed via `SCAN_CRON_SCHEDULE`, re-deploy the agent so Inngest re-syncs the function definition

### Slack bot doesn't respond

1. Confirm `SLACK_SIGNING_SECRET` is set on both the **Worker** and `SLACK_BOT_TOKEN` on the **Agent**
2. Verify the Slack Events API **Request URL** is set to `.../webhook/slack` and shows a ✅ tick
3. Confirm the bot is invited to the DM or channel (`/invite @JiraBot`)
4. Check `wrangler tail` for `Invalid Slack webhook signature` errors — this usually means a signing secret mismatch
5. Check the Inngest dashboard for `handle-slack-command` events

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

| Service | Estimated Monthly Cost |
|---------|----------------------|
| Cloudflare Workers | Free tier sufficient |
| Fly.io (1 shared-cpu-1x, 512MB) | ~$10–20 |
| Upstash Redis | ~$5–10 |
| Inngest | Free tier sufficient |
| **Total infra** | **~$20–30/month** |

Claude Code API usage (Anthropic) will be the dominant cost at scale. The Slack intent parsing uses the cheaper Haiku model to minimise cost per message.

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
│   │       └── inngest.ts           # process-ticket, scan-and-assign, handle-slack-command
│   └── worker/          # Cloudflare Worker: webhook receiver
│       └── src/
│           ├── webhook.ts           # Jira HMAC validation + payload extraction
│           ├── slack.ts             # Slack HMAC validation + event extraction
│           └── index.ts             # CF Worker fetch handler (routes /webhook/jira + /webhook/slack)
├── docs/
│   └── prd.md           # Product requirements document
├── .env.example         # Environment variable reference
└── package.json         # npm workspaces root
```
