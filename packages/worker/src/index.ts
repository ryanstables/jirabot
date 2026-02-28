import { validateJiraWebhook, extractJobPayload } from './webhook.js';
import { validateSlackWebhook, extractSlackPayload } from './slack.js';

interface Env {
  JIRA_WEBHOOK_SECRET: string;
  JIRA_AGENT_ACCOUNT_ID: string;
  INNGEST_EVENT_KEY: string;
  INNGEST_BASE_URL?: string;
  SLACK_SIGNING_SECRET?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const url = new URL(request.url);

    if (url.pathname === '/webhook/slack') {
      return handleSlackWebhook(request, env);
    }

    // Default: Jira webhook (handles both /webhook/jira and legacy bare path)
    return handleJiraWebhook(request, env);
  },
};

async function handleJiraWebhook(request: Request, env: Env): Promise<Response> {
  const body = await request.text();
  const signature = request.headers.get('x-hub-signature-256') ?? '';

  const isValid = await validateJiraWebhook(body, signature, env.JIRA_WEBHOOK_SECRET);
  if (!isValid) {
    console.warn('Invalid Jira webhook signature');
    return new Response('Unauthorized', { status: 401 });
  }

  const partialPayload = extractJobPayload(body, env.JIRA_AGENT_ACCOUNT_ID);
  if (!partialPayload) {
    return new Response('OK', { status: 200 });
  }

  const payload = {
    ...partialPayload,
    jobId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
  };

  const inngestUrl = env.INNGEST_BASE_URL ?? 'https://inn.gs';
  try {
    const inngestResponse = await fetch(`${inngestUrl}/e/${env.INNGEST_EVENT_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'jirabot/ticket.assigned', data: payload }),
    });

    if (!inngestResponse.ok) {
      const error = await inngestResponse.text();
      console.error('Failed to enqueue Jira job:', error);
    }
  } catch (err) {
    console.error('Failed to reach Inngest:', String(err));
  }

  console.log(`Enqueued job ${payload.jobId} for ticket ${payload.ticketKey}`);
  return new Response('OK', { status: 200 });
}

async function handleSlackWebhook(request: Request, env: Env): Promise<Response> {
  if (!env.SLACK_SIGNING_SECRET) {
    console.warn('SLACK_SIGNING_SECRET not configured');
    return new Response('Not configured', { status: 503 });
  }

  const body = await request.text();
  const signature = request.headers.get('x-slack-signature') ?? '';
  const timestamp = request.headers.get('x-slack-request-timestamp') ?? '';

  const isValid = await validateSlackWebhook(body, env.SLACK_SIGNING_SECRET, signature, timestamp);
  if (!isValid) {
    console.warn('Invalid Slack webhook signature');
    return new Response('Unauthorized', { status: 401 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return new Response('Bad request', { status: 400 });
  }

  // Handle Slack's URL verification challenge (initial bot setup)
  if (typeof parsed === 'object' && parsed !== null) {
    const raw = parsed as Record<string, unknown>;
    if (raw['type'] === 'url_verification') {
      return new Response(JSON.stringify({ challenge: raw['challenge'] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  const payload = extractSlackPayload(parsed);
  if (!payload) {
    // Non-message event (reactions, edits, bot messages, etc.) — ack and ignore
    return new Response('OK', { status: 200 });
  }

  // Enqueue to Inngest for async processing (must respond within Slack's 3s window)
  const inngestUrl = env.INNGEST_BASE_URL ?? 'https://inn.gs';
  try {
    const inngestResponse = await fetch(`${inngestUrl}/e/${env.INNGEST_EVENT_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'jirabot/slack.command', data: payload }),
    });

    if (!inngestResponse.ok) {
      const error = await inngestResponse.text();
      console.error('Failed to enqueue Slack command:', error);
    }
  } catch (err) {
    console.error('Failed to reach Inngest:', String(err));
  }

  return new Response('OK', { status: 200 });
}
