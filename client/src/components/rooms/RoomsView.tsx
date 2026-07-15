import { useEffect, useMemo } from 'react';
import { useGuildStore } from '../../stores/guildStore';
import { useChannelStore } from '../../stores/channelStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { useMemberStore } from '../../stores/memberStore';
import { usePresenceStore } from '../../stores/presenceStore';
import { useServerListStore } from '../../stores/serverListStore';
import { ChannelType, type Channel } from '../../types';
import { GuildHomeHeader } from './GuildHomeHeader';
import { LiveRoomsGrid } from './LiveRoomsGrid';
import { SpaceBriefing } from './SpaceBriefing';
import { AroundNowStrip } from './AroundNowStrip';
import { TextChannelList } from './TextChannelList';

interface RoomsViewProps {
  guildId: string;
}

const EMPTY_CHANNELS: Channel[] = [];

function isRoomChannel(channel: Channel): boolean {
  const type = channel.type ?? channel.channel_type;
  return type === ChannelType.Voice || type === ChannelType.Stage;
}

function isTextChannel(channel: Channel): boolean {
  const type = channel.type ?? channel.channel_type;
  return (
    type === ChannelType.Text ||
    type === ChannelType.Announcement ||
    type === ChannelType.Forum
  );
}

/**
 * The guild's map — the presence-first Rooms view that replaces the old channel
 * column. Composes the header, the live-rooms grid, the "around now" strip, and
 * the grouped text-channel list. Shared summary counts (online members, live
 * rooms) are derived once here and handed to the header so the child components
 * stay focused on their own surface.
 */
export function RoomsView({ guildId }: RoomsViewProps) {
  const guild = useGuildStore((s) => s.guilds.find((g) => g.id === guildId));
  const channels = useChannelStore((s) => s.channelsByGuild[guildId] ?? EMPTY_CHANNELS);
  const fetchChannels = useChannelStore((s) => s.fetchChannels);
  const channelParticipants = useVoiceStore((s) => s.channelParticipants);
  const members = useMemberStore((s) => s.members.get(guildId));
  const fetchMembers = useMemberStore((s) => s.fetchMembers);
  const presences = usePresenceStore((s) => s.presences);
  const getPresence = usePresenceStore((s) => s.getPresence);

  const guildServerUrl = guild?.server_url;
  const activeServerId = useServerListStore((s) => s.activeServerId);
  const getServerByUrl = useServerListStore((s) => s.getServerByUrl);
  const scope = useMemo(() => {
    const resolved = guildServerUrl ? getServerByUrl(guildServerUrl)?.id : undefined;
    return resolved ?? activeServerId ?? undefined;
  }, [guildServerUrl, getServerByUrl, activeServerId]);

  useEffect(() => {
    if (guildId && channels.length === 0) {
      void fetchChannels(guildId);
    }
  }, [guildId, channels.length, fetchChannels]);

  useEffect(() => {
    if (guildId && !members) {
      void fetchMembers(guildId);
    }
  }, [guildId, members, fetchMembers]);

  const liveRoomCount = useMemo(
    () =>
      channels.filter(
        (c) => isRoomChannel(c) && (channelParticipants.get(c.id) || []).length > 0,
      ).length,
    [channels, channelParticipants],
  );

  const onlineCount = useMemo(() => {
    if (!members) return 0;
    return members.filter(
      (m) => (getPresence(m.user.id, scope)?.status || 'offline') !== 'offline',
    ).length;
    // presences drives re-derivation on a presence tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members, presences, getPresence, scope]);

  const inviteChannelId = useMemo(
    () => channels.find(isTextChannel)?.id ?? null,
    [channels],
  );

  if (!guild) {
    return (
      <div
        role="status"
        aria-label="Loading server home"
        className="flex h-full flex-col overflow-hidden bg-bg-primary"
      >
        <div className="h-[92px] shrink-0 animate-pulse border-b border-border-subtle bg-bg-secondary" />
        <div className="flex flex-1 flex-col gap-6 p-6 lg:p-8">
          <div className="h-3 w-32 animate-pulse rounded-xs bg-bg-mod-subtle" />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {Array.from({ length: 2 }, (_, i) => (
              <div
                key={i}
                className="h-32 animate-pulse rounded-md border border-border-subtle bg-bg-secondary"
              />
            ))}
          </div>
        </div>
        <span className="sr-only">Loading server home…</span>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg-primary">
      <GuildHomeHeader
        guildId={guildId}
        onlineCount={onlineCount}
        liveRoomCount={liveRoomCount}
        inviteChannelId={inviteChannelId}
      />
      <div className="flex flex-1 flex-col gap-8 overflow-y-auto scrollbar-thin p-6 sm:p-7 lg:p-8">
        <LiveRoomsGrid guildId={guildId} channels={channels} />
        <SpaceBriefing
          guildId={guildId}
          settings={guild.hub_settings}
          channels={channels}
        />
        <AroundNowStrip guildId={guildId} />
        <TextChannelList guildId={guildId} channels={channels} />
      </div>
    </div>
  );
}
