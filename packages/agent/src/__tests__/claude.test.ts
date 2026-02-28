import { describe, it, expect, vi } from 'vitest';

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      create: vi.fn().mockImplementation(({ messages }: { messages: Array<{content: string}> }) => {
        const content = messages[0]?.content ?? '';
        const isSufficient = content.includes('sufficient');
        return Promise.resolve({
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                isSufficient
                  ? { sufficient: true, questions: [] }
                  : { sufficient: false, questions: ['What is the expected behavior?', 'Which environment?'] }
              ),
            },
          ],
        });
      }),
    },
  })),
}));

describe('ClaudeService', () => {
  it('returns sufficient=true for a detailed ticket', async () => {
    const { createClaudeService } = await import('../services/claude.js');
    const svc = createClaudeService('sk-ant-test');
    const result = await svc.checkSufficiency({
      key: 'PROJ-1',
      projectKey: 'PROJ',
      summary: 'Fix login bug',
      description: 'Users cannot log in. sufficient details provided. Steps to reproduce: go to /login, enter credentials, click submit. Expected: dashboard. Actual: 500 error.',
      comments: [],
      attachments: [],
      labels: ['bug'],
      assigneeAccountId: 'agent',
    });
    expect(result.sufficient).toBe(true);
    expect(result.questions).toHaveLength(0);
  });

  it('returns questions for vague ticket', async () => {
    const { createClaudeService } = await import('../services/claude.js');
    const svc = createClaudeService('sk-ant-test');
    const result = await svc.checkSufficiency({
      key: 'PROJ-2',
      projectKey: 'PROJ',
      summary: 'Something is broken',
      description: 'It does not work',
      comments: [],
      attachments: [],
      labels: [],
      assigneeAccountId: 'agent',
    });
    expect(result.sufficient).toBe(false);
    expect(result.questions.length).toBeGreaterThan(0);
  });

  it('builds a coding prompt from ticket context', async () => {
    const { createClaudeService } = await import('../services/claude.js');
    const svc = createClaudeService('sk-ant-test');
    const prompt = svc.buildCodingPrompt({
      key: 'PROJ-1',
      projectKey: 'PROJ',
      summary: 'Fix login bug',
      description: 'Users cannot log in',
      comments: [{ id: '1', body: 'Reproduced on Safari', authorAccountId: 'user1', created: '2024-01-01' }],
      attachments: [],
      labels: ['bug'],
      assigneeAccountId: 'agent',
    });
    expect(prompt).toContain('PROJ-1');
    expect(prompt).toContain('Fix login bug');
    expect(prompt).toContain('Reproduced on Safari');
  });
});
