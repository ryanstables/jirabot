import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

describe('CodeExecutor', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('writes prompt to file and invokes claude --print', async () => {
    const { execa } = await import('execa');
    const mockExeca = vi.mocked(execa);
    mockExeca.mockResolvedValue({
      stdout: 'Code generated successfully',
      stderr: '',
      exitCode: 0,
    } as never);

    const { createCodeExecutor } = await import('../services/code-executor.js');
    const executor = createCodeExecutor({ maxTimeoutMs: 5000 });
    const result = await executor.run({
      prompt: 'Fix the login bug',
      workDir: '/tmp/job-test',
      attempt: 1,
    });

    expect(mockExeca).toHaveBeenCalled();
    const [cmd, args] = mockExeca.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('claude');
    expect(args).toContain('--print');
    expect(result.success).toBe(true);
  });

  it('returns failure on non-zero exit', async () => {
    const { execa } = await import('execa');
    const mockExeca = vi.mocked(execa);
    mockExeca.mockRejectedValue(
      Object.assign(new Error('Command failed'), { stderr: 'Tests failed: 3 failures', exitCode: 1 })
    );

    const { createCodeExecutor } = await import('../services/code-executor.js');
    const executor = createCodeExecutor({ maxTimeoutMs: 5000 });
    const result = await executor.run({
      prompt: 'Fix the login bug',
      workDir: '/tmp/job-test',
      attempt: 1,
    });

    expect(result.success).toBe(false);
    expect(result.failureSummary).toContain('Tests failed');
  });

  it('detects test passage from stdout', async () => {
    const { execa } = await import('execa');
    const mockExeca = vi.mocked(execa);
    mockExeca.mockResolvedValue({
      stdout: 'All tests passed. 42 tests passing.',
      stderr: '',
      exitCode: 0,
    } as never);

    const { createCodeExecutor } = await import('../services/code-executor.js');
    const executor = createCodeExecutor({ maxTimeoutMs: 5000 });
    const result = await executor.run({
      prompt: 'Fix something',
      workDir: '/tmp/job-test',
      attempt: 1,
    });
    expect(result.success).toBe(true);
    expect(result.testsPass).toBe(true);
  });
});
