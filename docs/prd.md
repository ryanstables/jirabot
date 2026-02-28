# PRD: AI Coding Agent for Jira Ticket Resolution

**Name:** JiraBot
**Version:** 1.0
**Status:** Draft  
**Author:** Engineering  

---

## Overview

JiraBot: An autonomous AI coding agent that monitors a Jira board, interprets tickets, asks clarifying questions, writes code to resolve issues using Claude Code, opens a GitHub pull request, and transitions the ticket to the appropriate review status — all without human intervention beyond the initial ticket assignment.

---

## Goals

- Reduce engineer toil on well-scoped bugs and small features
- Decrease mean time to first PR from ticket assignment
- Create a feedback loop where the agent improves resolution quality over time

## Non-Goals

- Replacing engineers on complex architectural decisions
- Handling tickets that require access to production systems or secrets beyond the configured repo
- Supporting Jira Data Center / Server (Cloud only, v1)
- Tickets requiring changes across multiple repos *(v2)*
- Agent self-assigning tickets *(v2)*
- Maximum PR size / file change limits — the agent will attempt all tickets regardless of scope

---

## User Flow

```
Admin assigns ticket to agent
         │
         ▼
Agent reads ticket + comments
         │
         ├── Missing info? ──► Post clarifying comment in Jira ──► Wait for response
         │
         ▼
Agent diagnoses the problem
         │
         ▼
Agent invokes Claude Code in isolated container
         │
         ├── Tests fail after N attempts? ──► Comment escalation + ask for more info
         │                                    └── Transition back to "Needs Clarity"
         ▼
Code is written in a feature branch
         │
         ▼
Agent opens a PR in GitHub
         │
         ▼
Agent links PR in Jira comment + transitions ticket status
```

---

## Features & Technical Requirements

### 1. Jira Ticket Listener

**What it does:** Detects when a ticket is assigned to the agent user and ingests the full ticket context (title, description, comments, attachments, labels, linked issues).

