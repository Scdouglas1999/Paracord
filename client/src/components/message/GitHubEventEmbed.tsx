import type { LucideIcon } from 'lucide-react';
import { GitBranch, GitPullRequest, CircleDot, MessageCircle, Star, Tag, Trash2 } from 'lucide-react';

// GitHub event type detection based on message content patterns
type GitHubEventType = 'push' | 'pull_request' | 'issues' | 'issue_comment' | 'create' | 'delete' | 'star' | 'unknown';

interface GitHubEventInfo {
  type: GitHubEventType;
  repo?: string;
  url?: string;
}

function detectGitHubEvent(content: string): GitHubEventInfo | null {
  // Only try to detect if it looks like a GitHub webhook message
  // These patterns match the backend format_github_event output

  const pushMatch = content.match(/\*\*(.+?)\*\* pushed \d+ commits? to `(.+?)` in \*\*(.+?)\*\*/);
  if (pushMatch) return { type: 'push', repo: pushMatch[3] };

  const prMatch = content.match(/\*\*(.+?)\*\* (?:opened|closed|merged|reopened|edited) PR \[#\d+\]\((.+?)\) in \*\*(.+?)\*\*/);
  if (prMatch) return { type: 'pull_request', repo: prMatch[3], url: prMatch[2] };

  const issueMatch = content.match(/\*\*(.+?)\*\* (?:opened|closed|reopened|edited) issue \[#\d+\]\((.+?)\) in \*\*(.+?)\*\*/);
  if (issueMatch) return { type: 'issues', repo: issueMatch[3], url: issueMatch[2] };

  const commentMatch = content.match(/\*\*(.+?)\*\* commented on \[#\d+\]\((.+?)\) in \*\*(.+?)\*\*/);
  if (commentMatch) return { type: 'issue_comment', repo: commentMatch[3], url: commentMatch[2] };

  const starMatch = content.match(/\*\*(.+?)\*\* (?:starred|unstarred) \*\*(.+?)\*\*/);
  if (starMatch) return { type: 'star', repo: starMatch[2] };

  const createMatch = content.match(/\*\*(.+?)\*\* created (?:branch|tag) `(.+?)` in \*\*(.+?)\*\*/);
  if (createMatch) return { type: 'create', repo: createMatch[3] };

  const deleteMatch = content.match(/\*\*(.+?)\*\* deleted (?:branch|tag) `(.+?)` in \*\*(.+?)\*\*/);
  if (deleteMatch) return { type: 'delete', repo: deleteMatch[3] };

  // Generic GitHub event fallback
  const genericMatch = content.match(/`(.+?)` event in \*\*(.+?)\*\*/);
  if (genericMatch) return { type: 'unknown', repo: genericMatch[2] };

  return null;
}

const EVENT_COLORS: Record<GitHubEventType, string> = {
  push: '#3b82f6',         // blue
  pull_request: '#a855f7', // purple
  issues: '#22c55e',       // green
  issue_comment: '#3b82f6', // blue
  create: '#22c55e',       // green
  delete: '#ef4444',       // red
  star: '#eab308',         // yellow
  unknown: '#6b7280',      // gray
};

const EVENT_ICONS: Record<GitHubEventType, LucideIcon> = {
  push: GitBranch,
  pull_request: GitPullRequest,
  issues: CircleDot,
  issue_comment: MessageCircle,
  create: Tag,
  delete: Trash2,
  star: Star,
  unknown: GitBranch,
};

const EVENT_LABELS: Record<GitHubEventType, string> = {
  push: 'Push',
  pull_request: 'Pull Request',
  issues: 'Issue',
  issue_comment: 'Comment',
  create: 'Created',
  delete: 'Deleted',
  star: 'Star',
  unknown: 'Event',
};

interface GitHubEventEmbedProps {
  content: string;
}

export function GitHubEventEmbed({ content }: GitHubEventEmbedProps) {
  const eventInfo = detectGitHubEvent(content);
  if (!eventInfo) return null;

  const color = EVENT_COLORS[eventInfo.type];
  const Icon = EVENT_ICONS[eventInfo.type];
  const label = EVENT_LABELS[eventInfo.type];

  // Build GitHub repo URL
  const repoUrl = eventInfo.repo ? `https://github.com/${eventInfo.repo}` : null;
  const viewUrl = eventInfo.url || repoUrl;

  return (
    <div
      className="mt-1.5 flex max-w-[480px] overflow-hidden rounded-xl border border-border-subtle bg-bg-mod-subtle/60"
    >
      {/* Colored accent bar */}
      <div className="w-1 shrink-0 rounded-l-xl" style={{ backgroundColor: color }} />

      <div className="flex min-w-0 flex-1 flex-col gap-1.5 px-3 py-2.5">
        {/* Header: icon + event type badge + repo name */}
        <div className="flex items-center gap-2">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" className="shrink-0 text-text-muted">
            <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
          </svg>
          <Icon size={13} className="shrink-0" style={{ color }} />
          <span
            className="rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide"
            style={{ backgroundColor: `${color}20`, color }}
          >
            {label}
          </span>
          {eventInfo.repo && (
            <span className="truncate text-xs font-semibold text-text-secondary">
              {eventInfo.repo}
            </span>
          )}
        </div>

        {/* View on GitHub link */}
        {viewUrl && (
          <a
            href={viewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 self-start text-[11px] font-medium text-text-link hover:underline"
          >
            View on GitHub
          </a>
        )}
      </div>
    </div>
  );
}

/** Check if a message looks like a GitHub webhook message */
export function isGitHubWebhookMessage(message: { author: { bot?: boolean }; content: string | null }): boolean {
  if (!message.author.bot) return false;
  if (!message.content) return false;
  return detectGitHubEvent(message.content) !== null;
}
