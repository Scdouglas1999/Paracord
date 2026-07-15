import { Hash, MessageSquare, MessagesSquare, Volume2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { usePresenceStore } from '../../stores/presenceStore';
import { resolveUserAvatarUrl } from '../../lib/userAvatar';
import { snowflakeToMs, type ConversationEntry } from '../../lib/attention/conversationModel';
import { cn } from '../../lib/utils';

const STATUS_COLORS: Record<string, string> = {
  online: 'bg-status-online',
  idle: 'bg-status-idle',
  dnd: 'bg-status-dnd',
  streaming: 'bg-status-streaming',
  offline: 'bg-status-offline',
};

const AVATAR_KINDS = new Set<ConversationEntry['kind']>(['dm', 'group_dm']);

function PresenceDot({ userId, scope }: { userId?: string | null; scope?: string }) {
  const status = usePresenceStore((s) =>
    userId ? (s.getPresence(userId, scope)?.status ?? 'offline') : 'offline',
  );
  return (
    <span
      aria-hidden
      className={cn(
        'absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full ring-2 ring-bg-secondary',
        STATUS_COLORS[status] ?? STATUS_COLORS.offline,
      )}
    />
  );
}

function relativeFromSnowflake(id: string | null): string | null {
  if (!id) return null;
  try {
    return formatDistanceToNow(new Date(snowflakeToMs(id)), { addSuffix: true });
  } catch {
    return null;
  }
}

function hintFor(entry: ConversationEntry): string {
  if (entry.mentionCount > 0) {
    return entry.mentionCount === 1 ? '1 mention' : `${entry.mentionCount} mentions`;
  }
  if (entry.isDMUnread || entry.unread || entry.isThreadReply) return 'Unread';
  if (entry.hasVoiceActivity) return 'Live voice';
  if (entry.contextLabel) return `in ${entry.contextLabel}`;
  const rel = relativeFromSnowflake(entry.lastActivityId);
  return rel ?? 'Continue';
}

export interface HomePickUpRowProps {
  entry: ConversationEntry;
  onClick: (entry: ConversationEntry) => void;
}

/**
 * Richer "continue" row for the Home canvas — larger avatar, relative time, and
 * unread/mention hints. Intentionally not the sidebar `ConversationRow` chrome.
 */
export function HomePickUpRow({ entry, onClick }: HomePickUpRowProps) {
  const useAvatar = AVATAR_KINDS.has(entry.kind);
  const src = resolveUserAvatarUrl(entry.avatar);
  const time = relativeFromSnowflake(entry.lastActivityId);
  const hint = hintFor(entry);
  const showMention = entry.mentionCount > 0;
  const showUnread =
    !showMention && (entry.unread || entry.isDMUnread || entry.isThreadReply);

  const Icon =
    entry.kind === 'voice' ? Volume2 : entry.kind === 'thread' ? MessageSquare : Hash;

  return (
    <button
      type="button"
      onClick={() => onClick(entry)}
      className="group flex w-full items-center gap-3 px-3 py-2.5 text-left outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle focus-visible:bg-bg-mod-subtle focus-visible:shadow-[var(--focus-ring)]"
    >
      <span className="relative shrink-0">
        {useAvatar ? (
          <span className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-full bg-accent-tint text-label font-semibold text-accent-primary">
            {src ? (
              <img src={src} alt="" className="h-full w-full object-cover" />
            ) : entry.kind === 'group_dm' ? (
              <MessagesSquare size={18} aria-hidden />
            ) : (
              (entry.title.charAt(0) || '?').toUpperCase()
            )}
          </span>
        ) : (
          <span className="flex h-10 w-10 items-center justify-center rounded-md bg-bg-mod-strong text-channel-icon">
            <Icon size={18} aria-hidden />
          </span>
        )}
        {entry.kind === 'dm' && <PresenceDot userId={entry.userId} scope={entry.serverId} />}
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate text-label font-semibold text-text-primary">{entry.title}</span>
          {time && (
            <span className="shrink-0 text-meta tabular-nums text-text-muted">{time}</span>
          )}
        </span>
        <span className="mt-0.5 flex items-center gap-2 truncate text-meta text-text-muted">
          {showUnread && (
            <span
              aria-hidden
              className="inline-block h-2 w-2 shrink-0 rounded-full bg-accent-primary"
            />
          )}
          <span className="truncate">{hint}</span>
        </span>
      </span>

      {showMention && (
        <span className="shrink-0 rounded-xs bg-accent-primary px-1.5 py-0.5 text-meta font-semibold tabular-nums text-text-on-accent">
          {entry.mentionCount}
        </span>
      )}
    </button>
  );
}
