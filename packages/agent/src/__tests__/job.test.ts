import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { JiraTicket, BoardConfig } from '@jirabot/shared';

// Mock createGitService so job.ts can call it internally
const mockGit = {
  cloneRepo: vi.fn().mockResolvedValue(undefined),
  createBranch: vi.fn().mockResolvedValue('agent/PROJ-1-fix'),
  commitAll: vi.fn().mockResolvedValue('abc1234'),
  push: vi.fn().mockResolvedValue(undefined),
  getChangedFiles: vi.fn().mockResolvedValue(['src/fix.ts']),
};

vi.mock('../services/git.js', () => ({
  createGitService: vi.fn().mockReturnValue(mockGit),
}));

const mockJira = {
  getTicket: vi.fn(),
  postComment: vi.fn().mockResolvedValue('comment1'),
  transitionTicket: vi.fn().mockResolvedValue(undefined),
  searchTickets: vi.fn().mockResolvedValue([]),
  assignTicket: vi.fn().mockResolvedValue(undefined),
  createTicket: vi.fn().mockResolvedValue('PROJ-99'),
};
const mockGithub = {
  createPR: vi.fn().mockResolvedValue({ prUrl: 'https://github.com/org/repo/pull/1', prNumber: 1 }),
  getInstallationToken: vi.fn().mockResolvedValue('token'),
};
const mockClaude = {
  checkSufficiency: vi.fn(),
  buildCodingPrompt: vi.fn().mockReturnValue('# Fix the bug'),
  parseSlackIntent: vi.fn(),
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
  tryClaimTicket: vi.fn().mockResolvedValue(true),
  releaseTicketClaim: vi.fn().mockResolvedValue(undefined),
  quit: vi.fn().mockResolvedValue(undefined),
};
const mockSlack = {
  postMessage: vi.fn().mockResolvedValue(undefined),
  postRichMessage: vi.fn().mockResolvedValue(undefined),
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

const baseBoardConfig: BoardConfig = {
  jiraProject: 'PROJ',
  githubRepo: 'org/repo',
  defaultBranch: 'main',
  targetStatus: 'Ready for Review',
  escalationStatus: 'Needs Clarity',
  secondaryRepos: [],
  multiRepoLabel: 'multi-repo',
};

const baseServices = {
  jira: mockJira as never,
  github: mockGithub as never,
  claude: mockClaude as never,
  executor: mockExecutor as never,
  redis: mockRedis as never,
};

describe('JobOrchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis.getAttempts.mockResolvedValue([]);
    mockJira.postComment.mockResolvedValue('comment1');
    mockJira.transitionTicket.mockResolvedValue(undefined);
    mockGit.createBranch.mockResolvedValue('agent/PROJ-1-fix');
    mockGit.commitAll.mockResolvedValue('abc1234');
    mockGit.cloneRepo.mockResolvedValue(undefined);
    mockGit.push.mockResolvedValue(undefined);
    mockGit.getChangedFiles.mockResolvedValue(['src/fix.ts']);
    mockRedis.setTicketState.mockResolvedValue(undefined);
    mockRedis.recordAttempt.mockResolvedValue(undefined);
  });

  it('posts clarifying questions when ticket is insufficient', async () => {
    mockJira.getTicket.mockResolvedValue(baseTicket);
    mockClaude.checkSufficiency.mockResolvedValue({ sufficient: false, questions: ['What is the expected behavior?'] });

    const { runJob } = await import('../job.js');
    await runJob({
      ticketKey: 'PROJ-1',
      jobId: 'job-1',
      boardConfig: baseBoardConfig,
      services: baseServices,
      maxAttempts: 3,
      workDirBase: '/tmp',
      installationToken: 'test-token',
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
      boardConfig: baseBoardConfig,
      services: baseServices,
      maxAttempts: 3,
      workDirBase: '/tmp',
      installationToken: 'test-token',
    });

    expect(mockGithub.createPR).toHaveBeenCalledTimes(1);
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
      boardConfig: baseBoardConfig,
      services: baseServices,
      maxAttempts: 2,
      workDirBase: '/tmp',
      installationToken: 'test-token',
    });

    expect(mockExecutor.run).toHaveBeenCalledTimes(2);
    expect(mockJira.transitionTicket).toHaveBeenCalledWith('PROJ-1', 'Needs Clarity');
    expect(mockJira.postComment).toHaveBeenCalledWith('PROJ-1', expect.stringContaining('escalat'));
  });

  it('clones secondary repos and opens multiple PRs for multi-repo tickets', async () => {
    const multiRepoTicket: JiraTicket = {
      ...baseTicket,
      labels: ['bug', 'multi-repo'],
    };
    mockJira.getTicket.mockResolvedValue(multiRepoTicket);
    mockClaude.checkSufficiency.mockResolvedValue({ sufficient: true, questions: [] });
    mockExecutor.run.mockResolvedValue({ success: true, testsPass: true, stdout: '', stderr: '' });
    mockGithub.createPR
      .mockResolvedValueOnce({ prUrl: 'https://github.com/org/frontend/pull/1', prNumber: 1 })
      .mockResolvedValueOnce({ prUrl: 'https://github.com/org/backend/pull/2', prNumber: 2 });

    const multiRepoBoardConfig: BoardConfig = {
      ...baseBoardConfig,
      secondaryRepos: [{ githubRepo: 'org/backend', defaultBranch: 'main' }],
    };

    const { runJob } = await import('../job.js');
    await runJob({
      ticketKey: 'PROJ-1',
      jobId: 'job-4',
      boardConfig: multiRepoBoardConfig,
      services: baseServices,
      maxAttempts: 3,
      workDirBase: '/tmp',
      installationToken: 'test-token',
    });

    // Should clone both repos
    expect(mockGit.cloneRepo).toHaveBeenCalledTimes(2);
    // Should open PRs for both repos
    expect(mockGithub.createPR).toHaveBeenCalledTimes(2);
    // Jira comment should mention both PRs
    expect(mockJira.postComment).toHaveBeenCalledWith(
      'PROJ-1',
      expect.stringContaining('repositories')
    );
  });

  it('does NOT clone secondary repos when ticket lacks multi-repo label', async () => {
    mockJira.getTicket.mockResolvedValue(baseTicket); // labels: ['bug'] — no 'multi-repo'
    mockClaude.checkSufficiency.mockResolvedValue({ sufficient: true, questions: [] });
    mockExecutor.run.mockResolvedValue({ success: true, testsPass: true, stdout: '', stderr: '' });

    const boardConfigWithSecondary: BoardConfig = {
      ...baseBoardConfig,
      secondaryRepos: [{ githubRepo: 'org/backend', defaultBranch: 'main' }],
    };

    const { runJob } = await import('../job.js');
    await runJob({
      ticketKey: 'PROJ-1',
      jobId: 'job-5',
      boardConfig: boardConfigWithSecondary,
      services: baseServices,
      maxAttempts: 3,
      workDirBase: '/tmp',
      installationToken: 'test-token',
    });

    expect(mockGit.cloneRepo).toHaveBeenCalledTimes(1);
    expect(mockGithub.createPR).toHaveBeenCalledTimes(1);
  });

  it('posts Slack notifications on key events', async () => {
    mockJira.getTicket.mockResolvedValue(baseTicket);
    mockClaude.checkSufficiency.mockResolvedValue({ sufficient: true, questions: [] });
    mockExecutor.run.mockResolvedValue({ success: true, testsPass: true, stdout: '', stderr: '' });

    const boardWithSlack: BoardConfig = { ...baseBoardConfig, slackChannel: 'C123' };

    const { runJob } = await import('../job.js');
    await runJob({
      ticketKey: 'PROJ-1',
      jobId: 'job-6',
      boardConfig: boardWithSlack,
      services: baseServices,
      maxAttempts: 3,
      workDirBase: '/tmp',
      installationToken: 'test-token',
      slack: mockSlack as never,
    });

    expect(mockSlack.postMessage).toHaveBeenCalledWith('C123', expect.stringContaining('PROJ-1'));
  });
});
