import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  UserPlus,
  Plus,
  Compass,
  ChevronRight,
  MessageSquare,
  FileText,
  MessagesSquare,
  Headphones,
  PhoneCall,
  Users,
} from 'lucide-react';

import { useAuthStore } from '../stores/authStore';
import { useGuildStore } from '../stores/guildStore';
import { useRelationshipStore } from '../stores/relationshipStore';
import { usePresenceStore } from '../stores/presenceStore';
import { useChannelStore } from '../stores/channelStore';
import { useServerListStore } from '../stores/serverListStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useVoice } from '../hooks/useVoice';
import { dmApi } from '../api/dms';
import { extractApiError } from '../api/client';
import { CreateGuildModal } from '../components/guild/CreateGuildModal';
import { DmPickerModal } from '../components/message/DmPickerModal';
import { RoomCard } from '../components/rooms/RoomCard';
import { EmptyState } from '../components/ui/Feedback';
import { Button } from '../components/ui/Button';
import { safeStoredImageDataUrl } from '../lib/security';
import { getGuildColor } from '../lib/colors';
import { toast } from '../stores/toastStore';
import { cn } from '../lib/utils';

import { ChannelType, type Channel } from '../types';

const EMPTY_CHANNELS: Channel[] = [];

/** Human name for a DM/group-DM channel — recipient, group title, or member list. */
function dmDisplayName(channel: Channel): string {
  if (channel.type === ChannelType.GroupDM) {
    if (channel.name) return channel.name;
    const names = (channel.recipients ?? []).map((r) => r.username).filter(Boolean);
    return names.length > 0 ? names.join(', ') : 'Group DM';
  }
  return channel.recipient?.username || 'Direct Message';
}

const STATUS_COLOR: Record<string, string> = {
  online: 'bg-status-online',
  idle: 'bg-status-idle',
  dnd: 'bg-status-dnd',
  streaming: 'bg-status-streaming',
  offline: 'bg-status-offline',
};

function greetingFor(hour: number): string {
  if (hour < 5) return 'Still up';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

// Presence dot ringed in the surface behind it (design-spec §7 Avatar). Ring
// color is passed so a dot on the page reads cleanly against a panel or the canvas.
function PresenceAvatar({
  name,
  size = 40,
  status,
  ring = 'var(--bg-primary)',
}: {
  name: string;
  size?: number;
  status?: string;
  ring?: string;
}) {
  const dot = Math.round(size * 0.34);
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <div
        className="flex h-full w-full items-center justify-center rounded-full bg-accent-tint font-semibold text-accent-primary"
        style={{ fontSize: Math.round(size * 0.4) }}
      >
        {name.charAt(0).toUpperCase()}
      </div>
      {status && status !== 'offline' && (
        <span
          className={cn('absolute -bottom-0.5 -right-0.5 rounded-full', STATUS_COLOR[status] ?? 'bg-status-offline')}
          style={{ width: dot, height: dot, boxShadow: `0 0 0 2.5px ${ring}` }}
        />
      )}
    </div>
  );
}

function SectionHeader({
  icon,
  label,
  count,
}: {
  icon: ReactNode;
  label: string;
  count?: number;
}) {
  return (
    <div className="mb-2 flex items-center gap-2 px-1 text-section uppercase text-text-muted">
      <span className="text-text-muted">{icon}</span>
      <span>{label}</span>
      {count != null && count > 0 && (
        <span className="rounded-xs bg-bg-mod-strong px-1.5 py-0.5 text-meta font-semibold tabular-nums text-text-secondary">
          {count}
        </span>
      )}
    </div>
  );
}

