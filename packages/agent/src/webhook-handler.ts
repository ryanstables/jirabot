import { Router } from 'express';
import * as crypto from 'node:crypto';
import type { JobPayload, SlackCommandPayload } from '@jirabot/shared';
import { addTicketJob, addSlackJob } from './queue.js';

interface JiraWebhookBody {
  webhookEvent: string;
  issue?: {
    key: string;
    fields?: {
      project?: { key: string };
      assignee?: { accountId: string };
    };
  };
}

export function createWebhookRouter(opts: {
  jiraWebhookSecret: string;
  jiraAgentAccountId: string;
  slackSigningSecret?: string;
}): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // Jira webhook — raw body needed for HMAC validation
  router.post('/webhook/jira', (req, res, next) => {
    let data = Buffer.alloc(0);
    req.on('data', (chunk: Buffer) => { data = Buffer.concat([data, chunk]); });
    req.on('end', () => { (req as typeof req & { rawBody: Buffer }).rawBody = data; next(); });
  }, async (req, res) => {
    try {
      const rawBody = (req as typeof req & { rawBody: Buffer }).rawBody;
      const signature = req.headers['x-hub-signature-256'] as string | undefined;

      if (!validateHmac(rawBody, signature, opts.jiraWebhookSecret)) {
        res.status(401).json({ error: 'Invalid signature' });
        return;
      }

      const body = JSON.parse(rawBody.toString('utf8')) as JiraWebhookBody;
      const partial = extractJobPayload(body, opts.jiraAgentAccountId);

      if (!partial) {
        res.status(200).json({ ignored: true });
        return;
      }

      const payload: JobPayload = {
        ...partial,
        jobId: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
      };

      await addTicketJob(payload);
      res.status(202).json({ queued: true });
    } catch (err) {
      console.error('[webhook/jira] Error:', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // Slack webhook — raw body needed for signature validation
  router.post('/webhook/slack', (req, res, next) => {
    let data = Buffer.alloc(0);
    req.on('data', (chunk: Buffer) => { data = Buffer.concat([data, chunk]); });
    req.on('end', () => { (req as typeof req & { rawBody: Buffer }).rawBody = data; next(); });
  }, async (req, res) => {
    try {
      const rawBody = (req as typeof req & { rawBody: Buffer }).rawBody;
      const bodyStr = rawBody.toString('utf8');
      const body = JSON.parse(bodyStr) as Record<string, unknown>;

      // Slack URL verification challenge (sent once on webhook setup)
      if (body['type'] === 'url_verification') {
        res.json({ challenge: body['challenge'] });
        return;
      }

      if (opts.slackSigningSecret) {
        const timestamp = req.headers['x-slack-request-timestamp'] as string;
        const slackSig = req.headers['x-slack-signature'] as string;
        if (!validateSlackSignature(bodyStr, timestamp, slackSig, opts.slackSigningSecret)) {
          res.status(401).json({ error: 'Invalid Slack signature' });
          return;
        }
      }

      const event = body['event'] as Record<string, unknown> | undefined;
      const payload: SlackCommandPayload = {
        text: (event?.['text'] ?? body['text'] ?? '') as string,
        channelId: (event?.['channel'] ?? body['channel_id'] ?? '') as string,
        slackUserId: (event?.['user'] ?? body['user_id'] ?? '') as string,
        responseUrl: (body['response_url'] ?? '') as string,
        timestamp: new Date().toISOString(),
      };

      await addSlackJob(payload);
      res.status(202).json({ queued: true });
    } catch (err) {
      console.error('[webhook/slack] Error:', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  return router;
}

function validateHmac(
  body: Buffer,
  signatureHeader: string | undefined,
  secret: string
): boolean {
  if (!signatureHeader) return false;

  const parts = signatureHeader.split('=');
  if (parts[0] !== 'sha256' || !parts[1]) return false;
  const provided = parts[1];

  const computed = crypto.createHmac('sha256', secret).update(body).digest('hex');
  if (provided.length !== computed.length) return false;

  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(computed));
}

function validateSlackSignature(
  rawBody: string,
  timestamp: string,
  signature: string,
  secret: string
): boolean {
  // Reject requests older than 5 minutes (replay attack protection)
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const sigBase = `v0:${timestamp}:${rawBody}`;
  const computed = 'v0=' + crypto.createHmac('sha256', secret).update(sigBase).digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(computed));
  } catch {
    return false;
  }
}

function extractJobPayload(
  body: JiraWebhookBody,
  agentAccountId: string
): Omit<JobPayload, 'jobId' | 'timestamp'> | null {
  if (body.webhookEvent !== 'jira:issue_assigned') return null;

  const issue = body.issue;
  if (!issue) return null;

  if (issue.fields?.assignee?.accountId !== agentAccountId) return null;

  const ticketKey = issue.key;
  const projectKey = issue.fields?.project?.key;
  if (!ticketKey || !projectKey) return null;

  return { ticketKey, projectKey };
}
