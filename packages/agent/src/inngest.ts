import { Inngest } from 'inngest';
import { serve } from 'inngest/node';
import * as http from 'node:http';
import type { JobPayload } from '@jirabot/shared';
import { loadConfigFromEnv } from '@jirabot/shared';
import { createJiraService } from './services/jira.js';
import { createGitHubService } from './services/github.js';
import { createClaudeService } from './services/claude.js';
import { createGitService } from './services/git.js';
import { createCodeExecutor } from './services/code-executor.js';
import { createRedisStateService } from './services/redis.js';
import { runJob } from './job.js';

export const inngest = new Inngest({
  id: 'jirabot',
  signingKey: process.env['INNGEST_SIGNING_KEY'],
});

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
            git: createGitService(installationToken),
            executor: createCodeExecutor({ maxTimeoutMs: 30 * 60 * 1000 }), // 30 min
            redis,
          },
          maxAttempts: config.maxAttempts,
          workDirBase: '/tmp',
        });
      } finally {
        await redis.quit();
      }
    });
  }
);

export function createInngestServer(port = 3001): http.Server {
  const handler = serve({
    client: inngest,
    functions: [processTicketJob],
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