**Tech:**
- **Jira Webhooks** (`/rest/api/3/webhook`) configured to fire on `jira:issue_assigned` events
- Alternatively, poll `/rest/api/3/search` with JQL (`assignee = agentUser AND updated >= -5m`) via a cron job if webhooks are unavailable
- Webhook receiver: **Cloudflare Worker** — validates the incoming request, confirms the assignee is the agent user, and immediately enqueues a job. Returns `200` to Jira without waiting for the job to complete (Jira will retry if it doesn't get a fast response)
- Auth: Jira API token stored in environment secrets, passed as `Basic` auth header
- SDK: **`jira.js`** (`npm install jira.js`) — `Version3Client` for all Jira interactions

---

### 2. Clarifying Question Engine

**What it does:** Evaluates whether the ticket contains sufficient information to begin coding. If not, posts a structured comment asking for specifics and waits. Re-triggers when the ticket is updated.

**Tech:**
- LLM prompt (Claude API) given the ticket content + a rubric of "what makes a ticket actionable" — returns structured JSON: `{ sufficient: boolean, questions: string[] }`
- Post comment via `client.issueComments.addComment()` from `jira.js`
- State management: **Upstash Redis** tracking ticket state: `awaiting_info | diagnosing | coding | pr_opened | escalated`
- Webhook on `comment_created` event re-evaluates sufficiency after each new comment

---

### 3. Diagnosis & Code Generation

**What it does:** Once sufficient context is available, the agent reasons about the root cause and delegates code writing to Claude Code running in an isolated job container.

**Tech:**
- **Claude Code** invoked as a CLI subprocess or via the `@anthropic-ai/claude-code` SDK
- Each job runs in an isolated working directory (`/tmp/job-{jobId}/`) on the Fly.io worker so concurrent jobs don't collide
- The agent constructs a prompt that includes: ticket description, relevant file paths (resolved from codebase search), reproduction steps, and expected outcome
- Claude Code operates on a checked-out branch of the configured repo and runs agentic loops — reading files, running tests, and iterating until passing or until `MAX_ATTEMPTS` is reached

```typescript
// Option A: SDK
import { ClaudeCode } from '@anthropic-ai/claude-code';

const result = await ClaudeCode.run({
  prompt: buildPrompt(ticket, repoContext),
  workingDirectory: `/tmp/job-${jobId}`,
  allowedTools: ['read_file', 'write_file', 'run_command'],
});

// Option B: CLI subprocess (always works)
import { execaCommand } from 'execa';

const result = await execaCommand(
  `claude-code "${buildPromptFile(ticket)}"`,
  { cwd: `/tmp/job-${jobId}`, timeout: 1800000 } // 30 min max
);
```

**Repo interaction:**
- **`simple-git`** (npm) to clone, create branch, commit, and push
- Branch naming convention: `agent/PROJ-123-short-description`

---

### 4. Escalation on Failure

**What it does:** If Claude Code fails to produce passing tests after `MAX_ATTEMPTS` (default: 3), the agent comments on the ticket explaining what was attempted, asks for additional clarifying information, and transitions the ticket back to a configurable "needs clarity" status rather than leaving it in a broken state.

**Tech:**
- Each attempt result (error output, test failures, files changed) is stored in Upstash Redis against the job ID
- On exhausting all attempts, the agent calls `client.issueComments.addComment()` with a structured escalation message summarising each attempt
- `client.issues.doTransition()` moves the ticket back to the configured `escalationStatus` (e.g. `"Needs Clarity"`, `"In Progress"`)
- The ticket is not re-triggered until a human adds a new comment, which fires the `comment_created` webhook and resets the state to `awaiting_info`

```typescript
const MAX_ATTEMPTS = 3;

async function runWithEscalation(ticket: JiraTicket) {
  const attemptSummaries: string[] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await runCodingAgent(ticket, attempt);

    if (result.testsPass) {
      await openPR(result);
      await transitionTicket(ticket.key, config.targetStatus);
      return;
    }

    attemptSummaries.push(`Attempt ${attempt}: ${result.failureSummary}`);
  }

  // All attempts exhausted — escalate
  await client.issueComments.addComment({
    issueIdOrKey: ticket.key,
    body: buildEscalationComment(ticket, attemptSummaries),
  });

  await client.issues.doTransition({
    issueIdOrKey: ticket.key,
    transition: { name: config.escalationStatus },
  });
}
```

---

### 5. GitHub Pull Request Creation

**What it does:** After code is committed to the feature branch, opens a PR against the default branch with a structured description auto-generated from the ticket.

**Tech:**
- **Octokit** (`@octokit/rest` npm package) — the official GitHub REST client
- Auth: **GitHub App** (preferred over PAT for org-level repos) — generates short-lived installation tokens via `@octokit/auth-app`
- PR body template includes: ticket summary, root cause analysis, approach taken, and link back to the Jira ticket
- Each Jira board is mapped to a specific GitHub repo in the config:

```json
{
  "boards": [
    { "jiraProject": "PROJ", "githubRepo": "org/my-repo", "defaultBranch": "main" }
  ]
}
```

---

### 6. Jira Status Transition & PR Linking

**What it does:** After the PR is opened, posts the PR URL as a Jira comment and transitions the ticket to the configured "ready for review" status.

**Tech:**
- `client.issueComments.addComment()` — posts PR link
- `client.issues.getTransitions()` — fetches available transitions for the ticket
- `client.issues.doTransition()` — executes the transition by matching the configured target status name (e.g. `"Ready for Review"`, `"In Test"`) to a transition ID
- Target status name is configurable per board in the same config file as the repo mapping

---

### 7. Agent Identity & Authentication

**What it does:** Provides the agent with secure, scoped access to both Jira and GitHub.

**Tech:**
- **Jira:** Dedicated Jira user account (`agent@company.com`) with a scoped API token. Tickets are assigned to this user to trigger the agent.
- **GitHub:** GitHub App installed on the target org/repo. Grants fine-grained permissions: `contents: write`, `pull_requests: write`, `metadata: read`. Token generated per-request using `@octokit/auth-app`.
- All secrets managed via **Doppler** (or Fly.io native secrets), injected as environment variables at runtime — never committed to source.

---

## Hosting Architecture

Claude Code is not a quick function call — it requires a real filesystem, the ability to run subprocesses (tests, linters, builds), and can run for 2–30+ minutes per job. This rules out pure serverless. The system is split into two layers.

### Layer 1 — Webhook Receiver (Cloudflare Workers)

A lightweight, always-on edge function whose only job is to validate the incoming Jira webhook, confirm it's a valid assignment to the agent user, enqueue a job, and return `200` immediately. Chosen for zero cold starts, global distribution, and negligible cost at this volume.

### Layer 2 — Job Worker (Fly.io Container)

A Node.js Docker container where Claude Code actually runs. Provides a persistent filesystem for repo clones, the ability to execute arbitrary shell commands, long timeouts, and horizontal scaling. Each job gets an isolated `/tmp/job-{id}/` working directory that is cleaned up on completion.

```
┌────────────────────────────────────────────────────────────────┐
│                        Jira Cloud                              │
│  Webhook: jira:issue_assigned → POST https://agent.workers.dev │
└────────────────────────────┬───────────────────────────────────┘
                             │
                             ▼
┌────────────────────────────────────────────────────────────────┐
│           Webhook Receiver (Cloudflare Worker)                 │
│                                                                │
│  - Verify webhook secret                                       │
│  - Confirm assignee === agent user                             │
│  - Write job to queue: { ticketKey, projectKey, timestamp }    │
│  - Return 200 immediately                                      │
└────────────────────────────┬───────────────────────────────────┘
                             │
                             ▼
┌────────────────────────────────────────────────────────────────┐
│              Job Queue (Inngest or BullMQ + Upstash Redis)     │
│                                                                │
│  - Durable job storage (survives worker restarts)             │
│  - Retry logic with backoff                                    │
│  - Concurrency limiting (max N jobs at once)                  │
│  - Job status tracking + dashboard                            │
└────────────────────────────┬───────────────────────────────────┘
                             │
                             ▼
┌────────────────────────────────────────────────────────────────┐
│              Agent Worker (Fly.io Docker Container)            │
│                                                                │
│  Per job:                                                      │
│  1. Pull ticket context via jira.js                           │
│  2. Run sufficiency check (Claude API)                        │
│  3. Clone repo to /tmp/job-{id}/                              │
│  4. Invoke Claude Code as subprocess (30 min timeout)         │
│  5. On success: push branch + open PR via Octokit             │
│  6. Comment + transition ticket via jira.js                   │
│  7. On failure after MAX_ATTEMPTS: post escalation comment    │
│     and transition ticket to escalationStatus                 │
│  8. Clean up /tmp/job-{id}/                                   │
└──────────────┬──────────────────────┬──────────────────────────┘
               │                      │
               ▼                      ▼
    ┌──────────────────┐   ┌──────────────────────┐
    │   GitHub Repo    │   │   Upstash Redis      │
    │  (Octokit / App) │   │  (job + ticket state)│
    └──────────────────┘   └──────────────────────┘
```

### Queue: Inngest vs BullMQ

**Inngest** (recommended for v1) — fully managed, handles retries, concurrency, timeouts, and provides a dashboard out of the box. Less infrastructure to own.

**BullMQ + Upstash Redis** — more control, fully self-hosted, better if avoiding additional vendor dependencies is a priority.

### Estimated Infrastructure Cost

At low volume (~50 tickets/day):

| Service | Estimated Monthly Cost |
|---|---|
| Cloudflare Workers | Free tier sufficient |
| Fly.io (worker container) | ~$10–20 |
| Upstash Redis | ~$5–10 |
| Inngest (if used) | Free tier sufficient |
| **Total infra** | **~$20–30/month** |

Claude Code API usage will be the dominant cost at scale.

---

## System Configuration Schema

```typescript
interface AgentConfig {
  jira: {
    host: string;             // e.g. "your-org.atlassian.net"
    agentEmail: string;
    apiToken: string;         // from env
  };
  github: {
    appId: number;
    privateKey: string;       // from env
    installationId: number;
  };
  boards: Array<{
    jiraProject: string;      // e.g. "PROJ"
    githubRepo: string;       // e.g. "org/repo"
    defaultBranch: string;    // e.g. "main"
    targetStatus: string;     // e.g. "Ready for Review"
    escalationStatus: string; // e.g. "Needs Clarity"
  }>;
  codingAgent: "claude-code";
  maxAttempts: number;        // default: 3
}
```

---

## Key Dependencies

| Package | Purpose |
|---|---|
| `jira.js` | Jira Cloud API client (v2/v3, TypeScript) |
| `@octokit/rest` | GitHub REST API client |
| `@octokit/auth-app` | GitHub App authentication |
| `@anthropic-ai/claude-code` | Claude Code SDK for code generation |
| `simple-git` | Git operations (branch, commit, push) |
| `execa` | Subprocess execution for Claude Code CLI |
| `inngest` | Job queue and orchestration |
| `ioredis` | Redis client for state management |
| Cloudflare Workers | Webhook receiver (edge) |
| Fly.io | Long-running agent worker containers |

---

## Deferred to v2

- Multi-repo ticket support — tickets that require coordinated changes across more than one GitHub repository
- Agent self-assignment — the agent scanning for and claiming unassigned tickets matching certain criteria rather than waiting for manual assignment
