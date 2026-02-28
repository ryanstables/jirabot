import { Inngest } from 'inngest';
import { serve } from 'inngest/node';
import * as http from 'node:http';
import type { JobPayload, SlackCommandPayload } from '@jirabot/shared';
import { loadConfigFromEnv } from '@jirabot/shared';
import { createJiraService } from './services/jira.js';
import { createGitHubService } from './services/github.js';
import { createClaudeService } from './services/claude.js';
import { createCodeExecutor } from './services/code-executor.js';
import { createRedisStateService } from './services/redis.js';
import { createSlackService } from './services/slack.js';
import { runJob } from './job.js';

export const inngest = new Inngest({
  id: 'jirabot',
  signingKey: process.env['INNGEST_SIGNING_KEY'],
});

// ─── Existing: process a single assigned ticket ───────────────────────────────

export const processTicketJob = inngest.createFunction(
  {
    id: 'process-ticket',
    concurrency: { limit: 5 },
    retries: 3,
  },
  { event: 'jirabot/ticket.assigned' },
  async ({ event, step }) => {
    const payload = event.data as JobPayload;

    await step.run('process-ticket', async () => {
      const config = loadConfigFromEnv();

      const boardConfig = config.boards.find(
        (b) => b.jiraProject === payload.projectKey
      );

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
          slack: config.slack ? createSlackService(config.slack.botToken) : undefined,
        });
      } finally {
        await redis.quit();
      }
    });
  }
);

// ─── V2: Cron — scan Jira for unassigned tickets and self-assign ──────────────

const SCAN_CRON_SCHEDULE = process.env['SCAN_CRON_SCHEDULE'] ?? '*/5 * * * *';

export const scanAndAssignJob = inngest.createFunction(
  {
    id: 'scan-and-assign',
    concurrency: { limit: 1 },
    retries: 1,
  },
  { cron: SCAN_CRON_SCHEDULE },
  async ({ step }) => {
    await step.run('scan-and-assign', async () => {
      const config = loadConfigFromEnv();
      const boardsWithJql = config.boards.filter((b) => b.autoAssignJql);

      if (boardsWithJql.length === 0) return;

      const jira = createJiraService(config.jira);
      const redis = createRedisStateService(config.redisUrl);

      try {
        for (const board of boardsWithJql) {
          const tickets = await jira.searchTickets(board.autoAssignJql!, 20);

          for (const ticket of tickets) {
            // Guard against duplicate processing across concurrent instances
            const claimed = await redis.tryClaimTicket(ticket.key);
            if (!claimed) {
              console.log(`[scan] Ticket ${ticket.key} already claimed — skipping`);
              continue;
            }

            try {
              await jira.assignTicket(ticket.key, config.jira.agentAccountId);
              console.log(`[scan] Assigned ${ticket.key} to agent`);

              // Fire the existing process-ticket event
              await inngest.send({
                name: 'jirabot/ticket.assigned',
                data: {
                  ticketKey: ticket.key,
                  projectKey: ticket.projectKey,
                  jobId: crypto.randomUUID(),
                  timestamp: new Date().toISOString(),
                } satisfies JobPayload,
              });
            } catch (err) {
              // Release claim so it can be retried next scan cycle
              await redis.releaseTicketClaim(ticket.key);
              console.error(`[scan] Failed to assign ${ticket.key}:`, String(err));
            }
          }
        }
      } finally {
        await redis.quit();
      }
    });
  }
);

// ─── V2: Handle Slack command events ─────────────────────────────────────────

export const handleSlackCommandJob = inngest.createFunction(
  {
    id: 'handle-slack-command',
    retries: 2,
  },
  { event: 'jirabot/slack.command' },
  async ({ event, step }) => {
    const payload = event.data as SlackCommandPayload;

    await step.run('handle-slack-command', async () => {
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
        // action === 'unknown'
        await slack.postMessage(payload.channelId, intent.response);
      }
    });
  }
);

// ─── HTTP server ──────────────────────────────────────────────────────────────

export function createInngestServer(port = 3001): http.Server {
  const handler = serve({
    client: inngest,
    functions: [processTicketJob, scanAndAssignJob, handleSlackCommandJob],
  });

  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/api/inngest')) {
      return handler(req, res);
    }
    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(port, () => {
    console.log(`Inngest handler listening on port ${port}`);
  });

  return server;
}
