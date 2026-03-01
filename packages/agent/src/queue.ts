import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { JobPayload, SlackCommandPayload } from '@jirabot/shared';
import { processTicket, scanAndAssign, handleSlackCommand } from './inngest.js';

const SCAN_CRON_SCHEDULE = process.env['SCAN_CRON_SCHEDULE'] ?? '*/5 * * * *';

// Parse REDIS_URL into BullMQ connection options (BullMQ bundles its own ioredis)
function parseRedisUrl(url: string): ConnectionOptions {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
    ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
}

const connection = parseRedisUrl(process.env['REDIS_URL'] ?? 'redis://localhost:6379');

const ticketQueue = new Queue<JobPayload>('ticket-jobs', { connection });
const slackQueue = new Queue<SlackCommandPayload>('slack-jobs', { connection });
const cronQueue = new Queue('cron-jobs', { connection });

export async function addTicketJob(payload: JobPayload): Promise<void> {
  await ticketQueue.add('process-ticket', payload, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
  });
}

export async function addSlackJob(payload: SlackCommandPayload): Promise<void> {
  await slackQueue.add('handle-slack-command', payload, {
    attempts: 2,
    backoff: { type: 'exponential', delay: 1000 },
  });
}

export async function startWorkers(): Promise<void> {
  new Worker<JobPayload>(
    'ticket-jobs',
    async (job) => {
      await processTicket(job.data);
    },
    { connection, concurrency: 5 }
  );

  new Worker<SlackCommandPayload>(
    'slack-jobs',
    async (job) => {
      await handleSlackCommand(job.data);
    },
    { connection, concurrency: 5 }
  );

  new Worker(
    'cron-jobs',
    async () => {
      await scanAndAssign(addTicketJob);
    },
    { connection, concurrency: 1 }
  );

  // Register the repeating scan-and-assign cron job (idempotent across restarts)
  await cronQueue.add('scan-and-assign', {}, {
    repeat: { pattern: SCAN_CRON_SCHEDULE },
  });

  console.log(`[queue] Workers started. Scan cron: ${SCAN_CRON_SCHEDULE}`);
}
