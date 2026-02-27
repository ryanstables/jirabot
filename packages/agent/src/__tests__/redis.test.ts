import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TicketState } from '@jirabot/shared';

// Mock ioredis
vi.mock('ioredis', () => {
  const store = new Map<string, string>();
  const MockRedis = vi.fn().mockImplementation(() => ({
    set: vi.fn((key: string, value: string) => { store.set(key, value); return Promise.resolve('OK'); }),
    get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    del: vi.fn((key: string) => { store.delete(key); return Promise.resolve(1); }),
    rpush: vi.fn((key: string, ...values: string[]) => {
      const existing = JSON.parse(store.get(key) ?? '[]') as unknown[];
      values.forEach(v => existing.push(JSON.parse(v)));
      store.set(key, JSON.stringify(existing));
      return Promise.resolve(existing.length);
    }),
    lrange: vi.fn((key: string) => {
      const arr = JSON.parse(store.get(key) ?? '[]') as unknown[];
      return Promise.resolve(arr.map((v) => JSON.stringify(v)));
    }),
    quit: vi.fn(() => Promise.resolve('OK')),
  }));
  return { default: MockRedis };
});

describe('RedisStateService', () => {
  let service: Awaited<ReturnType<typeof import('../services/redis.js').createRedisStateService>>;

  beforeEach(async () => {
    const { createRedisStateService } = await import('../services/redis.js');
    service = createRedisStateService('redis://localhost:6379');
  });

  it('sets and gets ticket state', async () => {
    await service.setTicketState('PROJ-1', 'diagnosing');
    const state = await service.getTicketState('PROJ-1');
    expect(state).toBe('diagnosing');
  });

  it('returns null for unknown ticket', async () => {
    const state = await service.getTicketState('UNKNOWN-99');
    expect(state).toBeNull();
  });

  it('records and retrieves attempt summaries', async () => {
    await service.recordAttempt('PROJ-1', { attempt: 1, failureSummary: 'Tests failed', filesChanged: ['src/foo.ts'], timestamp: '2024-01-01' });
    const attempts = await service.getAttempts('PROJ-1');
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.attempt).toBe(1);
  });

  it('clears ticket state', async () => {
    await service.setTicketState('PROJ-2', 'coding');
    await service.clearTicket('PROJ-2');
    const state = await service.getTicketState('PROJ-2');
    expect(state).toBeNull();
  });
});
