import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGit = {
  clone: vi.fn().mockResolvedValue(undefined),
  checkoutLocalBranch: vi.fn().mockResolvedValue(undefined),
  add: vi.fn().mockResolvedValue(undefined),
  commit: vi.fn().mockResolvedValue({ commit: 'abc1234' }),
  push: vi.fn().mockResolvedValue(undefined),
  revparse: vi.fn().mockResolvedValue('abc1234\n'),
  status: vi.fn().mockResolvedValue({ files: [{ path: 'src/fix.ts' }] }),
};

vi.mock('simple-git', () => ({
  simpleGit: vi.fn().mockReturnValue(mockGit),
  default: { simpleGit: vi.fn().mockReturnValue(mockGit) },
}));

describe('GitService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGit.commit.mockResolvedValue({ commit: 'abc1234' });
    mockGit.revparse.mockResolvedValue('abc1234\n');
    mockGit.status.mockResolvedValue({ files: [{ path: 'src/fix.ts' }] });
  });

  it('clones repo to working directory', async () => {
    const { createGitService } = await import('../services/git.js');
    const svc = createGitService('https://x-access-token:token@github.com');
    await svc.cloneRepo('org/repo', '/tmp/job-1', 'main');
    expect(mockGit.clone).toHaveBeenCalledWith(
      'https://x-access-token:token@github.com/org/repo.git',
      '/tmp/job-1',
      ['--branch', 'main', '--depth', '1']
    );
  });

  it('creates a branch with correct naming convention', async () => {
    const { createGitService } = await import('../services/git.js');
    const svc = createGitService('token');
    await svc.createBranch('/tmp/job-1', 'PROJ-1', 'Fix login bug with spaces');
    expect(mockGit.checkoutLocalBranch).toHaveBeenCalledWith(
      'agent/PROJ-1-fix-login-bug-with-spaces'
    );
  });

  it('sanitizes branch names to remove special chars', async () => {
    const { createGitService } = await import('../services/git.js');
    const svc = createGitService('token');
    const branch = await svc.createBranch('/tmp/job-1', 'PROJ-1', 'Fix: user@email issue!');
    expect(branch).toBe('agent/PROJ-1-fix-useremail-issue');
  });

  it('commits all changes and returns sha', async () => {
    const { createGitService } = await import('../services/git.js');
    const svc = createGitService('token');
    const sha = await svc.commitAll('/tmp/job-1', 'fix: PROJ-1 resolve login');
    expect(sha).toBe('abc1234');
  });

  it('pushes branch to origin', async () => {
    const { createGitService } = await import('../services/git.js');
    const svc = createGitService('token');
    await svc.push('/tmp/job-1', 'agent/PROJ-1-fix');
    expect(mockGit.push).toHaveBeenCalledWith('origin', 'agent/PROJ-1-fix');
  });
});
