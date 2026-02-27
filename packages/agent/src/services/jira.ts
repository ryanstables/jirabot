import { Version3Client } from 'jira.js';
import type { JiraTicket, JiraComment } from '@jirabot/shared';
import type { AgentConfig } from '@jirabot/shared';

type JiraConfig = AgentConfig['jira'];

// Atlassian Document Format → plain text
function extractAdfText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as Record<string, unknown>;
  if (n['type'] === 'text' && typeof n['text'] === 'string') return n['text'];
  if (Array.isArray(n['content'])) {
    return (n['content'] as unknown[]).map(extractAdfText).join(' ');
  }
  return '';
}

export interface JiraService {
  getTicket(ticketKey: string): Promise<JiraTicket>;
  postComment(ticketKey: string, body: string): Promise<string>;
  transitionTicket(ticketKey: string, targetStatusName: string): Promise<void>;
}

export function createJiraService(config: JiraConfig): JiraService {
  const client = new Version3Client({
    host: `https://${config.host}`,
    authentication: {
      basic: {
        email: config.agentEmail,
        apiToken: config.apiToken,
      },
    },
  });

  return {
    async getTicket(ticketKey) {
      const issue = await client.issues.getIssue({
        issueIdOrKey: ticketKey,
        fields: ['summary', 'description', 'comment', 'attachment', 'labels', 'assignee', 'project'],
      });

      const fields = issue.fields as Record<string, unknown>;

      const comments: JiraComment[] = ((fields['comment'] as Record<string, unknown>)?.['comments'] as unknown[] ?? []).map((c) => {
        const comment = c as Record<string, unknown>;
        const author = comment['author'] as Record<string, unknown>;
        return {
          id: String(comment['id']),
          body: extractAdfText(comment['body']),
          authorAccountId: String(author?.['accountId'] ?? ''),
          created: String(comment['created']),
        };
      });

      const attachments = ((fields['attachment'] as unknown[]) ?? []).map((a) => {
        const att = a as Record<string, unknown>;
        return {
          id: String(att['id']),
          filename: String(att['filename']),
          mimeType: String(att['mimeType']),
          contentUrl: String(att['content']),
        };
      });

      const descriptionText = extractAdfText(fields['description']);

      return {
        key: issue.key,
        projectKey: String((fields['project'] as Record<string, unknown>)?.['key'] ?? ''),
        summary: String(fields['summary'] ?? ''),
        description: descriptionText || null,
        comments,
        attachments,
        labels: (fields['labels'] as string[]) ?? [],
        assigneeAccountId: String(((fields['assignee'] as Record<string, unknown>)?.['accountId']) ?? ''),
      };
    },

    async postComment(ticketKey, body) {
      const result = await client.issueComments.addComment({
        issueIdOrKey: ticketKey,
        body: {
          type: 'doc',
          version: 1,
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: body }],
            },
          ],
        },
      });
      return String((result as Record<string, unknown>)['id']);
    },

    async transitionTicket(ticketKey, targetStatusName) {
      const { transitions = [] } = await client.issues.getTransitions({ issueIdOrKey: ticketKey });
      const transition = (transitions as Array<Record<string, unknown>>).find(
        (t) => t['name'] === targetStatusName
      );
      if (!transition) {
        throw new Error(`Transition not found: "${targetStatusName}"`);
      }
      await client.issues.doTransition({
        issueIdOrKey: ticketKey,
        transition: { id: String(transition['id']) },
      });
    },
  };
}
