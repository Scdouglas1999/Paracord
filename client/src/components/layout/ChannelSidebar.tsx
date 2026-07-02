import { useParams } from 'react-router-dom';
import { useNavigate, useLocation } from 'react-router-dom';
import { Hash, Volume2, Home, Bell, MessageSquare } from 'lucide-react';
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
      <div className="flex h-full flex-col items-center px-2 py-4">
        <Tooltip content="Home" side="right">
          <button
            onClick={() => navigate('/app')}
            aria-label="Home"
            className={cn(
              'mb-1.5 flex h-10 w-10 items-center justify-center rounded-xl border text-sm font-semibold transition-colors',
              location.pathname === '/app'
                ? 'border-accent-primary/55 bg-accent-primary/20 text-text-primary'
                : 'border-transparent bg-bg-mod-subtle text-text-secondary hover:border-border-subtle hover:text-text-primary'
            )}
          >
            <Home size={15} />
          </button>
        </Tooltip>
        <Tooltip content="Friends" side="right">
          <button
            onClick={() => navigate('/app/friends')}
            aria-label="Friends"
            className={cn(
              'mb-2 flex h-10 w-10 items-center justify-center rounded-xl border text-sm font-semibold transition-colors',
              location.pathname === '/app/friends'
                ? 'border-accent-primary/55 bg-accent-primary/20 text-text-primary'
                : 'border-transparent bg-bg-mod-subtle text-text-secondary hover:border-border-subtle hover:text-text-primary'
            )}
          >
            <Hash size={15} />
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
                    'relative flex h-9 w-9 items-center justify-center rounded-xl border text-xs font-semibold transition-colors',
                    isSelected
                      ? 'border-accent-primary/55 bg-accent-primary/20 text-text-primary'
                      : 'border-transparent bg-bg-mod-subtle text-text-secondary hover:border-border-subtle hover:text-text-primary'
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
        <Tooltip content={currentGuild.name} side="right">
          <button
            className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl border border-border-subtle bg-bg-mod-subtle text-xs font-bold text-text-primary transition-colors hover:bg-bg-mod-strong"
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
                    'relative flex h-9 w-9 items-center justify-center rounded-xl border transition-colors',
                    isSelected
                      ? 'border-accent-primary/55 bg-accent-primary/20 text-text-primary'
                      : 'border-transparent bg-bg-mod-subtle text-text-secondary hover:border-border-subtle hover:text-text-primary'
                  )}
                >
                  {isVoice ? <Volume2 size={14} /> : isForum ? <MessageSquare size={14} /> : isAnnouncementCompact ? <Bell size={14} /> : <Hash size={14} />}
                  {hasUnread && (
                    <div className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-text-primary" />
                  )}
                  {mentionCount > 0 && (
                    <div className="absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent-danger text-[8px] font-bold text-white">
                      {mentionCount}
                    </div>
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
