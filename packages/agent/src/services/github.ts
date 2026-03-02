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
  getInstallationToken(): Promise<string>;
}

export function createGitHubService(config: GitHubConfig): GitHubService {
  async function getToken(): Promise<string> {
    if ('pat' in config) {
      return config.pat;
    }
    try {
      const auth = createAppAuth({
        appId: config.appId,
        privateKey: config.privateKey,
        installationId: config.installationId,
      });
      const result = await auth({ type: 'installation' });
      return result.token;
    } catch (err) {
      throw new Error(`Failed to get GitHub installation token: ${String(err)}`);
    }
  }

  return {
    async getInstallationToken() {
      return getToken();
    },

    async createPR({ repo, title, body, head, base }) {
      const slashIndex = repo.indexOf('/');
      if (slashIndex === -1) {
        throw new Error(`Invalid repo format "${repo}": expected "owner/repo"`);
      }
      const owner = repo.slice(0, slashIndex);
      const repoName = repo.slice(slashIndex + 1);

      const token = await getToken();
      const octokit = new Octokit({ auth: token });

      try {
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
      } catch (err) {
        throw new Error(`Failed to create PR for ${repo} (${head} → ${base}): ${String(err)}`);
      }
    },
  };
}
