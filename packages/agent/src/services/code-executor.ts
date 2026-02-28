import { execa } from 'execa';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface ExecutorOptions {
  maxTimeoutMs: number;
}

export interface RunOptions {
  prompt: string;
  workDir: string;
  attempt: number;
}

export interface RunResult {
  success: boolean;
  testsPass: boolean;
  stdout: string;
  stderr: string;
  failureSummary?: string;
}

const TEST_PASS_PATTERNS = [
  /all tests pass/i,
  /\d+ tests? passing/i,
  /tests passed/i,
  /✓|✔/,
];

const TEST_FAIL_PATTERNS = [
  /tests? fail/i,
  /\d+ fail/i,
  /assertion error/i,
];

export function detectTestStatus(output: string): boolean {
  const hasPassing = TEST_PASS_PATTERNS.some((p) => p.test(output));
  const hasFailing = TEST_FAIL_PATTERNS.some((p) => p.test(output));
  // Pass if there's passing output and no failure indicators
  return hasPassing && !hasFailing;
}

export function createCodeExecutor(options: ExecutorOptions) {
  return {
    async run({ prompt, workDir, attempt }: RunOptions): Promise<RunResult> {
      // Write prompt to a temp file so we don't have to escape it in shell
      const promptFile = path.join(workDir, `.claude-prompt-attempt-${attempt}.md`);
      await fs.mkdir(workDir, { recursive: true });
      await fs.writeFile(promptFile, prompt, 'utf8');

      try {
        const result = await execa(
          'claude',
          ['--print', '--dangerously-skip-permissions', `@${promptFile}`],
          {
            cwd: workDir,
            timeout: options.maxTimeoutMs,
            reject: true,
          }
        );

        const combined = `${result.stdout}\n${result.stderr}`;
        const testsPass = detectTestStatus(combined);

        return {
          success: true,
          testsPass,
          stdout: result.stdout,
          stderr: result.stderr,
        };
      } catch (error) {
        const err = error as { stderr?: string; stdout?: string; message?: string };
        const failureOutput = err.stderr ?? err.stdout ?? err.message ?? 'Unknown error';

        return {
          success: false,
          testsPass: false,
          stdout: err.stdout ?? '',
          stderr: err.stderr ?? '',
          failureSummary: failureOutput.slice(0, 1000), // cap at 1000 chars
        };
      } finally {
        // Clean up prompt file
        await fs.unlink(promptFile).catch(() => {});
      }
    },
  };
}
