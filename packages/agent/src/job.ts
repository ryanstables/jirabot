import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import type { BoardConfig } from '@jirabot/shared';
import type { JiraService } from './services/jira.js';
import type { GitHubService } from './services/github.js';
import type { ClaudeService } from './services/claude.js';
import type { GitService } from './services/git.js';
import type { RedisStateService } from './services/redis.js';
import type { createCodeExecutor } from './services/code-executor.js';

type Executor = ReturnType<typeof createCodeExecutor>;

export interface JobServices {
  jira: JiraService;
  github: GitHubService;
  claude: ClaudeService;
  git: GitService;
  executor: Executor;
  redis: RedisStateService;
}

export interface JobOptions {
  ticketKey: string;
  jobId: string;
  boardConfig: BoardConfig;
  services: JobServices;
  maxAttempts: number;
  workDirBase: string;
}

export async function runJob(options: JobOptions): Promise<void> {
  const { ticketKey, jobId, boardConfig, services, maxAttempts, workDirBase } = options;
  const { jira, github, claude, git, executor, redis } = services;

  console.log(`[${jobId}] Starting job for ticket ${ticketKey}`);

  // 1. Fetch ticket context
  const ticket = await jira.getTicket(ticketKey);

  // 2. Check sufficiency
  const sufficiency = await claude.checkSufficiency(ticket);

  if (!sufficiency.sufficient) {
    const questionList = sufficiency.questions.map((q, i) => `${i + 1}. ${q}`).join('\n');
    await jira.postComment(
      ticketKey,
      `Hi! I need a bit more information before I can work on this ticket:\n\n${questionList}\n\nPlease reply and I'll get started.`
    );
    await redis.setTicketState(ticketKey, 'awaiting_info');
    console.log(`[${jobId}] Ticket ${ticketKey} needs more info — posted clarifying questions`);
    return;
  }

  await redis.setTicketState(ticketKey, 'diagnosing');

  // 3. Setup working directory
  const workDir = path.join(workDirBase, `job-${jobId}`);
  await fs.mkdir(workDir, { recursive: true });

  try {
    // 4. Clone repo and create branch
    await git.cloneRepo(boardConfig.githubRepo, workDir, boardConfig.defaultBranch);
    const branch = await git.createBranch(workDir, ticketKey, ticket.summary);

    await redis.setTicketState(ticketKey, 'coding');

    // 5. Attempt coding loop
    const prompt = claude.buildCodingPrompt(ticket);
    const attemptSummaries: string[] = [];

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      console.log(`[${jobId}] Attempt ${attempt}/${maxAttempts}`);
      const result = await executor.run({ prompt, workDir, attempt });

      if (result.success && result.testsPass) {
        // Commit whatever Claude Code produced
        const sha = await git.commitAll(workDir, `fix(${ticketKey}): resolve ${ticket.summary}`);
        const filesChanged = await git.getChangedFiles(workDir);

        await redis.recordAttempt(ticketKey, {
          attempt,
          failureSummary: '',
          filesChanged,
          timestamp: new Date().toISOString(),
        });

        // 6. Push branch and open PR
        await git.push(workDir, branch);

        const prBody = buildPRBody(ticket, sha, attemptSummaries);
        const { prUrl } = await github.createPR({
          repo: boardConfig.githubRepo,
          title: `fix(${ticketKey}): ${ticket.summary}`,
          body: prBody,
          head: branch,
          base: boardConfig.defaultBranch,
        });

        // 7. Comment and transition
        await jira.postComment(ticketKey, `PR opened: ${prUrl}\n\nBranch: \`${branch}\``);
        await jira.transitionTicket(ticketKey, boardConfig.targetStatus);
        await redis.setTicketState(ticketKey, 'pr_opened');

        console.log(`[${jobId}] Success! PR opened: ${prUrl}`);
        return;
      }

      const summary = result.failureSummary ?? `Attempt ${attempt} failed without a summary`;
      attemptSummaries.push(`**Attempt ${attempt}:** ${summary}`);

      await redis.recordAttempt(ticketKey, {
        attempt,
        failureSummary: summary,
        filesChanged: [],
        timestamp: new Date().toISOString(),
      });
    }

    // 8. All attempts exhausted — escalate
    const escalationComment = buildEscalationComment(ticketKey, attemptSummaries);
    await jira.postComment(ticketKey, escalationComment);
    await jira.transitionTicket(ticketKey, boardConfig.escalationStatus);
    await redis.setTicketState(ticketKey, 'escalated');

    console.log(`[${jobId}] Escalated after ${maxAttempts} failed attempts`);
  } finally {
    // Clean up working directory
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

function buildPRBody(
  ticket: { key: string; summary: string; description: string | null },
  sha: string,
  previousAttempts: string[]
): string {
  const attemptsSection = previousAttempts.length > 0
    ? `\n## Previous Attempts\n${previousAttempts.join('\n')}`
    : '';

  return `## Summary
Resolves Jira ticket [${ticket.key}]: ${ticket.summary}

## Description
${(ticket.description ?? '').slice(0, 500)}

## Changes
Commit: \`${sha}\`${attemptsSection}

---
*Opened automatically by JiraBot*`;
}

function buildEscalationComment(ticketKey: string, attemptSummaries: string[]): string {
  return `JiraBot Escalation — I was unable to resolve this ticket after ${attemptSummaries.length} attempts.

## What was attempted

${attemptSummaries.join('\n\n')}

## Next steps

Please review the above and provide additional clarification or context. Once you reply, I'll automatically retry.

*(Ticket has been moved back to escalation status)*`;
}
