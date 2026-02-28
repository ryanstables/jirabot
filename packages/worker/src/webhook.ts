import type { JobPayload } from '@jirabot/shared';

export async function validateJiraWebhook(
  body: string,
  signatureHeader: string,
  secret: string
): Promise<boolean> {
  if (!signatureHeader) return false;

  const parts = signatureHeader.split('=');
  const algorithm = parts[0];
  const providedHex = parts[1];
  if (algorithm !== 'sha256' || !providedHex) return false;

  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const sigBytes = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  const computedHex = Array.from(new Uint8Array(sigBytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // Constant-time comparison to prevent timing attacks
  if (computedHex.length !== providedHex.length) return false;

  let mismatch = 0;
  for (let i = 0; i < computedHex.length; i++) {
    mismatch |= computedHex.charCodeAt(i) ^ (providedHex.charCodeAt(i) ?? 0);
  }
  return mismatch === 0;
}

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

export function extractJobPayload(
  body: string,
  agentAccountId: string
): Omit<JobPayload, 'timestamp' | 'jobId'> | null {
  let parsed: JiraWebhookBody;
  try {
    parsed = JSON.parse(body) as JiraWebhookBody;
  } catch {
    return null;
  }

  if (parsed.webhookEvent !== 'jira:issue_assigned') return null;

  const issue = parsed.issue;
  if (!issue) return null;

  const assigneeId = issue.fields?.assignee?.accountId;
  if (assigneeId !== agentAccountId) return null;

  const ticketKey = issue.key;
  const projectKey = issue.fields?.project?.key;

  if (!ticketKey || !projectKey) return null;

  return { ticketKey, projectKey };
}
