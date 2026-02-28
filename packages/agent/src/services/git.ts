import { simpleGit } from 'simple-git';

export interface GitService {
  cloneRepo(repo: string, workDir: string, branch: string): Promise<void>;
  createBranch(workDir: string, ticketKey: string, summary: string): Promise<string>;
  commitAll(workDir: string, message: string): Promise<string>;
  push(workDir: string, branch: string): Promise<void>;
  getChangedFiles(workDir: string): Promise<string[]>;
}

function sanitizeBranchSegment(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9-\s]/g, '')   // remove special chars (keep letters, digits, hyphens, spaces)
    .trim()
    .replace(/\s+/g, '-')           // spaces → dashes
    .replace(/-+/g, '-')            // collapse multiple dashes
    .replace(/^-|-$/g, '');         // trim leading/trailing dashes
}

export function createGitService(githubTokenBase: string): GitService {
  return {
    async cloneRepo(repo, workDir, branch) {
      const url = githubTokenBase.startsWith('https://')
        ? `${githubTokenBase}/${repo}.git`
        : `https://x-access-token:${githubTokenBase}@github.com/${repo}.git`;
      const git = simpleGit();
      try {
        await git.clone(url, workDir, ['--branch', branch, '--depth', '1']);
      } catch (err) {
        throw new Error(`Failed to clone ${repo}: ${String(err)}`);
      }
    },

    async createBranch(workDir, ticketKey, summary) {
      const sanitizedSummary = sanitizeBranchSegment(summary);
      const branchName = `agent/${ticketKey}-${sanitizedSummary}`;
      const git = simpleGit(workDir);
      try {
        await git.checkoutLocalBranch(branchName);
      } catch (err) {
        throw new Error(`Failed to create branch ${branchName}: ${String(err)}`);
      }
      return branchName;
    },

    async commitAll(workDir, message) {
      const git = simpleGit(workDir);
      try {
        await git.add('.');
        await git.commit(message);
        const sha = await git.revparse(['HEAD']);
        return sha.trim();
      } catch (err) {
        throw new Error(`Failed to commit in ${workDir}: ${String(err)}`);
      }
    },

    async push(workDir, branch) {
      const git = simpleGit(workDir);
      try {
        await git.push('origin', branch);
      } catch (err) {
        throw new Error(`Failed to push ${branch}: ${String(err)}`);
      }
    },

    async getChangedFiles(workDir) {
      const git = simpleGit(workDir);
      try {
        const status = await git.status();
        return status.files.map((f) => f.path);
      } catch (err) {
        throw new Error(`Failed to get status in ${workDir}: ${String(err)}`);
      }
    },
  };
}
