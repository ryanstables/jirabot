import { describe, it, expect } from 'vitest';

// HMAC verification helper (browser crypto API subset available in Workers)
async function computeHmac(secret: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

describe('validateJiraWebhook', () => {
  it('accepts a valid HMAC signature', async () => {
    const { validateJiraWebhook } = await import('../webhook.js');
    const secret = 'test-secret';
    const body = JSON.stringify({ webhookEvent: 'jira:issue_assigned' });
    const signature = await computeHmac(secret, body);

    const valid = await validateJiraWebhook(body, `sha256=${signature}`, secret);
    expect(valid).toBe(true);
  });

  it('rejects an invalid signature', async () => {
    const { validateJiraWebhook } = await import('../webhook.js');
    const valid = await validateJiraWebhook('body', 'sha256=badhash', 'secret');
    expect(valid).toBe(false);
  });

  it('rejects a missing signature header', async () => {
    const { validateJiraWebhook } = await import('../webhook.js');
    const valid = await validateJiraWebhook('body', '', 'secret');
    expect(valid).toBe(false);
  });
});

describe('extractJobPayload', () => {
  it('extracts ticketKey and projectKey from assignment event', async () => {
    const { extractJobPayload } = await import('../webhook.js');
    const body = JSON.stringify({
      webhookEvent: 'jira:issue_assigned',
      issue: {
        key: 'PROJ-42',
        fields: {
          project: { key: 'PROJ' },
          assignee: { accountId: 'agent123' },
        },
      },
    });
    const payload = extractJobPayload(body, 'agent123');
    expect(payload).not.toBeNull();
    expect(payload?.ticketKey).toBe('PROJ-42');
    expect(payload?.projectKey).toBe('PROJ');
  });

  it('returns null if assignee is not the agent user', async () => {
    const { extractJobPayload } = await import('../webhook.js');
    const body = JSON.stringify({
      webhookEvent: 'jira:issue_assigned',
      issue: {
        key: 'PROJ-42',
        fields: {
          project: { key: 'PROJ' },
          assignee: { accountId: 'human-user' },
        },
      },
    });
    const payload = extractJobPayload(body, 'agent123');
    expect(payload).toBeNull();
  });
});
