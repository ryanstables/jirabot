import Redis from 'ioredis';
import type { TicketState, AttemptRecord } from '@jirabot/shared';

export interface RedisStateService {
  setTicketState(ticketKey: string, state: TicketState): Promise<void>;
  getTicketState(ticketKey: string): Promise<TicketState | null>;
  recordAttempt(ticketKey: string, record: AttemptRecord): Promise<void>;
  getAttempts(ticketKey: string): Promise<AttemptRecord[]>;
  clearTicket(ticketKey: string): Promise<void>;
  quit(): Promise<void>;
}

const STATE_PREFIX = 'ticket:state:';
const ATTEMPTS_PREFIX = 'ticket:attempts:';

export function createRedisStateService(redisUrl: string): RedisStateService {
  const client = new Redis(redisUrl);

  return {
    async setTicketState(ticketKey, state) {
      await client.set(`${STATE_PREFIX}${ticketKey}`, state);
    },

    async getTicketState(ticketKey) {
      const value = await client.get(`${STATE_PREFIX}${ticketKey}`);
      return value as TicketState | null;
    },

    async recordAttempt(ticketKey, record) {
      await client.rpush(
        `${ATTEMPTS_PREFIX}${ticketKey}`,
        JSON.stringify(record)
      );
    },

    async getAttempts(ticketKey) {
      const items = await client.lrange(`${ATTEMPTS_PREFIX}${ticketKey}`, 0, -1);
      return items.map((item) => JSON.parse(item) as AttemptRecord);
    },

    async clearTicket(ticketKey) {
      await client.del(`${STATE_PREFIX}${ticketKey}`);
      await client.del(`${ATTEMPTS_PREFIX}${ticketKey}`);
    },

    async quit() {
      await client.quit();
    },
  };
}
