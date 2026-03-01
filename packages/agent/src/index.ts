import express from 'express';
import { createWebhookRouter } from './webhook-handler.js';
import { startWorkers } from './queue.js';

const PORT = Number(process.env['PORT'] ?? '3001');

async function main() {
  const app = express();

  const webhookOpts = {
    jiraWebhookSecret: process.env['JIRA_WEBHOOK_SECRET'] ?? '',
    jiraAgentAccountId: process.env['JIRA_AGENT_ACCOUNT_ID'] ?? '',
    ...(process.env['SLACK_SIGNING_SECRET']
      ? { slackSigningSecret: process.env['SLACK_SIGNING_SECRET'] }
      : {}),
  };

  app.use('/', createWebhookRouter(webhookOpts));

  await startWorkers();

  const server = app.listen(PORT, () => {
    console.log(`JiraBot listening on port ${PORT}`);
  });

  process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
