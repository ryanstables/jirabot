import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPostMessage = vi.fn().mockResolvedValue({ ok: true });

vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn().mockImplementation(() => ({
    chat: {
      postMessage: mockPostMessage,
    },
  })),
}));

describe('SlackService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPostMessage.mockResolvedValue({ ok: true });
  });

  it('posts a plain text message', async () => {
    const { createSlackService } = await import('../services/slack.js');
    const svc = createSlackService('xoxb-test-token');
    await svc.postMessage('C123', 'Hello world');
    expect(mockPostMessage).toHaveBeenCalledWith({ channel: 'C123', text: 'Hello world' });
  });

  it('posts a rich message with blocks', async () => {
    const { createSlackService } = await import('../services/slack.js');
    const svc = createSlackService('xoxb-test-token');
    const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: '*Hello*' } }];
    await svc.postRichMessage('C456', blocks);
    expect(mockPostMessage).toHaveBeenCalledWith({
      channel: 'C456',
      blocks,
    });
  });

  it('throws a descriptive error when the API call fails', async () => {
    mockPostMessage.mockRejectedValue(new Error('rate_limited'));
    const { createSlackService } = await import('../services/slack.js');
    const svc = createSlackService('xoxb-test-token');
    await expect(svc.postMessage('C123', 'Hello')).rejects.toThrow(
      'Failed to post Slack message to C123'
    );
  });
});
