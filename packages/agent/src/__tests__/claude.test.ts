import { describe, it, expect, vi } from 'vitest';

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      create: vi.fn().mockImplementation(({ system, messages }: { system?: string; messages: Array<{content: string}> }) => {
        const content = messages[0]?.content ?? '';

        // Slack intent parsing: system prompt contains "Jira assistant"
        if (system?.includes('Jira assistant')) {
          if (content.toLowerCase().includes('create')) {
            return Promise.resolve({
              content: [{ type: 'text', text: JSON.stringify({ action: 'create_ticket', projectKey: 'PROJ', summary: 'Add dark mode', description: 'Users want a dark theme.' }) }],
            });
          }
          return Promise.resolve({
            content: [{ type: 'text', text: JSON.stringify({ action: 'unknown', response: 'I can help you create Jira tickets.' }) }],
          });
        }

        // Sufficiency check
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

  it('includes multi-repo layout section when repoPaths has multiple entries', async () => {
    const { createClaudeService } = await import('../services/claude.js');
    const svc = createClaudeService('sk-ant-test');
    const prompt = svc.buildCodingPrompt(
      {
        key: 'PROJ-2',
        projectKey: 'PROJ',
        summary: 'Coordinated change',
        description: 'Needs changes in two repos',
        comments: [],
        attachments: [],
        labels: ['multi-repo'],
        assigneeAccountId: 'agent',
      },
      ['repo-primary', 'repo-secondary-0']
    );
    expect(prompt).toContain('Repository Layout');
    expect(prompt).toContain('repo-primary');
    expect(prompt).toContain('repo-secondary-0');
  });

  it('does NOT include multi-repo section for single repo', async () => {
    const { createClaudeService } = await import('../services/claude.js');
    const svc = createClaudeService('sk-ant-test');
    const prompt = svc.buildCodingPrompt(
      {
        key: 'PROJ-3',
        projectKey: 'PROJ',
        summary: 'Single repo fix',
        description: null,
        comments: [],
        attachments: [],
        labels: [],
        assigneeAccountId: 'agent',
      },
      ['repo-primary']
    );
    expect(prompt).not.toContain('Repository Layout');
  });

  it('parses a create_ticket intent from Slack message', async () => {
    const { createClaudeService } = await import('../services/claude.js');
    const svc = createClaudeService('sk-ant-test');
    const intent = await svc.parseSlackIntent('create a ticket for dark mode', ['PROJ', 'OPS']);
    expect(intent.action).toBe('create_ticket');
    if (intent.action === 'create_ticket') {
      expect(intent.projectKey).toBe('PROJ');
      expect(intent.summary).toBeTruthy();
    }
  });

  it('returns unknown action for unrecognised Slack messages', async () => {
    const { createClaudeService } = await import('../services/claude.js');
    const svc = createClaudeService('sk-ant-test');
    const intent = await svc.parseSlackIntent('hello there', ['PROJ']);
    expect(intent.action).toBe('unknown');
    if (intent.action === 'unknown') {
      expect(intent.response).toBeTruthy();
    }
  });
});
