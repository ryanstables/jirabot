import { describe, it, expect, vi } from 'vitest';

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn().mockImplementation(() => ({
    pulls: {
      create: vi.fn().mockResolvedValue({
        data: { number: 42, html_url: 'https://github.com/org/repo/pull/42' },
      }),
    },
  })),
}));

vi.mock('@octokit/auth-app', () => ({
  createAppAuth: vi.fn().mockReturnValue(
    vi.fn().mockResolvedValue({ token: 'ghs_mocktoken' })
  ),
}));

describe('GitHubService', () => {
  it('creates a pull request and returns url + number', async () => {
    const { createGitHubService } = await import('../services/github.js');
    const svc = createGitHubService({ appId: 1, privateKey: 'key', installationId: 1 });
    const result = await svc.createPR({
      repo: 'org/repo',
      title: 'fix: PROJ-1 login bug',
      body: 'Fixes login issue',
      head: 'agent/PROJ-1-fix-login',
      base: 'main',
    });
    expect(result.prUrl).toBe('https://github.com/org/repo/pull/42');
    expect(result.prNumber).toBe(42);
  });
});
