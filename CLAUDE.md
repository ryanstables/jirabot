# JiraBot — CLAUDE.md

Autonomous AI coding agent that monitors a Jira board, implements tickets using Claude Code, opens GitHub PRs, and transitions Jira status — without human intervention beyond ticket assignment.

## Architecture

```
Jira webhook → Cloudflare Worker → Inngest → Fly.io agent container → Claude Code CLI
                (validate + enqueue)  (durable queue)  (orchestrate job)   (write code)
```

| Package | Location | Runtime | Purpose |
|---------|----------|---------|---------|
| `@jirabot/shared` | `packages/shared/` | N/A | Shared types (`JiraTicket`, `JobPayload`, `TicketState`) and Zod config validation |
| `@jirabot/agent` | `packages/agent/` | Fly.io / Node 22 | Inngest handler, job orchestrator, all service clients |
| `@jirabot/worker` | `packages/worker/` | Cloudflare Worker | HMAC-validates Jira webhooks, enqueues `jirabot/ticket.assigned` event to Inngest |

## Key Files

| File | Purpose |
|------|---------|
| `packages/agent/src/job.ts` | Main job orchestrator — sufficiency check → clone → coding loop → PR → Jira transition |
| `packages/agent/src/inngest.ts` | Inngest function registration (`process-ticket`, concurrency 5, retries 3) + HTTP server on port 3001 |
| `packages/agent/src/services/jira.ts` | Jira REST API client (jira.js) |
| `packages/agent/src/services/github.ts` | GitHub App client (Octokit) — creates PRs, generates installation tokens |
| `packages/agent/src/services/git.ts` | Git operations via simple-git — clone, branch, commit, push |
| `packages/agent/src/services/claude.ts` | Anthropic SDK — sufficiency check + coding prompt builder |
| `packages/agent/src/services/code-executor.ts` | Spawns Claude Code CLI subprocess, 30 min timeout |
| `packages/agent/src/services/redis.ts` | Upstash Redis state machine (`TicketState`) and attempt history |
| `packages/worker/src/webhook.ts` | HMAC-SHA256 validation of Jira webhook payloads |
| `packages/shared/src/types.ts` | Canonical TypeScript types (`JiraTicket`, `JobPayload`, `AttemptRecord`, `TicketState`) |
| `packages/shared/src/config.ts` | `loadConfigFromEnv()` — Zod-validated env parsing |

## Ticket State Machine

```
awaiting_info → diagnosing → coding → pr_opened
                                 ↘ escalated
```

States are stored in Upstash Redis per ticket key.

## Job Flow (`packages/agent/src/job.ts`)

1. Fetch ticket from Jira
2. Claude sufficiency check — if insufficient, post questions + set state `awaiting_info`, stop
3. Set state `diagnosing`, create work dir in `/tmp`
4. Clone repo, create branch `agent/{TICKET-KEY}-{slug}`
5. Set state `coding`, loop up to `MAX_ATTEMPTS`:
   - Run Claude Code CLI with prompt
   - On success + tests pass: get changed files, commit, push, open PR, comment + transition to `targetStatus`, set state `pr_opened`
   - On failure: record attempt summary, continue
6. If all attempts fail: post escalation comment, transition to `escalationStatus`, set state `escalated`
7. `finally`: clean up work dir

## Commands

```bash
npm install               # install all workspace deps
npm test                  # run all tests (vitest)
npm run build             # build all packages
npm run dev:agent         # run agent locally
npm run dev:worker        # run Cloudflare worker locally (wrangler dev)
```

## Deployment

```bash
# Cloudflare Worker
cd packages/worker && wrangler deploy

# Fly.io agent (run from repo root — Docker needs full workspace context)
fly deploy --config packages/agent/fly.toml
fly logs --config packages/agent/fly.toml
```

## Critical Environment Variables

### Agent (Fly.io secrets)
- `JIRA_HOST`, `JIRA_AGENT_EMAIL`, `JIRA_API_TOKEN`, `JIRA_AGENT_ACCOUNT_ID`, `JIRA_WEBHOOK_SECRET`
- `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (full PEM), `GITHUB_APP_INSTALLATION_ID`
- `ANTHROPIC_API_KEY`
- `REDIS_URL` (Upstash `rediss://` URL)
- `INNGEST_SIGNING_KEY`
- `BOARDS_CONFIG` (JSON array mapping Jira projects to GitHub repos)
- `MAX_ATTEMPTS` (default: `3`)

### Worker (Cloudflare secrets)
- `JIRA_WEBHOOK_SECRET`, `INNGEST_EVENT_KEY`, `JIRA_AGENT_ACCOUNT_ID`

## BOARDS_CONFIG Schema

```json
[{
  "jiraProject": "PROJ",
  "githubRepo": "org/repo",
  "defaultBranch": "main",
  "targetStatus": "Ready for Review",
  "escalationStatus": "Needs Clarity"
}]
```

## Conventions

- npm workspaces monorepo — run installs and tests from repo root
- TypeScript with `.js` extensions in imports (ESM)
- Tests use vitest; test files are colocated at `src/__tests__/*.test.ts`
- Docker build runs from repo root (`fly deploy --config packages/agent/fly.toml`)
- Inngest event name: `jirabot/ticket.assigned`
- Branch naming: `agent/{TICKET-KEY}-{sanitised-title-slug}`
- PR title format: `fix({TICKET-KEY}): {ticket summary}`
