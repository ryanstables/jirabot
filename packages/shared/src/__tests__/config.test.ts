import { describe, it, expect } from 'vitest';
import { AgentConfigSchema, parseConfig } from '../config.js';

describe('AgentConfigSchema', () => {
  it('validates a complete valid config', () => {
    const raw = {
      jira: {
        host: 'org.atlassian.net',
        agentEmail: 'agent@org.com',
        apiToken: 'token123',
        agentAccountId: 'abc123',
        webhookSecret: 'secret',
      },
      github: {
        appId: 1,
        privateKey: '-----BEGIN RSA PRIVATE KEY-----',
        installationId: 2,
      },
      boards: [
        {
          jiraProject: 'PROJ',
          githubRepo: 'org/repo',
          defaultBranch: 'main',
          targetStatus: 'Ready for Review',
          escalationStatus: 'Needs Clarity',
        },
      ],
      codingAgent: 'claude-code' as const,
      maxAttempts: 3,
      anthropicApiKey: 'sk-ant-xxx',
      redisUrl: 'redis://localhost:6379',
    };

    const result = parseConfig(raw);
    expect(result.maxAttempts).toBe(3);
    expect(result.boards[0]?.jiraProject).toBe('PROJ');
  });

  it('rejects config missing required fields', () => {
    expect(() => parseConfig({})).toThrow();
  });

  it('defaults maxAttempts to 3', () => {
    const raw = {
      jira: { host: 'h', agentEmail: 'e@e.com', apiToken: 't', agentAccountId: 'a', webhookSecret: 'w' },
      github: { appId: 1, privateKey: 'k', installationId: 1 },
      boards: [{ jiraProject: 'P', githubRepo: 'o/r', defaultBranch: 'main', targetStatus: 'R', escalationStatus: 'E' }],
      codingAgent: 'claude-code' as const,
      anthropicApiKey: 'sk',
      redisUrl: 'redis://x',
    };
    const result = parseConfig(raw);
    expect(result.maxAttempts).toBe(3);
  });
});
