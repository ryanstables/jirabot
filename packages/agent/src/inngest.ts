import type { JobPayload, SlackCommandPayload } from '@jirabot/shared';
import { loadConfigFromEnv } from '@jirabot/shared';
import { createJiraService } from './services/jira.js';
import { createGitHubService } from './services/github.js';
import { createClaudeService } from './services/claude.js';
import { createCodeExecutor } from './services/code-executor.js';
import { createRedisStateService } from './services/redis.js';
import { createSlackService } from './services/slack.js';
import { runJob } from './job.js';

export async function processTicket(payload: JobPayload): Promise<void> {
  const config = loadConfigFromEnv();

  const boardConfig = config.boards.find((b) => b.jiraProject === payload.projectKey);
  if (!boardConfig) {
    throw new Error(`No board config found for project: ${payload.projectKey}`);
  }

  const redis = createRedisStateService(config.redisUrl);
  const githubService = createGitHubService(config.github);
  const installationToken = await githubService.getInstallationToken();

  try {
    await runJob({
      ticketKey: payload.ticketKey,
      jobId: payload.jobId,
      boardConfig,
      services: {
        jira: createJiraService(config.jira),
        github: githubService,
        claude: createClaudeService(config.anthropicApiKey),
        executor: createCodeExecutor({ maxTimeoutMs: 30 * 60 * 1000 }),
        redis,
      },
      maxAttempts: config.maxAttempts,
      workDirBase: '/tmp',
      installationToken,
      ...(config.slack ? { slack: createSlackService(config.slack.botToken) } : {}),
    });
  } finally {
    await redis.quit();
  }
}

export async function scanAndAssign(
  enqueueTicket: (payload: JobPayload) => Promise<void>
): Promise<void> {
  const config = loadConfigFromEnv();
  const boardsWithJql = config.boards.filter((b) => b.autoAssignJql);

  if (boardsWithJql.length === 0) return;

  const jira = createJiraService(config.jira);
  const redis = createRedisStateService(config.redisUrl);

  try {
    for (const board of boardsWithJql) {
      const tickets = await jira.searchTickets(board.autoAssignJql!, 20);

      for (const ticket of tickets) {
        const claimed = await redis.tryClaimTicket(ticket.key);
        if (!claimed) {
          console.log(`[scan] Ticket ${ticket.key} already claimed — skipping`);
          continue;
        }

        try {
          await jira.assignTicket(ticket.key, config.jira.agentAccountId);
          console.log(`[scan] Assigned ${ticket.key} to agent`);

          await enqueueTicket({
            ticketKey: ticket.key,
            projectKey: ticket.projectKey,
            jobId: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
          });
        } catch (err) {
          await redis.releaseTicketClaim(ticket.key);
          console.error(`[scan] Failed to assign ${ticket.key}:`, String(err));
        }
      }
    }
  } finally {
    await redis.quit();
  }
}

export async function handleSlackCommand(payload: SlackCommandPayload): Promise<void> {
  const config = loadConfigFromEnv();

  if (!config.slack) {
    console.warn('[slack-command] Slack not configured — ignoring event');
    return;
  }

  const slack = createSlackService(config.slack.botToken);
  const jira = createJiraService(config.jira);
  const claude = createClaudeService(config.anthropicApiKey);

  const projectKeys = config.boards.map((b) => b.jiraProject);
  const intent = await claude.parseSlackIntent(payload.text, projectKeys);

  if (intent.action === 'create_ticket') {
    const ticketKey = await jira.createTicket(
      intent.projectKey,
      intent.summary,
      intent.description
    );

    await slack.postMessage(
      payload.channelId,
      `✅ Created Jira ticket *${ticketKey}*: ${intent.summary}`
    );

    console.log(`[slack-command] Created ticket ${ticketKey} from Slack message`);
  } else {
    await slack.postMessage(payload.channelId, intent.response);
  }
}
