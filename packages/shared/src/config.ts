import { z } from 'zod';

export const SecondaryRepoSchema = z.object({
  githubRepo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'Must be "org/repo" format'),
  defaultBranch: z.string().min(1),
});

export const BoardConfigSchema = z.object({
  jiraProject: z.string().min(1),
  githubRepo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'Must be "org/repo" format'),
  defaultBranch: z.string().min(1),
  targetStatus: z.string().min(1),
  escalationStatus: z.string().min(1),
  // V2: multi-repo
  secondaryRepos: z.array(SecondaryRepoSchema).default([]),
  multiRepoLabel: z.string().default('multi-repo'),
  // V2: self-assignment
  autoAssignJql: z.string().optional(),
  // V2: Slack notifications
  slackChannel: z.string().optional(),
});

export const SlackConfigSchema = z.object({
  botToken: z.string().min(1),
  signingSecret: z.string().min(1),
});

export const GitHubAppConfigSchema = z.object({
  appId: z.number().positive(),
  privateKey: z.string().min(1),
  installationId: z.number().positive(),
});

export const GitHubPatConfigSchema = z.object({
  pat: z.string().min(1),
});

export const AgentConfigSchema = z.object({
  jira: z.object({
    host: z.string().min(1),
    agentEmail: z.string().email(),
    apiToken: z.string().min(1),
    agentAccountId: z.string().min(1),
    webhookSecret: z.string().min(1),
  }),
  github: z.union([GitHubAppConfigSchema, GitHubPatConfigSchema]),
  boards: z.array(BoardConfigSchema).min(1),
  codingAgent: z.literal('claude-code'),
  maxAttempts: z.number().positive().int().default(3),
  anthropicApiKey: z.string().min(1),
  redisUrl: z.string().url(),
  // V2: Slack integration
  slack: SlackConfigSchema.optional(),
  // V2: cron schedule for self-assignment scan
  scanCronSchedule: z.string().default('*/5 * * * *'),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type BoardConfig = z.infer<typeof BoardConfigSchema>;
export type SlackConfig = z.infer<typeof SlackConfigSchema>;
export type SecondaryRepoConfig = z.infer<typeof SecondaryRepoSchema>;

export function parseConfig(raw: unknown): AgentConfig {
  return AgentConfigSchema.parse(raw);
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (val === undefined || val === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return val;
}

function optionalEnv(name: string): string | undefined {
  const val = process.env[name];
  return val !== undefined && val !== '' ? val : undefined;
}

export function loadConfigFromEnv(): AgentConfig {
  const slackBotToken = optionalEnv('SLACK_BOT_TOKEN');
  const slackSigningSecret = optionalEnv('SLACK_SIGNING_SECRET');

  return parseConfig({
    jira: {
      host: requireEnv('JIRA_HOST'),
      agentEmail: requireEnv('JIRA_AGENT_EMAIL'),
      apiToken: requireEnv('JIRA_API_TOKEN'),
      agentAccountId: requireEnv('JIRA_AGENT_ACCOUNT_ID'),
      webhookSecret: requireEnv('JIRA_WEBHOOK_SECRET'),
    },
    github: optionalEnv('GITHUB_PAT')
      ? { pat: requireEnv('GITHUB_PAT') }
      : {
          appId: Number(requireEnv('GITHUB_APP_ID')),
          privateKey: requireEnv('GITHUB_APP_PRIVATE_KEY').replace(/\\n/g, '\n'),
          installationId: Number(requireEnv('GITHUB_APP_INSTALLATION_ID')),
        },
    boards: (() => {
      const raw = process.env['BOARDS_CONFIG'] ?? '[]';
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        throw new Error('BOARDS_CONFIG is not valid JSON');
      }
    })(),
    codingAgent: 'claude-code',
    maxAttempts: Number(process.env['MAX_ATTEMPTS'] ?? '3'),
    anthropicApiKey: requireEnv('ANTHROPIC_API_KEY'),
    redisUrl: requireEnv('REDIS_URL'),
    slack: slackBotToken && slackSigningSecret
      ? { botToken: slackBotToken, signingSecret: slackSigningSecret }
      : undefined,
    scanCronSchedule: process.env['SCAN_CRON_SCHEDULE'] ?? '*/5 * * * *',
  });
}
