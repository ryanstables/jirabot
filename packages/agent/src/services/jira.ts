import { Version3Client } from 'jira.js';
import type { Version3 } from 'jira.js';
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
  // V2: self-assignment
  searchTickets(jql: string, maxResults?: number): Promise<Array<{ key: string; projectKey: string; summary: string }>>;
  assignTicket(ticketKey: string, accountId: string): Promise<void>;
  // V2: Slack-driven ticket creation
  createTicket(projectKey: string, summary: string, description: string): Promise<string>;
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
      let issue: Version3.Version3Models.Issue;
      try {
        issue = await client.issues.getIssue({
          issueIdOrKey: ticketKey,
          fields: ['summary', 'description', 'comment', 'attachment', 'labels', 'assignee', 'project'],
        });
      } catch (err) {
        throw new Error(`Failed to fetch ticket ${ticketKey}: ${String(err)}`);
      }

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
      // Convert plain text with newlines to ADF paragraphs
      const paragraphs = body.split(/\n\n+/).map((para) => {
        const lines = para.split('\n');
        const content: Array<Record<string, unknown>> = [];
        lines.forEach((line, idx) => {
          content.push({ type: 'text', text: line });
          if (idx < lines.length - 1) {
            content.push({ type: 'hardBreak' });
          }
        });
        return { type: 'paragraph', content };
      });

      let result: Record<string, unknown>;
      try {
        result = await client.issueComments.addComment({
          issueIdOrKey: ticketKey,
          comment: {
            type: 'doc',
            version: 1,
            content: paragraphs as unknown as never,
          },
        }) as unknown as Record<string, unknown>;
      } catch (err) {
        throw new Error(`Failed to post comment on ${ticketKey}: ${String(err)}`);
      }
      const id = result['id'];
      if (typeof id !== 'string' || !id) {
        throw new Error(`postComment: Jira did not return a comment ID for ${ticketKey}`);
      }
      return id;
    },

    async transitionTicket(ticketKey, targetStatusName) {
      let transitions: Array<Record<string, unknown>>;
      try {
        const result = await client.issues.getTransitions({ issueIdOrKey: ticketKey });
        transitions = (result.transitions ?? []) as Array<Record<string, unknown>>;
      } catch (err) {
        throw new Error(`Failed to fetch transitions for ${ticketKey}: ${String(err)}`);
      }
      const transition = transitions.find((t) => t['name'] === targetStatusName);
      if (!transition) {
        throw new Error(`Transition not found: "${targetStatusName}"`);
      }
      try {
        await client.issues.doTransition({
          issueIdOrKey: ticketKey,
          transition: { id: String(transition['id']) },
        });
      } catch (err) {
        throw new Error(`Failed to transition ${ticketKey} to "${targetStatusName}": ${String(err)}`);
      }
    },

    async searchTickets(jql, maxResults = 50) {
      let result: Record<string, unknown>;
      try {
        result = await client.issueSearch.searchForIssuesUsingJql({
          jql,
          maxResults,
          fields: ['summary', 'project'],
        }) as unknown as Record<string, unknown>;
      } catch (err) {
        throw new Error(`Failed to search tickets with JQL "${jql}": ${String(err)}`);
      }
      const issues = (result['issues'] as unknown[] ?? []);
      return issues.map((i) => {
        const issue = i as Record<string, unknown>;
        const fields = issue['fields'] as Record<string, unknown>;
        return {
          key: String(issue['key']),
          projectKey: String((fields['project'] as Record<string, unknown>)?.['key'] ?? ''),
          summary: String(fields['summary'] ?? ''),
        };
      });
    },

    async assignTicket(ticketKey, accountId) {
      try {
        await client.issues.assignIssue({
          issueIdOrKey: ticketKey,
          assignee: { accountId },
        });
      } catch (err) {
        throw new Error(`Failed to assign ticket ${ticketKey} to ${accountId}: ${String(err)}`);
      }
    },

    async createTicket(projectKey, summary, description) {
      let result: Record<string, unknown>;
      try {
        result = await client.issues.createIssue({
          fields: {
            project: { key: projectKey },
            summary,
            description: {
              type: 'doc',
              version: 1,
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: description }],
                },
              ],
            },
            issuetype: { name: 'Task' },
          },
        }) as unknown as Record<string, unknown>;
      } catch (err) {
        throw new Error(`Failed to create ticket in project ${projectKey}: ${String(err)}`);
      }
      const key = result['key'];
      if (typeof key !== 'string' || !key) {
        throw new Error(`createTicket: Jira did not return a ticket key for project ${projectKey}`);
      }
      return key;
    },
  };
}
