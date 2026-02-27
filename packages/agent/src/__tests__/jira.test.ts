import { describe, it, expect, vi } from 'vitest';

vi.mock('jira.js', () => {
  return {
    Version3Client: vi.fn().mockImplementation(() => ({
      issues: {
        getIssue: vi.fn().mockResolvedValue({
          key: 'PROJ-1',
          fields: {
            summary: 'Fix login bug',
            description: {
              type: 'doc',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Users cannot log in' }] }],
            },
            comment: {
              comments: [
                { id: '1', body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Reproduced on Safari' }] }] }, author: { accountId: 'user1' }, created: '2024-01-01' },
              ],
            },
            attachment: [],
            labels: ['bug'],
            assignee: { accountId: 'agent123' },
            project: { key: 'PROJ' },
          },
        }),
        doTransition: vi.fn().mockResolvedValue({}),
        getTransitions: vi.fn().mockResolvedValue({
          transitions: [
            { id: '10', name: 'Ready for Review' },
            { id: '11', name: 'Needs Clarity' },
          ],
        }),
      },
      issueComments: {
        addComment: vi.fn().mockResolvedValue({ id: 'comment1' }),
      },
    })),
  };
});

describe('JiraService', () => {
  it('fetches and normalizes a ticket', async () => {
    const { createJiraService } = await import('../services/jira.js');
    const svc = createJiraService({ host: 'org.atlassian.net', agentEmail: 'a@b.com', apiToken: 'tok', agentAccountId: 'agent123', webhookSecret: 's' });
    const ticket = await svc.getTicket('PROJ-1');
    expect(ticket.key).toBe('PROJ-1');
    expect(ticket.summary).toBe('Fix login bug');
    expect(ticket.comments).toHaveLength(1);
    expect(ticket.comments[0]?.body).toBe('Reproduced on Safari');
  });

  it('posts a comment', async () => {
    const { createJiraService } = await import('../services/jira.js');
    const svc = createJiraService({ host: 'org.atlassian.net', agentEmail: 'a@b.com', apiToken: 'tok', agentAccountId: 'agent123', webhookSecret: 's' });
    const id = await svc.postComment('PROJ-1', 'This is a comment');
    expect(id).toBe('comment1');
  });

  it('transitions a ticket to a named status', async () => {
    const { createJiraService } = await import('../services/jira.js');
    const svc = createJiraService({ host: 'org.atlassian.net', agentEmail: 'a@b.com', apiToken: 'tok', agentAccountId: 'agent123', webhookSecret: 's' });
    await expect(svc.transitionTicket('PROJ-1', 'Ready for Review')).resolves.not.toThrow();
  });

  it('throws if transition name not found', async () => {
    const { createJiraService } = await import('../services/jira.js');
    const svc = createJiraService({ host: 'org.atlassian.net', agentEmail: 'a@b.com', apiToken: 'tok', agentAccountId: 'agent123', webhookSecret: 's' });
    await expect(svc.transitionTicket('PROJ-1', 'Nonexistent Status')).rejects.toThrow('Transition not found');
  });
});
