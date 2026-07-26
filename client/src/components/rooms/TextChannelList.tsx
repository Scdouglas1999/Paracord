import { useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router';
import { Bell, Hash, MessageSquare, MessagesSquare } from 'lucide-react';
import { buildChannelGroups } from '../../lib/features/channelGroups';
import { useUnreadCounts } from '../../hooks/useUnreadCounts';
import { getVersionedJson } from '../../lib/versionedStorage';
import { ChannelType, type Channel } from '../../types';
import { cn } from '../../lib/utils';

interface TextChannelListProps {
  guildId: string;
  /** All of the guild's channels; voice/stage are filtered out internally. */
  channels: Channel[];
}

function isVoiceLike(channel: Channel): boolean {
  const type = channel.type ?? channel.channel_type;
  return type === ChannelType.Voice || type === ChannelType.Stage;
}

function readMutedGuildIds(): string[] {
  try {
    return getVersionedJson<string[]>('muted-guilds', [], ['muted-guilds']);
  } catch {
    return [];
  }
}

/**
 * Grouped text-channel list for the guild home — categories preserved via
 * buildChannelGroups, unread/mention state from useUnreadCounts (single-arg
 * mutedGuildIds signature; resolves per-server internally). Each row follows the
 * design-spec Nav-item recipe: active = --accent-tint + a 3px teal left bar, an
 * 8px emerald unread dot, and an emerald mention badge — never a full fill.
 */
export function TextChannelList({ guildId, channels }: TextChannelListProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const mutedGuildIds = useMemo(readMutedGuildIds, []);
  const { isChannelUnread, channelMentionCounts } = useUnreadCounts(mutedGuildIds);

  const groups = useMemo(
    () => buildChannelGroups(channels.filter((c) => !isVoiceLike(c))),
    [channels],
  );

  const selectedChannelId = useMemo(() => {
    const match = location.pathname.match(/\/channels\/([^/]+)/);
    return match ? match[1] : null;
  }, [location.pathname]);

  if (groups.length === 0) {
    // Left-aligned empty state (kill-list #4).
    return (
      <section aria-label="Text channels">
        <SectionLabel>Channels</SectionLabel>
        <div className="rounded-md border border-border-subtle bg-bg-secondary p-5 shadow-sm">
          <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-sm bg-accent-tint text-accent-primary">
            <Hash size={18} />
          </div>
          <h3 className="text-subhead text-text-primary">No text channels yet</h3>
          <p className="mt-1 max-w-prose text-label text-text-secondary">
            Create your first channel to give the community a place to talk.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section aria-label="Text channels" className="flex flex-col gap-4">
      <SectionLabel>Channels</SectionLabel>
      <div className="flex flex-col gap-4">
        {groups.map((group) => (
          <div key={group.id} role="group" aria-label={`${group.name} channels`}>
            <div className="mb-1 px-2 text-section uppercase text-text-muted">
              {group.name}
            </div>
            <div className="flex flex-col gap-0.5">
              {group.channels.map((channel) => {
                const isSelected = selectedChannelId === channel.id;
                const hasUnread = !isSelected && isChannelUnread.has(channel.id);
                const mentionCount = channelMentionCounts.get(channel.id) || 0;
                const type = channel.type ?? channel.channel_type;
                const Icon =
                  type === ChannelType.Forum
                    ? MessageSquare
                    : type === ChannelType.Announcement
                      ? Bell
                      : Hash;

                return (
                  <button
                    key={channel.id}
                    type="button"
                    aria-current={isSelected ? 'page' : undefined}
                    onClick={() =>
                      navigate(`/app/guilds/${guildId}/channels/${channel.id}`)
                    }
                    className={cn(
                      'group relative flex h-[34px] items-center gap-2 rounded-sm px-2 text-left outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)]',
                      isSelected
                        ? 'bg-accent-tint text-text-primary'
                        : 'text-text-secondary hover:bg-bg-mod-subtle hover:text-text-primary',
                    )}
                  >
                    {isSelected && (
                      <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-accent-secondary" />
                    )}
                    {hasUnread && (
                      <span className="absolute -left-0.5 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full bg-accent-primary" />
                    )}
                    <Icon
                      size={18}
                      className={cn(
                        'shrink-0',
                        isSelected ? 'text-accent-primary' : 'text-channel-icon',
                      )}
                    />
                    <span
                      className={cn(
                        'truncate text-label',
                        isSelected
                          ? 'font-semibold'
                          : hasUnread
                            ? 'font-semibold text-text-primary'
                            : 'font-medium',
                      )}
                    >
                      {channel.name || 'unknown'}
                    </span>
                    {mentionCount > 0 && (
                      <span className="ml-auto flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent-primary px-1 text-[11px] font-semibold tabular-nums text-text-on-accent">
                        {mentionCount}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-section uppercase text-text-muted">
      <MessagesSquare size={14} className="text-interactive-normal" />
      {children}
    </div>
  );
}