export function HomePage() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const guilds = useGuildStore((s) => s.guilds);
  const selectGuild = useGuildStore((s) => s.selectGuild);
  const relationships = useRelationshipStore((s) => s.relationships);
  const fetchRelationships = useRelationshipStore((s) => s.fetchRelationships);
  const presences = usePresenceStore((s) => s.presences);
  const getPresence = usePresenceStore((s) => s.getPresence);
  const channelsByGuild = useChannelStore((s) => s.channelsByGuild);
  const fetchChannels = useChannelStore((s) => s.fetchChannels);
  const channelParticipants = useVoiceStore((s) => s.channelParticipants);
  const speakingUsers = useVoiceStore((s) => s.speakingUsers);
  const activeServerId = useServerListStore((s) => s.activeServerId);
  const { joinChannel } = useVoice();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showDmPicker, setShowDmPicker] = useState(false);
  const loadedGuildsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    void fetchRelationships();
  }, [fetchRelationships]);

  useEffect(() => {
    // Fetch each guild's channels once; a new `guilds` array reference (e.g. a
    // presence-driven store update) must not trigger a refetch of every guild.
    guilds.forEach((g) => {
      if (loadedGuildsRef.current.has(g.id)) return;
      loadedGuildsRef.current.add(g.id);
      void fetchChannels(g.id);
    });
  }, [guilds, fetchChannels]);

  const friends = useMemo(
    () => relationships.filter((r) => r.type === 1),
    [relationships],
  );

  const presenceScope = activeServerId ?? undefined;

  // Recomputes when the presences Map reference changes. getPresence keeps the
  // scope-drift fallback a plain Map lookup would lose.
  const onlineFlags = useMemo(
    () =>
      friends.map(
        (r) => (getPresence(r.user.id, presenceScope)?.status || 'offline') !== 'offline',
      ),
    [friends, presences, getPresence, presenceScope],
  );

  // Primitive signature: changes only when the set of friends or one of their
  // online states flips, giving `onlineFriends` a stable identity across the
  // unrelated presence writes that constantly swap the presences Map.
  const onlineKey = friends.map((r, i) => `${r.user.id}:${onlineFlags[i] ? 1 : 0}`).join('|');

  const onlineFriends = useMemo(
    () => friends.filter((_, i) => onlineFlags[i]),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onlineKey captures friends + onlineFlags
    [onlineKey],
  );

  // Live DM / group-DM calls: the DM channels that currently have voice
  // occupants. This is the "Global Happening Now" for your private life —
  // fed straight from voiceStore.channelParticipants (the same source the
  // guild Rooms view reads), scoped to DM + group-DM channels.
  const liveDmCalls = useMemo(() => {
    const dmChannels = channelsByGuild[''] ?? EMPTY_CHANNELS;
    return dmChannels
      .filter((c) => c.type === ChannelType.DM || c.type === ChannelType.GroupDM)
      .map((c) => ({ channel: c, participants: channelParticipants.get(c.id) || [] }))
      .filter((item) => item.participants.length > 0);
  }, [channelsByGuild, channelParticipants]);

  const recentDms = useMemo(() => {
    const dmChannels = channelsByGuild[''] ?? EMPTY_CHANNELS;
    if (dmChannels.length === 0) return [];
    return [...dmChannels]
      .filter((c) => c.last_message_id)
      .sort((a, b) => {
        const aId = BigInt(a.last_message_id!);
        const bId = BigInt(b.last_message_id!);
        return aId > bId ? -1 : aId < bId ? 1 : 0;
      })
      .slice(0, 5);
  }, [channelsByGuild]);

  const handleMessageFriend = async (userId: string) => {
    try {
      const { data } = await dmApi.create(userId);
      const current = useChannelStore.getState().channelsByGuild[''] || [];
      const existing = current.find((c) => c.id === data.id);
      const nextDms = existing ? current : [...current, data];
      useChannelStore.getState().setDmChannels(nextDms);
      useChannelStore.getState().selectChannel(data.id);
      navigate(`/app/dms/${data.id}`);
    } catch (err) {
      toast.error(`Failed to open direct message: ${extractApiError(err)}`);
    }
  };

  const handleGuildClick = async (guild: { id: string }) => {
    selectGuild(guild.id);
    await useChannelStore.getState().selectGuild(guild.id);
    navigate(`/app/guilds/${guild.id}`);
  };

  const statusLine = useMemo(() => {
    const parts: string[] = [];
    if (liveDmCalls.length > 0) {
      parts.push(`${liveDmCalls.length} call${liveDmCalls.length === 1 ? '' : 's'} happening now`);
    }
    parts.push(
      onlineFriends.length > 0
        ? `${onlineFriends.length} friend${onlineFriends.length === 1 ? '' : 's'} around`
        : 'No friends around',
    );
    parts.push(`${guilds.length} server${guilds.length === 1 ? '' : 's'}`);
    return parts.join('  ·  ');
  }, [liveDmCalls.length, onlineFriends.length, guilds.length]);

  const quickActions = [
    { icon: UserPlus, label: 'Add a friend', hint: 'By username or ID', onClick: () => navigate('/app/friends') },
    { icon: Plus, label: 'Create a server', hint: 'Start a new community', onClick: () => setShowCreateModal(true) },
    { icon: Compass, label: 'Explore servers', hint: 'Find public communities', onClick: () => navigate('/app/discovery') },
    { icon: FileText, label: 'Browse templates', hint: 'Launch from a blueprint', onClick: () => navigate('/app/templates') },
  ];

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-bg-primary scrollbar-thin">
      {/* Solid raised header — greeting in Fraunces, a warm-neutral status line.
          Deliberately not a gradient hero (kill-list #1). */}
      <header className="flex shrink-0 items-center gap-4 border-b border-border-subtle bg-bg-secondary px-6 py-6 sm:px-8 sm:py-7">
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-title text-text-primary sm:text-display">
            {greetingFor(new Date().getHours())}, {user?.username}
          </h1>
          <p className="mt-1.5 text-body text-text-secondary">{statusLine}</p>
        </div>
        <Button size="sm" className="shrink-0" onClick={() => setShowDmPicker(true)}>
          <MessageSquare size={16} />
          New message
        </Button>
      </header>

      <div className="grid flex-1 grid-cols-1 gap-8 px-6 py-6 sm:px-8 xl:grid-cols-[minmax(0,1fr)_320px]">
        {/* Main column — live calls, then who's around, then recent DMs.
            Activity as list rows / room cards, not identical tiles (kill-list #5). */}
        <div className="flex min-w-0 flex-col gap-8">
          {/* (1) Live DM / group calls — the "Global Happening Now" done right.
              Reuses the RoomCard primitive; no rebuilt card internals. */}
          <section>
            <SectionHeader
              icon={<PhoneCall size={15} />}
              label="Happening now"
              count={liveDmCalls.length}
            />
            {liveDmCalls.length > 0 ? (
              <div className="flex flex-col gap-3">
                {liveDmCalls.map(({ channel, participants }) => {
                  const named: Channel = { ...channel, name: dmDisplayName(channel) };
                  return (
                    <RoomCard
                      key={channel.id}
                      channel={named}
                      participants={participants}
                      speakingUsers={speakingUsers}
                      guildId=""
                      onJoin={() => {
                        void joinChannel(channel.id);
                        useChannelStore.getState().selectChannel(channel.id);
                        navigate(`/app/dms/${channel.id}`);
                      }}
                      onWatch={(streamerId) => {
                        useVoiceStore.getState().setWatchedStreamer(streamerId);
                        useChannelStore.getState().selectChannel(channel.id);
                        navigate(`/app/dms/${channel.id}`);
                      }}
                    />
                  );
                })}
              </div>
            ) : (
              <EmptyState
                className="rounded-md border border-border-subtle bg-bg-secondary px-5 shadow-sm"
                icon={<Headphones size={20} />}
                title="No calls right now"
                description="When you or a friend starts a DM call, it lands here so you can drop straight in with one tap."
                action={
                  <Button variant="secondary" size="sm" onClick={() => setShowDmPicker(true)}>
                    Start a conversation
                  </Button>
                }
              />
            )}
          </section>

          {/* (2) Friends around now — presence-first strip. */}
          <section>
            <SectionHeader icon={<Users size={15} />} label="Around now" count={onlineFriends.length} />
            {onlineFriends.length > 0 ? (
              <div className="divide-y divide-border-subtle rounded-md border border-border-subtle bg-bg-secondary shadow-sm">
                {onlineFriends.map((rel) => {
                  const status = getPresence(rel.user.id, presenceScope)?.status || 'online';
                  return (
                    <button
                      type="button"
                      key={rel.user.id}
                      onClick={() => void handleMessageFriend(rel.user.id)}
                      className="group flex w-full items-center gap-3 px-4 py-3 text-left outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle focus-visible:bg-bg-mod-subtle focus-visible:shadow-[var(--focus-ring)]"
                    >
                      <PresenceAvatar name={rel.user.username} status={status} ring="var(--bg-secondary)" size={38} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-label font-semibold text-text-primary">{rel.user.username}</div>
                        <div className="truncate text-meta text-text-muted">Around now — say hello</div>
                      </div>
                      <MessageSquare
                        size={16}
                        className="shrink-0 text-text-muted transition-colors group-hover:text-text-secondary"
                      />
                    </button>
                  );
                })}
              </div>
            ) : (
              <EmptyState
                className="rounded-md border border-border-subtle bg-bg-secondary px-5 shadow-sm"
                icon={<Users size={20} />}
                title="Nobody around just yet"
                description="The friends you've added show up here the moment they come online, so you can catch them while they're around."
                action={
                  <Button variant="secondary" size="sm" onClick={() => navigate('/app/friends')}>
                    Add a friend
                  </Button>
                }
              />
            )}
          </section>

          {/* (3) Recent DMs — pick up where you left off. */}
          <section>
            <SectionHeader icon={<MessageSquare size={15} />} label="Recent messages" />
            {recentDms.length > 0 ? (
              <div className="divide-y divide-border-subtle rounded-md border border-border-subtle bg-bg-secondary shadow-sm">
                {recentDms.map((dm) => {
                  const username = dmDisplayName(dm);
                  const status = getPresence(dm.recipient?.id || '', presenceScope)?.status || 'offline';
                  return (
                    <button
                      type="button"
                      key={dm.id}
                      onClick={() => {
                        useChannelStore.getState().selectChannel(dm.id);
                        navigate(`/app/dms/${dm.id}`);
                      }}
                      className="group flex w-full items-center gap-3 px-4 py-3 text-left outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle focus-visible:bg-bg-mod-subtle focus-visible:shadow-[var(--focus-ring)]"
                    >
                      <PresenceAvatar name={username} status={status} ring="var(--bg-secondary)" size={38} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-label font-semibold text-text-primary">{username}</div>
                        <div className="truncate text-meta text-text-muted">Tap to open your conversation</div>
                      </div>
                      <ChevronRight
                        size={16}
                        className="shrink-0 text-text-muted transition-colors group-hover:text-text-secondary"
                      />
                    </button>
                  );
                })}
              </div>
            ) : (
              <EmptyState
                className="rounded-md border border-border-subtle bg-bg-secondary px-5 shadow-sm"
                icon={<MessagesSquare size={20} />}
                title="Your inbox is clear"
                description="Direct messages you've been part of show up here. Start one to pick up where you left off."
                action={
                  <Button variant="secondary" size="sm" onClick={() => setShowDmPicker(true)}>
                    Message a friend
                  </Button>
                }
              />
            )}
          </section>
        </div>

        {/* Right rail — one panel, sections split by dividers (no nested cards) */}
        <aside className="flex flex-col gap-6">
          <div className="overflow-hidden rounded-md border border-border-subtle bg-bg-secondary shadow-sm">
            <div className="px-4 pt-4">
              <SectionHeader icon={<UserPlus size={15} />} label="Quick actions" />
            </div>
            <div className="px-2 pb-2">
              {quickActions.map((action) => (
                <button
                  key={action.label}
                  type="button"
                  onClick={action.onClick}
                  className="group flex w-full items-center gap-3 rounded-sm px-2 py-2 text-left outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle focus-visible:bg-bg-mod-subtle focus-visible:shadow-[var(--focus-ring)]"
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm bg-bg-mod-subtle text-text-secondary transition-colors group-hover:bg-accent-tint group-hover:text-accent-primary">
                    <action.icon size={17} />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-label font-medium text-text-primary">{action.label}</span>
                    <span className="block truncate text-meta text-text-muted">{action.hint}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>

          {guilds.length > 0 && (
            <div className="overflow-hidden rounded-md border border-border-subtle bg-bg-secondary shadow-sm">
              <div className="px-4 pt-4">
                <SectionHeader icon={<MessagesSquare size={15} />} label="Your servers" count={guilds.length} />
              </div>
              <div className="max-h-[260px] overflow-y-auto px-2 pb-2 scrollbar-thin">
                {guilds.map((guild) => {
                  const iconSrc = safeStoredImageDataUrl(guild.icon_hash);
                  return (
                    <button
                      key={guild.id}
                      onClick={() => void handleGuildClick(guild)}
                      className="group flex w-full items-center gap-3 rounded-sm px-2 py-2 text-left outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle focus-visible:bg-bg-mod-subtle focus-visible:shadow-[var(--focus-ring)]"
                    >
                      <div
                        className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md"
                        style={!iconSrc ? { backgroundColor: getGuildColor(guild.id) } : undefined}
                      >
                        {iconSrc ? (
                          <img src={iconSrc} alt={guild.name} className="h-full w-full object-cover" />
                        ) : (
                          <span className="text-[11px] font-bold text-white">
                            {guild.name.split(' ').map((w) => w[0]).join('').slice(0, 3).toUpperCase()}
                          </span>
                        )}
                      </div>
                      <span className="min-w-0 flex-1 truncate text-label font-medium text-text-secondary group-hover:text-text-primary">
                        {guild.name}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </aside>
      </div>

      <DmPickerModal open={showDmPicker} onClose={() => setShowDmPicker(false)} />
      {showCreateModal && <CreateGuildModal onClose={() => setShowCreateModal(false)} />}
    </div>
  );
}
