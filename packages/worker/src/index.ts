import { validateJiraWebhook, extractJobPayload } from './webhook.js';

interface Env {
  JIRA_WEBHOOK_SECRET: string;
  JIRA_AGENT_ACCOUNT_ID: string;
  INNGEST_EVENT_KEY: string;
  INNGEST_BASE_URL?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const body = await request.text();
    const signature = request.headers.get('x-hub-signature-256') ?? '';

    // 1. Validate webhook signature
    const isValid = await validateJiraWebhook(body, signature, env.JIRA_WEBHOOK_SECRET);
    if (!isValid) {
      console.warn('Invalid webhook signature');
      return new Response('Unauthorized', { status: 401 });
    }

    // 2. Extract and verify payload
    const partialPayload = extractJobPayload(body, env.JIRA_AGENT_ACCOUNT_ID);
    if (!partialPayload) {
      // Not an event we care about — ack and move on
      return new Response('OK', { status: 200 });
    }

    const payload = {
      ...partialPayload,
      jobId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
    };

    // 3. Enqueue job via Inngest
    const inngestUrl = env.INNGEST_BASE_URL ?? 'https://inn.gs';
    try {
      const inngestResponse = await fetch(`${inngestUrl}/e/${env.INNGEST_EVENT_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'jirabot/ticket.assigned',
          data: payload,
        }),
      });

      if (!inngestResponse.ok) {
        const error = await inngestResponse.text();
        console.error('Failed to enqueue job:', error);
      }
    } catch (err) {
      console.error('Failed to reach Inngest:', String(err));
    }

    // Always return 200 so Jira doesn't retry — retry happens at queue level
    console.log(`Enqueued job ${payload.jobId} for ticket ${payload.ticketKey}`);
    return new Response('OK', { status: 200 });
  },
};
