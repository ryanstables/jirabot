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
