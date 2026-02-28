import { describe, it, expect, vi } from 'vitest';

// Helper: compute a valid Slack HMAC-SHA256 signature
async function computeSlackSig(secret: string, timestamp: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBase = `v0:${timestamp}:${body}`;
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(sigBase));
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `v0=${hex}`;
}

describe('validateSlackWebhook', () => {
  it('accepts a valid signature with a fresh timestamp', async () => {
    const { validateSlackWebhook } = await import('../slack.js');
    const secret = 'slack-signing-secret';
    const body = JSON.stringify({ type: 'event_callback' });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await computeSlackSig(secret, ts, body);

    const valid = await validateSlackWebhook(body, secret, sig, ts);
    expect(valid).toBe(true);
  });

  it('rejects a bad signature', async () => {
    const { validateSlackWebhook } = await import('../slack.js');
    const ts = String(Math.floor(Date.now() / 1000));
    const valid = await validateSlackWebhook('body', 'secret', 'v0=badhash', ts);
    expect(valid).toBe(false);
  });

  it('rejects an old timestamp (replay attack)', async () => {
    const { validateSlackWebhook } = await import('../slack.js');
    const secret = 'secret';
    const body = 'body';
    const oldTs = String(Math.floor(Date.now() / 1000) - 400); // 400s ago > 300s window
    const sig = await computeSlackSig(secret, oldTs, body);

    const valid = await validateSlackWebhook(body, secret, sig, oldTs);
    expect(valid).toBe(false);
  });

  it('rejects when signature or timestamp header is missing', async () => {
    const { validateSlackWebhook } = await import('../slack.js');
    expect(await validateSlackWebhook('body', 'secret', '', '123')).toBe(false);
    expect(await validateSlackWebhook('body', 'secret', 'v0=abc', '')).toBe(false);
  });
});

describe('extractSlackPayload', () => {
  it('extracts a user message event', async () => {
    const { extractSlackPayload } = await import('../slack.js');
    const body = {
      type: 'event_callback',
      event_time: 1700000000,
      event: {
        type: 'message',
        user: 'U123',
        text: 'create a ticket for dark mode',
        channel: 'D456',
      },
    };
    const payload = extractSlackPayload(body);
    expect(payload).not.toBeNull();
    expect(payload?.slackUserId).toBe('U123');
    expect(payload?.channelId).toBe('D456');
    expect(payload?.text).toBe('create a ticket for dark mode');
  });

  it('ignores bot messages', async () => {
    const { extractSlackPayload } = await import('../slack.js');
    const body = {
      type: 'event_callback',
      event: {
        type: 'message',
        bot_id: 'B999',
        text: 'bot message',
        channel: 'C123',
      },
    };
    expect(extractSlackPayload(body)).toBeNull();
  });

  it('ignores message_changed subtypes', async () => {
    const { extractSlackPayload } = await import('../slack.js');
    const body = {
      type: 'event_callback',
      event: {
        type: 'message',
        subtype: 'message_changed',
        user: 'U123',
        text: 'edited',
        channel: 'C123',
      },
    };
    expect(extractSlackPayload(body)).toBeNull();
  });

  it('returns null for non-event_callback type', async () => {
    const { extractSlackPayload } = await import('../slack.js');
    expect(extractSlackPayload({ type: 'url_verification', challenge: 'abc' })).toBeNull();
  });
});
