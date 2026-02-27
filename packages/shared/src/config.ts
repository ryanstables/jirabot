import { z } from 'zod';

export const BoardConfigSchema = z.object({
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

function requireEnv(name: string): string {
  const val = process.env[name];
  if (val === undefined || val === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return val;
}

export function loadConfigFromEnv(): AgentConfig {
  return parseConfig({
    jira: {
      host: requireEnv('JIRA_HOST'),
      agentEmail: requireEnv('JIRA_AGENT_EMAIL'),
      apiToken: requireEnv('JIRA_API_TOKEN'),
      agentAccountId: requireEnv('JIRA_AGENT_ACCOUNT_ID'),
      webhookSecret: requireEnv('JIRA_WEBHOOK_SECRET'),
    },
    github: {
      appId: Number(requireEnv('GITHUB_APP_ID')),
      privateKey: requireEnv('GITHUB_APP_PRIVATE_KEY'),
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
  });
}
