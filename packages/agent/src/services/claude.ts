import Anthropic from '@anthropic-ai/sdk';
import type { JiraTicket, SufficiencyResult } from '@jirabot/shared';

const SUFFICIENCY_SYSTEM_PROMPT = `You are a software engineering triage assistant.
Given a Jira ticket, determine whether it contains sufficient information for a developer to begin implementation.

A ticket is sufficient if it has:
1. A clear description of the problem or feature
2. Steps to reproduce (for bugs) OR acceptance criteria (for features)
3. Expected vs actual behavior (for bugs)
4. No critical missing context that would block investigation

Respond ONLY with valid JSON matching this schema:
{ "sufficient": boolean, "questions": string[] }

If sufficient is true, questions must be an empty array.
If sufficient is false, questions must list the specific missing information needed.`;

export interface ClaudeService {
  checkSufficiency(ticket: JiraTicket): Promise<SufficiencyResult>;
  buildCodingPrompt(ticket: JiraTicket): string;
}

export function createClaudeService(apiKey: string): ClaudeService {
  const client = new Anthropic({ apiKey });

  return {
    async checkSufficiency(ticket) {
      const ticketText = formatTicketForPrompt(ticket);
      let response: Awaited<ReturnType<typeof client.messages.create>>;
      try {
        response = await client.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 1024,
          system: SUFFICIENCY_SYSTEM_PROMPT,
          messages: [
            { role: 'user', content: ticketText },
          ],
        });
      } catch (err) {
        throw new Error(`Failed to check sufficiency for ${ticket.key}: ${String(err)}`);
      }

      const textBlock = response.content.find((b) => b.type === 'text');
      if (!textBlock || textBlock.type !== 'text') {
        throw new Error(`Unexpected Claude API response format for ${ticket.key}`);
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(textBlock.text) as Record<string, unknown>;
      } catch {
        throw new Error(`Failed to parse sufficiency response for ${ticket.key}: ${textBlock.text}`);
      }
      if (typeof parsed['sufficient'] !== 'boolean' || !Array.isArray(parsed['questions'])) {
        throw new Error(`Invalid sufficiency response shape for ${ticket.key}: ${textBlock.text}`);
      }
      return { sufficient: parsed['sufficient'], questions: parsed['questions'] as string[] };
    },

    buildCodingPrompt(ticket) {
      const comments = ticket.comments
        .map((c) => `- ${c.body} (${c.created})`)
        .join('\n');

      return `# Jira Ticket: ${ticket.key}

## Summary
${ticket.summary}

## Description
${ticket.description ?? '(no description)'}

## Comments
${comments || 'No comments'}

## Labels
${ticket.labels.join(', ') || 'None'}

---

You are an expert software engineer. Your task is to resolve the Jira ticket above by writing production-quality code.

Instructions:
1. Explore the codebase to understand the relevant code and context
2. Write the minimal code changes necessary to resolve the issue
3. Write or update tests to cover the fix
4. Ensure all existing tests still pass
5. Commit your changes with a clear commit message referencing the ticket key

Focus only on what is described in the ticket. Do not refactor unrelated code.`;
    },
  };
}

function formatTicketForPrompt(ticket: JiraTicket): string {
  const comments = ticket.comments
    .map((c) => `Comment: ${c.body}`)
    .join('\n');

  return `Ticket: ${ticket.key}
Summary: ${ticket.summary}
Description: ${ticket.description ?? '(no description)'}
${comments}
Labels: ${ticket.labels.join(', ')}`;
}
