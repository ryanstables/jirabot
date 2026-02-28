import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { JiraTicket } from '@jirabot/shared';

const mockJira = {
  getTicket: vi.fn(),
  postComment: vi.fn().mockResolvedValue('comment1'),
  transitionTicket: vi.fn().mockResolvedValue(undefined),
};
const mockGithub = {
  createPR: vi.fn().mockResolvedValue({ prUrl: 'https://github.com/org/repo/pull/1', prNumber: 1 }),
};
const mockClaude = {
  checkSufficiency: vi.fn(),
  buildCodingPrompt: vi.fn().mockReturnValue('# Fix the bug'),
};
const mockGit = {
  cloneRepo: vi.fn().mockResolvedValue(undefined),
  createBranch: vi.fn().mockResolvedValue('agent/PROJ-1-fix'),
  commitAll: vi.fn().mockResolvedValue('abc1234'),
  push: vi.fn().mockResolvedValue(undefined),
  getChangedFiles: vi.fn().mockResolvedValue(['src/fix.ts']),
};
const mockExecutor = {
  run: vi.fn(),
};
const mockRedis = {
  setTicketState: vi.fn().mockResolvedValue(undefined),
  getTicketState: vi.fn().mockResolvedValue(null),
  recordAttempt: vi.fn().mockResolvedValue(undefined),
  getAttempts: vi.fn().mockResolvedValue([]),
  clearTicket: vi.fn().mockResolvedValue(undefined),
  quit: vi.fn().mockResolvedValue(undefined),
};

const baseTicket: JiraTicket = {
  key: 'PROJ-1',
  projectKey: 'PROJ',
  summary: 'Fix login bug',
  description: 'Users cannot log in',
  comments: [],
  attachments: [],
  labels: ['bug'],
  assigneeAccountId: 'agent123',
};

describe('JobOrchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis.getAttempts.mockResolvedValue([]);
    mockJira.postComment.mockResolvedValue('comment1');
    mockJira.transitionTicket.mockResolvedValue(undefined);
    mockGit.createBranch.mockResolvedValue('agent/PROJ-1-fix');
    mockGit.commitAll.mockResolvedValue('abc1234');
  });

  it('posts clarifying questions when ticket is insufficient', async () => {
    mockJira.getTicket.mockResolvedValue(baseTicket);
    mockClaude.checkSufficiency.mockResolvedValue({ sufficient: false, questions: ['What is the expected behavior?'] });

    const { runJob } = await import('../job.js');
    await runJob({
      ticketKey: 'PROJ-1',
      jobId: 'job-1',
      boardConfig: { jiraProject: 'PROJ', githubRepo: 'org/repo', defaultBranch: 'main', targetStatus: 'Ready for Review', escalationStatus: 'Needs Clarity' },
      services: { jira: mockJira as never, github: mockGithub as never, claude: mockClaude as never, git: mockGit as never, executor: mockExecutor as never, redis: mockRedis as never },
      maxAttempts: 3,
      workDirBase: '/tmp',
    });

    expect(mockJira.postComment).toHaveBeenCalledWith(
      'PROJ-1',
      expect.stringContaining('What is the expected behavior?')
    );
    expect(mockRedis.setTicketState).toHaveBeenCalledWith('PROJ-1', 'awaiting_info');
    expect(mockGit.cloneRepo).not.toHaveBeenCalled();
  });

  it('opens a PR on successful code generation', async () => {
    mockJira.getTicket.mockResolvedValue(baseTicket);
    mockClaude.checkSufficiency.mockResolvedValue({ sufficient: true, questions: [] });
    mockExecutor.run.mockResolvedValue({
      success: true,
      testsPass: true,
      stdout: 'All tests passed',
      stderr: '',
    });

    const { runJob } = await import('../job.js');
    await runJob({
      ticketKey: 'PROJ-1',
      jobId: 'job-2',
      boardConfig: { jiraProject: 'PROJ', githubRepo: 'org/repo', defaultBranch: 'main', targetStatus: 'Ready for Review', escalationStatus: 'Needs Clarity' },
      services: { jira: mockJira as never, github: mockGithub as never, claude: mockClaude as never, git: mockGit as never, executor: mockExecutor as never, redis: mockRedis as never },
      maxAttempts: 3,
      workDirBase: '/tmp',
    });

    expect(mockGithub.createPR).toHaveBeenCalled();
    expect(mockJira.transitionTicket).toHaveBeenCalledWith('PROJ-1', 'Ready for Review');
    expect(mockJira.postComment).toHaveBeenCalledWith('PROJ-1', expect.stringContaining('https://github.com'));
  });

  it('escalates after MAX_ATTEMPTS failures', async () => {
    mockJira.getTicket.mockResolvedValue(baseTicket);
    mockClaude.checkSufficiency.mockResolvedValue({ sufficient: true, questions: [] });
    mockExecutor.run.mockResolvedValue({
      success: false,
      testsPass: false,
      stdout: '',
      stderr: 'Tests failed',
      failureSummary: 'Tests failed: 3 failures',
    });

    const { runJob } = await import('../job.js');
    await runJob({
      ticketKey: 'PROJ-1',
      jobId: 'job-3',
      boardConfig: { jiraProject: 'PROJ', githubRepo: 'org/repo', defaultBranch: 'main', targetStatus: 'Ready for Review', escalationStatus: 'Needs Clarity' },
      services: { jira: mockJira as never, github: mockGithub as never, claude: mockClaude as never, git: mockGit as never, executor: mockExecutor as never, redis: mockRedis as never },
      maxAttempts: 2,
      workDirBase: '/tmp',
    });

    expect(mockExecutor.run).toHaveBeenCalledTimes(2);
    expect(mockJira.transitionTicket).toHaveBeenCalledWith('PROJ-1', 'Needs Clarity');
    expect(mockJira.postComment).toHaveBeenCalledWith('PROJ-1', expect.stringContaining('escalat'));
  });
});
