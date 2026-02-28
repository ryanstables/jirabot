import { Redis } from 'ioredis';
import type { TicketState, AttemptRecord } from '@jirabot/shared';

export interface RedisStateService {
  setTicketState(ticketKey: string, state: TicketState): Promise<void>;
  getTicketState(ticketKey: string): Promise<TicketState | null>;
  recordAttempt(ticketKey: string, record: AttemptRecord): Promise<void>;
  getAttempts(ticketKey: string): Promise<AttemptRecord[]>;
  clearTicket(ticketKey: string): Promise<void>;
  // V2: self-assignment race-condition guard
  tryClaimTicket(ticketKey: string): Promise<boolean>;
  releaseTicketClaim(ticketKey: string): Promise<void>;
  quit(): Promise<void>;
}

const STATE_PREFIX = 'ticket:state:';
const ATTEMPTS_PREFIX = 'ticket:attempts:';
const CLAIM_PREFIX = 'ticket:claimed:';

const VALID_STATES: ReadonlySet<string> = new Set<TicketState>([
  'awaiting_info', 'diagnosing', 'coding', 'pr_opened', 'escalated',
]);

export function createRedisStateService(redisUrl: string): RedisStateService {
  const client = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
  });
  client.on('error', (err: Error) => {
    console.error('[redis] connection error', err.message);
  });

  return {
    async setTicketState(ticketKey, state) {
      await client.set(`${STATE_PREFIX}${ticketKey}`, state, 'EX', 30 * 24 * 60 * 60);
    },

    async getTicketState(ticketKey) {
      const value = await client.get(`${STATE_PREFIX}${ticketKey}`);
      if (value === null) return null;
      if (!VALID_STATES.has(value)) {
        throw new Error(`Invalid TicketState stored for ${ticketKey}: "${value}"`);
      }
      return value as TicketState;
    },

    async recordAttempt(ticketKey, record) {
      await client.rpush(
        `${ATTEMPTS_PREFIX}${ticketKey}`,
        JSON.stringify(record)
      );
    },

    async getAttempts(ticketKey) {
      const items = await client.lrange(`${ATTEMPTS_PREFIX}${ticketKey}`, 0, -1);
      return items.map((item: string) => JSON.parse(item) as AttemptRecord);
    },

    async clearTicket(ticketKey) {
      await client.del(
        `${STATE_PREFIX}${ticketKey}`,
        `${ATTEMPTS_PREFIX}${ticketKey}`,
      );
    },

    async tryClaimTicket(ticketKey) {
      // SET NX with 1h TTL — returns 'OK' if set, null if already exists
      const result = await client.set(`${CLAIM_PREFIX}${ticketKey}`, '1', 'EX', 3600, 'NX');
      return result === 'OK';
    },

    async releaseTicketClaim(ticketKey) {
      await client.del(`${CLAIM_PREFIX}${ticketKey}`);
    },

    async quit() {
      await client.quit();
    },
  };
}
