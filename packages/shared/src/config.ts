import { z } from 'zod';

const BoardConfigSchema = z.object({
  jiraProject: z.string().min(1),
  githubRepo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'Must be "org/repo" format'),
  defaultBranch: z.string().min(1),
  targetStatus: z.string().min(1),
  escalationStatus: z.string().min(1),
});

export const AgentConfigSchema = z.object({
  jira: z.object({
    host: z.string().min(1),
    agentEmail: z.string().email(),
    apiToken: z.string().min(1),
    agentAccountId: z.string().min(1),
    webhookSecret: z.string().min(1),
  }),
  github: z.object({
    appId: z.number().positive(),
    privateKey: z.string().min(1),
    installationId: z.number().positive(),
  }),
  boards: z.array(BoardConfigSchema).min(1),
  codingAgent: z.literal('claude-code'),
  maxAttempts: z.number().positive().int().default(3),
  anthropicApiKey: z.string().min(1),
  redisUrl: z.string().url(),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type BoardConfig = z.infer<typeof BoardConfigSchema>;

export function parseConfig(raw: unknown): AgentConfig {
  return AgentConfigSchema.parse(raw);
}

export function loadConfigFromEnv(): AgentConfig {
  return parseConfig({
    jira: {
      host: process.env['JIRA_HOST'],
      agentEmail: process.env['JIRA_AGENT_EMAIL'],
      apiToken: process.env['JIRA_API_TOKEN'],
      agentAccountId: process.env['JIRA_AGENT_ACCOUNT_ID'],
      webhookSecret: process.env['JIRA_WEBHOOK_SECRET'],
    },
    github: {
      appId: Number(process.env['GITHUB_APP_ID']),
      privateKey: process.env['GITHUB_APP_PRIVATE_KEY'],
      installationId: Number(process.env['GITHUB_APP_INSTALLATION_ID']),
    },
    boards: JSON.parse(process.env['BOARDS_CONFIG'] ?? '[]'),
    codingAgent: 'claude-code',
    maxAttempts: Number(process.env['MAX_ATTEMPTS'] ?? '3'),
    anthropicApiKey: process.env['ANTHROPIC_API_KEY'],
    redisUrl: process.env['REDIS_URL'],
  });
}
