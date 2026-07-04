import { useParams } from 'react-router-dom';
import { useNavigate, useLocation } from 'react-router-dom';
import { Hash, Volume2, Home, Bell, MessageSquare, Users } from 'lucide-react';
import { useChannelStore } from '../../stores/channelStore';
import { useGuildStore } from '../../stores/guildStore';
import { useUIStore } from '../../stores/uiStore';
import { ChannelType, type Channel } from '../../types/index';
import { useUnreadCounts } from '../../hooks/useUnreadCounts';
import { Tooltip } from '../ui/Tooltip';
import { cn } from '../../lib/utils';
import { getVersionedJson } from '../../lib/versionedStorage';
import { DMList } from './DMList';
import { GuildChannelList } from './GuildChannelList';

const EMPTY_CHANNELS: Channel[] = [];

interface ChannelSidebarProps {
  collapsed?: boolean;
}

export function ChannelSidebar({ collapsed = false }: ChannelSidebarProps) {
  const channels = useChannelStore((s) => s.channels);
  const dmChannels = useChannelStore((s) => s.channelsByGuild[''] ?? EMPTY_CHANNELS);
  const selectedChannelId = useChannelStore((s) => s.selectedChannelId);
  const selectChannel = useChannelStore((s) => s.selectChannel);
  const selectedGuildId = useGuildStore((s) => s.selectedGuildId);
  const guilds = useGuildStore((s) => s.guilds);
  const navigate = useNavigate();
  const location = useLocation();
  const { guildId } = useParams();

  const effectiveGuildId = guildId || selectedGuildId;
  const currentGuild = guilds.find((g) => g.id === effectiveGuildId);

  const mutedGuildIds = (() => {
    try {
      return getVersionedJson<string[]>('muted-guilds', [], ['muted-guilds']);
    } catch {
      return [];
    }
  })();
  const { isChannelUnread, channelMentionCounts } = useUnreadCounts(mutedGuildIds);

  // Compact DM sidebar (no guild, collapsed)
  if (!currentGuild && collapsed) {
    const compactDms = dmChannels.slice(0, 32);
    return (
      <div className="flex h-full flex-col items-center px-2 py-3">
        <Tooltip content="Home" side="right">
          <button
            onClick={() => navigate('/app')}
            aria-label="Home"
            className={cn(
              'relative mb-1 flex h-10 w-10 items-center justify-center rounded-md outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)]',
              location.pathname === '/app'
                ? 'bg-accent-tint text-accent-primary'
                : 'bg-bg-mod-subtle text-text-secondary hover:bg-bg-mod-strong hover:text-text-primary'
            )}
          >
            {location.pathname === '/app' && (
              <span className="absolute left-0 top-1/2 h-4 w-[3px] -translate-x-1.5 -translate-y-1/2 rounded-r-full bg-accent-secondary" />
            )}
            <Home size={16} />
          </button>
        </Tooltip>
        <Tooltip content="Friends" side="right">
          <button
            onClick={() => navigate('/app/friends')}
            aria-label="Friends"
            className={cn(
              'relative mb-2 flex h-10 w-10 items-center justify-center rounded-md outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)]',
              location.pathname === '/app/friends'
                ? 'bg-accent-tint text-accent-primary'
                : 'bg-bg-mod-subtle text-text-secondary hover:bg-bg-mod-strong hover:text-text-primary'
            )}
          >
            {location.pathname === '/app/friends' && (
              <span className="absolute left-0 top-1/2 h-4 w-[3px] -translate-x-1.5 -translate-y-1/2 rounded-r-full bg-accent-secondary" />
            )}
            <Users size={16} />
          </button>
        </Tooltip>

        <div className="mb-2 h-px w-6 bg-border-subtle" />

        <div className="flex w-full flex-1 flex-col items-center gap-1.5 overflow-y-auto px-0.5 scrollbar-thin">
          {compactDms.map((dm) => {
            const isSelected = selectedChannelId === dm.id;
            return (
              <Tooltip key={dm.id} content={dm.recipient?.username || 'Direct Message'} side="right">
                <button
                  aria-label={`Open direct message with ${dm.recipient?.username || 'unknown user'}`}
                  onClick={() => {
                    selectChannel(dm.id);
                    navigate(`/app/dms/${dm.id}`);
                  }}
                  className={cn(
                    'relative flex h-9 w-9 items-center justify-center rounded-full text-meta font-semibold outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)]',
                    isSelected
                      ? 'bg-accent-tint text-accent-primary ring-2 ring-accent-secondary'
                      : 'bg-bg-mod-subtle text-text-secondary hover:bg-bg-mod-strong hover:text-text-primary'
                  )}
                >
                  {(dm.recipient?.username || 'D').charAt(0).toUpperCase()}
                </button>
              </Tooltip>
            );
          })}
        </div>
      </div>
    );
  }

  // Full DM sidebar (no guild, not collapsed)
  if (!currentGuild) {
    return <DMList />;
  }

  // Compact guild channel sidebar (guild, collapsed)
  if (collapsed) {
    const compactChannels = channels
      .filter((ch) => ch.type !== 4)
      .sort((a, b) => a.position - b.position)
      .slice(0, 80);

    return (
      <div className="flex h-full flex-col items-center px-1.5 py-3">
        <Tooltip content={`${currentGuild.name} settings`} side="right">
          <button
            className="mb-2 flex h-10 w-10 items-center justify-center rounded-md bg-bg-mod-strong text-meta font-bold text-text-primary outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-accent-tint hover:text-accent-primary focus-visible:shadow-[var(--focus-ring)]"
            aria-label={`Open settings for ${currentGuild.name}`}
            onClick={() => useUIStore.getState().setGuildSettingsId(currentGuild.id)}
          >
            {currentGuild.name.slice(0, 2).toUpperCase()}
          </button>
        </Tooltip>
        <div className="mb-2 h-px w-6 bg-border-subtle" />
        <div className="flex w-full flex-1 flex-col items-center gap-1.5 overflow-y-auto px-0.5 scrollbar-thin">
          {compactChannels.map((ch) => {
            const isSelected = selectedChannelId === ch.id;
            const isVoice = ch.type === 2 || ch.channel_type === 2;
            const isForum = ch.type === 7 || ch.channel_type === 7;
            const isAnnouncementCompact = ch.type === ChannelType.Announcement || ch.channel_type === 5;
            const hasUnread = !isSelected && isChannelUnread.has(ch.id);
            const mentionCount = channelMentionCounts.get(ch.id) || 0;
            return (
              <Tooltip key={ch.id} content={ch.name || 'unknown'} side="right">
                <button
                  aria-label={`Open channel ${ch.name || 'unknown'}`}
                  onClick={() => {
                    selectChannel(ch.id);
                    navigate(`/app/guilds/${effectiveGuildId}/channels/${ch.id}`);
                  }}
                  className={cn(
                    'relative flex h-9 w-9 items-center justify-center rounded-md outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)]',
                    isSelected
                      ? 'bg-accent-tint text-accent-primary'
                      : hasUnread
                      ? 'bg-bg-mod-subtle text-text-primary hover:bg-bg-mod-strong'
                      : 'bg-bg-mod-subtle text-text-secondary hover:bg-bg-mod-strong hover:text-text-primary'
                  )}
                >
                  {isVoice ? <Volume2 size={16} /> : isForum ? <MessageSquare size={16} /> : isAnnouncementCompact ? <Bell size={16} /> : <Hash size={16} />}
                  {hasUnread && mentionCount === 0 && (
                    <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-accent-primary ring-2 ring-bg-secondary" />
                  )}
                  {mentionCount > 0 && (
                    <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent-primary px-0.5 text-[9px] font-semibold tabular-nums text-text-on-accent ring-2 ring-bg-secondary">
                      {mentionCount > 9 ? '9+' : mentionCount}
                    </span>
                  )}
                </button>
              </Tooltip>
            );
          })}
        </div>
      </div>
    );
  }

  // Full guild channel sidebar
  return <GuildChannelList guildId={effectiveGuildId!} />;
}
