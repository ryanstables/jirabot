import express from 'express';
import path from 'path';
import { createWebhookRouter } from './webhook-handler.js';
import { startWorkers } from './queue.js';
import { loadConfigFromEnv } from '@jirabot/shared';
import { createSetupRouter } from './setup-wizard.js';

const PORT = Number(process.env['PORT'] ?? '3001');

async function main() {
  const app = express();

  // Setup wizard — always available at /setup
  const rootDir = path.resolve(import.meta.dirname, '../../..');
  app.use('/setup', createSetupRouter(rootDir));

  // Try to start the full agent. If config is missing, serve only the wizard.
  try {
    const config = loadConfigFromEnv();

    const webhookOpts = {
      jiraWebhookSecret: config.jira.webhookSecret,
      jiraAgentAccountId: config.jira.agentAccountId,
      ...(config.slack ? { slackSigningSecret: config.slack.signingSecret } : {}),
    };

    app.use('/', createWebhookRouter(webhookOpts));
    await startWorkers();
    console.log('JiraBot ready.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[startup] Configuration incomplete:', msg);
    console.warn('[startup] Open http://localhost:' + PORT + '/setup to complete setup.');

    app.get('/health', (_req, res) => res.json({ status: 'setup_required' }));
    app.get('/', (_req, res) => res.redirect('/setup'));
  }

  const server = app.listen(PORT, () => {
    console.log('JiraBot listening on port ' + PORT);
  });

  process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    server.close(() => { process.exit(0); });
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

