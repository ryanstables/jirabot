import { WebClient } from '@slack/web-api';

export interface SlackService {
  postMessage(channelId: string, text: string): Promise<void>;
  postRichMessage(channelId: string, blocks: unknown[]): Promise<void>;
}

export function createSlackService(token: string): SlackService {
  const client = new WebClient(token);

  return {
    async postMessage(channelId, text) {
      try {
        await client.chat.postMessage({ channel: channelId, text });
      } catch (err) {
        throw new Error(`Failed to post Slack message to ${channelId}: ${String(err)}`);
      }
    },

    async postRichMessage(channelId, blocks) {
      try {
        await client.chat.postMessage({
          channel: channelId,
          blocks: blocks as Parameters<typeof client.chat.postMessage>[0]['blocks'],
        });
      } catch (err) {
        throw new Error(`Failed to post Slack rich message to ${channelId}: ${String(err)}`);
      }
    },
  };
}
