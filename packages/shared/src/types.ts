export type TicketState =
  | 'awaiting_info'
  | 'diagnosing'
  | 'coding'
  | 'pr_opened'
  | 'escalated';

export interface JiraTicket {
  key: string;
  projectKey: string;
  summary: string;
  description: string | null;
  comments: JiraComment[];
  attachments: JiraAttachment[];
  labels: string[];
  assigneeAccountId: string;
}

export interface JiraComment {
  id: string;
  body: string;
  authorAccountId: string;
  created: string;
}

export interface JiraAttachment {
  id: string;
  filename: string;
  mimeType: string;
  contentUrl: string;
}

export interface JobPayload {
  ticketKey: string;
  projectKey: string;
  timestamp: string;
  jobId: string;
}

export interface SufficiencyResult {
  sufficient: boolean;
  questions: string[];
}

export interface AttemptRecord {
  attempt: number;
  failureSummary: string;
  filesChanged: string[];
  timestamp: string;
}

// V2: Multi-repo support

export interface SecondaryRepo {
  githubRepo: string;
  defaultBranch: string;
}

export interface RepoResult {
  repo: string;
  branch: string;
  prUrl: string;
  prNumber: number;
}

// V2: Slack integration

export interface SlackCommandPayload {
  slackUserId: string;
  channelId: string;
  text: string;
  responseUrl: string;
  timestamp: string;
}

export type SlackIntent =
  | { action: 'create_ticket'; projectKey: string; summary: string; description: string }
  | { action: 'unknown'; response: string };
