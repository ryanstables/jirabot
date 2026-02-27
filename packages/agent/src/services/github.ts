import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import type { AgentConfig } from '@jirabot/shared';

type GitHubConfig = AgentConfig['github'];

export interface PROptions {
  repo: string;       // "org/repo"
  title: string;
  body: string;
  head: string;       // feature branch
  base: string;       // target branch
}

export interface PRResult {
  prUrl: string;
  prNumber: number;
}

export interface GitHubService {
  createPR(options: PROptions): Promise<PRResult>;
}

export function createGitHubService(config: GitHubConfig): GitHubService {
  async function getOctokit(): Promise<Octokit> {
    const auth = createAppAuth({
      appId: config.appId,
      privateKey: config.privateKey,
      installationId: config.installationId,
    });
    const { token } = await auth({ type: 'installation' });
    return new Octokit({ auth: token });
  }

  return {
    async createPR({ repo, title, body, head, base }) {
      const [owner, repoName] = repo.split('/') as [string, string];
      const octokit = await getOctokit();
      const { data } = await octokit.pulls.create({
        owner,
        repo: repoName,
        title,
        body,
        head,
        base,
      });
      return {
        prUrl: data.html_url,
        prNumber: data.number,
      };
    },
  };
}
