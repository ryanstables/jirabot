import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import type { BoardConfig, RepoResult } from '@jirabot/shared';
import { createGitService } from './services/git.js';
import type { JiraService } from './services/jira.js';
import type { GitHubService } from './services/github.js';
import type { ClaudeService } from './services/claude.js';
import type { SlackService } from './services/slack.js';
import type { RedisStateService } from './services/redis.js';
import type { createCodeExecutor } from './services/code-executor.js';

type Executor = ReturnType<typeof createCodeExecutor>;

export interface JobServices {
  jira: JiraService;
  github: GitHubService;
  claude: ClaudeService;
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
  installationToken: string;
  slack?: SlackService;
}

export async function runJob(options: JobOptions): Promise<void> {
  const { ticketKey, jobId, boardConfig, services, maxAttempts, workDirBase, installationToken, slack } = options;
  const { jira, github, claude, executor, redis } = services;

  const slackChannel = boardConfig.slackChannel;

  async function notifySlack(text: string): Promise<void> {
    if (slack && slackChannel) {
      await slack.postMessage(slackChannel, text).catch((err) => {
        console.error(`[${jobId}] Slack notification failed:`, String(err));
      });
    }
  }

  console.log(`[${jobId}] Starting job for ticket ${ticketKey}`);

  // 1. Fetch ticket context
  const ticket = await jira.getTicket(ticketKey);

  // 2. Sufficiency check
  const sufficiency = await claude.checkSufficiency(ticket);

  if (!sufficiency.sufficient) {
    const questionList = sufficiency.questions.map((q, i) => `${i + 1}. ${q}`).join('\n');
    await jira.postComment(
      ticketKey,
      `Hi! I need a bit more information before I can work on this ticket:\n\n${questionList}\n\nPlease reply and I'll get started.`
    );
    await redis.setTicketState(ticketKey, 'awaiting_info');
    await notifySlack(`ℹ️ Ticket *${ticketKey}* needs more info — posted clarifying questions to Jira.`);
    console.log(`[${jobId}] Ticket ${ticketKey} needs more info — posted clarifying questions`);
    return;
  }

  await redis.setTicketState(ticketKey, 'diagnosing');

  // 3. Setup working directory
  const workDir = path.join(workDirBase, `job-${jobId}`);

  try {
    await fs.mkdir(workDir, { recursive: true });

    // 4. Determine repos — primary always, secondaries only when ticket has the multi-repo label
    const isMultiRepo =
      ticket.labels.includes(boardConfig.multiRepoLabel) &&
      boardConfig.secondaryRepos.length > 0;

    const allRepos = [
      { githubRepo: boardConfig.githubRepo, defaultBranch: boardConfig.defaultBranch },
      ...(isMultiRepo ? boardConfig.secondaryRepos : []),
    ];

    // 5. Clone all repos into named subdirectories
    const git = createGitService(installationToken);

    const repoDirs = await Promise.all(
      allRepos.map(async (repo, idx) => {
        const dirName = idx === 0 ? 'repo-primary' : `repo-secondary-${idx - 1}`;
        const repoDir = path.join(workDir, dirName);
        await git.cloneRepo(repo.githubRepo, repoDir, repo.defaultBranch);
        return { repoDir, dirName, repo };
      })
    );

    // 6. Create branches in all repos
    const branches = await Promise.all(
      repoDirs.map(({ repoDir }) => git.createBranch(repoDir, ticketKey, ticket.summary))
    );

    await redis.setTicketState(ticketKey, 'coding');

    // 7. Build prompt (multi-repo layout section injected when >1 repo)
    const prompt = claude.buildCodingPrompt(
      ticket,
      repoDirs.length > 1 ? repoDirs.map(({ dirName }) => dirName) : undefined
    );

    const attemptSummaries: string[] = [];

    // 8. Attempt coding loop — Claude Code runs in workDir and can access all repo subdirs
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      console.log(`[${jobId}] Attempt ${attempt}/${maxAttempts}`);
      const result = await executor.run({ prompt, workDir, attempt });

      if (result.success && result.testsPass) {
        // 9. Commit, push, and open a PR for each repo
        const repoResults: RepoResult[] = [];

        for (let i = 0; i < repoDirs.length; i++) {
          const { repoDir, repo } = repoDirs[i]!;
          const branch = branches[i]!;

          const filesChanged = await git.getChangedFiles(repoDir);
          const sha = await git.commitAll(repoDir, `fix(${ticketKey}): resolve ${ticket.summary}`);

          await redis.recordAttempt(ticketKey, {
            attempt,
            failureSummary: '',
            filesChanged,
            timestamp: new Date().toISOString(),
          });

          await git.push(repoDir, branch);

          const crossLinks = repoResults
            .map((r) => `- ${r.repo}: ${r.prUrl}`)
            .join('\n');

          const prBody = buildPRBody(ticket, sha, attemptSummaries, crossLinks || undefined);
          const { prUrl, prNumber } = await github.createPR({
            repo: repo.githubRepo,
            title: `fix(${ticketKey}): ${ticket.summary}`,
            body: prBody,
            head: branch,
            base: repo.defaultBranch,
          });

          repoResults.push({ repo: repo.githubRepo, branch, prUrl, prNumber });
        }

        // 10. Post Jira comment and transition
        await jira.postComment(ticketKey, buildPRComment(ticketKey, repoResults));
        await jira.transitionTicket(ticketKey, boardConfig.targetStatus);
        await redis.setTicketState(ticketKey, 'pr_opened');

        const prList = repoResults.map((r) => r.prUrl).join(', ');
        await notifySlack(
          `✅ *${ticketKey}* complete — ${repoResults.length} PR(s) opened: ${prList}`
        );
        console.log(`[${jobId}] Success! ${repoResults.length} PR(s) opened`);
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

    // 11. All attempts exhausted — escalate
    await jira.postComment(ticketKey, buildEscalationComment(ticketKey, attemptSummaries));
    await jira.transitionTicket(ticketKey, boardConfig.escalationStatus);
    await redis.setTicketState(ticketKey, 'escalated');

    await notifySlack(`🚨 *${ticketKey}* escalated after ${maxAttempts} failed attempts.`);
    console.log(`[${jobId}] Escalated after ${maxAttempts} failed attempts`);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

function buildPRBody(
  ticket: { key: string; summary: string; description: string | null },
  sha: string,
  previousAttempts: string[],
  crossLinks?: string
): string {
  const attemptsSection =
    previousAttempts.length > 0
      ? `\n## Previous Attempts\n${previousAttempts.join('\n')}`
      : '';

  const crossLinksSection = crossLinks
    ? `\n## Related PRs (same ticket)\n${crossLinks}`
    : '';

  return `## Summary
Resolves Jira ticket [${ticket.key}]: ${ticket.summary}

## Description
${(ticket.description ?? '').slice(0, 500)}

## Changes
Commit: \`${sha}\`${attemptsSection}${crossLinksSection}

---
*Opened automatically by JiraBot*`;
}

function buildPRComment(ticketKey: string, results: RepoResult[]): string {
  if (results.length === 1) {
    const r = results[0]!;
    return `✅ PR opened: ${r.prUrl}\n\nBranch: \`${r.branch}\``;
  }
  const lines = results.map((r) => `- **${r.repo}**: ${r.prUrl} (\`${r.branch}\`)`).join('\n');
  return `✅ PRs opened across ${results.length} repositories:\n\n${lines}`;
}

function buildEscalationComment(ticketKey: string, attemptSummaries: string[]): string {
  return `🚨 **JiraBot Escalation** — I was unable to resolve this ticket after ${attemptSummaries.length} attempts.

## What was attempted

${attemptSummaries.join('\n\n')}

## Next steps

Please review the above and provide additional clarification or context. Once you reply, I'll automatically retry.

*(Ticket has been moved back to escalation status)*`;
}
