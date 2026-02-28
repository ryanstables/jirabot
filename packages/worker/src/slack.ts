import type { SlackCommandPayload } from '@jirabot/shared';

interface SlackEventBody {
  type: string;
  challenge?: string;
  event?: {
    type: string;
    subtype?: string;
    user?: string;
    text?: string;
    channel?: string;
    bot_id?: string;
    ts?: string;
  };
  event_time?: number;
}

/**
 * Validates a Slack Events API request signature.
 * Slack signs requests with HMAC-SHA256 over `v0:{timestamp}:{rawBody}`.
 * Rejects requests older than 5 minutes to prevent replay attacks.
 */
export async function validateSlackWebhook(
  rawBody: string,
  signingSecret: string,
  signatureHeader: string,
  timestampHeader: string
): Promise<boolean> {
  if (!signatureHeader || !timestampHeader) return false;

  const timestamp = parseInt(timestampHeader, 10);
  if (isNaN(timestamp)) return false;

  // Reject events older than 5 minutes
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > 300) return false;

  const sigBase = `v0:${timestampHeader}:${rawBody}`;
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(signingSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const sigBytes = await crypto.subtle.sign('HMAC', key, encoder.encode(sigBase));
  const computedHex = Array.from(new Uint8Array(sigBytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const expected = `v0=${computedHex}`;

  // Constant-time comparison
  if (expected.length !== signatureHeader.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Extracts a SlackCommandPayload from a parsed Slack Events API body.
 * Returns null for non-message events, bot messages, or URL verification challenges
 * (the caller handles the challenge response separately).
 */
export function extractSlackPayload(body: unknown): SlackCommandPayload | null {
  if (typeof body !== 'object' || body === null) return null;

  const raw = body as SlackEventBody;

  // Only handle message events from real users
  if (raw.type !== 'event_callback') return null;

  const ev = raw.event;
  if (!ev || ev.type !== 'message') return null;

  // Ignore bot messages and message-change/delete subtypes
  if (ev.subtype ?? ev.bot_id) return null;

  if (!ev.user || !ev.text || !ev.channel) return null;

  return {
    slackUserId: ev.user,
    channelId: ev.channel,
    text: ev.text,
    responseUrl: '',
    timestamp: String(raw.event_time ?? Math.floor(Date.now() / 1000)),
  };
}
