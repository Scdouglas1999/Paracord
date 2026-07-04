import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  UserPlus,
  Plus,
  Compass,
  ChevronRight,
  Volume2,
  MessageSquare,
  FileText,
  MessagesSquare,
  Headphones,
} from 'lucide-react';

import { useAuthStore } from '../stores/authStore';
import { useGuildStore } from '../stores/guildStore';
import { useRelationshipStore } from '../stores/relationshipStore';
import { usePresenceStore } from '../stores/presenceStore';
import { useChannelStore } from '../stores/channelStore';
import { useServerListStore } from '../stores/serverListStore';
import { useVoiceStore } from '../stores/voiceStore';
import { dmApi } from '../api/dms';
import { extractApiError } from '../api/client';
import { CreateGuildModal } from '../components/guild/CreateGuildModal';
import { EmptyState } from '../components/ui/Feedback';
import { Button } from '../components/ui/Button';
import { safeStoredImageDataUrl } from '../lib/security';
import { getGuildColor } from '../lib/colors';
import { Tooltip } from '../components/ui/Tooltip';
import { toast } from '../stores/toastStore';
import { cn } from '../lib/utils';

import type { Channel } from '../types';

const EMPTY_CHANNELS: Channel[] = [];

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
  const activeServerId = useServerListStore((s) => s.activeServerId);
  const [showCreateModal, setShowCreateModal] = useState(false);
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

  const activeVoiceChannels = useMemo(() => {
    const allChannels = Object.entries(channelsByGuild)
      .filter(([gid]) => gid !== '')
      .flatMap(([_, chs]) => chs);

    return allChannels
      .filter(c => c.type === 2)
      .map(c => ({
        channel: c,
        guild: guilds.find(g => g.id === c.guild_id),
        participants: channelParticipants.get(c.id) || []
      }))
      .filter(item => item.participants.length > 0);
  }, [channelsByGuild, channelParticipants, guilds]);

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
    parts.push(
      onlineFriends.length > 0
        ? `${onlineFriends.length} friend${onlineFriends.length === 1 ? '' : 's'} online`
        : 'No friends online',
    );
    if (activeVoiceChannels.length > 0) {
      parts.push(`${activeVoiceChannels.length} voice room${activeVoiceChannels.length === 1 ? '' : 's'} live`);
    }
    parts.push(`${guilds.length} server${guilds.length === 1 ? '' : 's'}`);
    return parts.join('  ·  ');
  }, [onlineFriends.length, activeVoiceChannels.length, guilds.length]);

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
      <header className="shrink-0 border-b border-border-subtle bg-bg-secondary px-6 py-6 sm:px-8 sm:py-7">
        <h1 className="font-display text-title text-text-primary sm:text-display">
          {greetingFor(new Date().getHours())}, {user?.username}
        </h1>
        <p className="mt-1.5 text-body text-text-secondary">{statusLine}</p>
      </header>

      <div className="grid flex-1 grid-cols-1 gap-8 px-6 py-6 sm:px-8 xl:grid-cols-[minmax(0,1fr)_320px]">
        {/* Main column — activity as list rows, not tiled cards (kill-list #5) */}
        <div className="flex min-w-0 flex-col gap-8">
          <section>
            <SectionHeader
              icon={<Volume2 size={15} />}
              label="Active voice"
              count={activeVoiceChannels.length}
            />
            {activeVoiceChannels.length > 0 ? (
              <div className="divide-y divide-border-subtle rounded-md border border-border-subtle bg-bg-secondary shadow-sm">
                {activeVoiceChannels.map(({ channel, guild, participants }) => {
                  const shown = participants.slice(0, 4);
                  const overflow = participants.length > 4 ? participants.length - 4 : 0;
                  return (
                    <div
                      key={channel.id}
                      className="group flex items-center gap-4 px-4 py-3 transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle"
                    >
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-accent-tint text-accent-primary">
                        <Volume2 size={18} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-label font-semibold text-text-primary">{channel.name}</span>
                          <span className="inline-flex items-center gap-1 text-meta tabular-nums text-status-online">
                            <span className="h-1.5 w-1.5 rounded-full bg-status-online" />
                            {participants.length}
                          </span>
                        </div>
                        {guild && <div className="truncate text-meta text-text-muted">in {guild.name}</div>}
                      </div>
                      <div className="hidden items-center sm:flex">
                        {shown.map((p, i) => (
                          <Tooltip key={p.user_id} content={p.username || p.user_id} side="top">
                            <div
                              className="flex h-7 w-7 items-center justify-center rounded-full bg-accent-tint text-[11px] font-semibold text-accent-primary"
                              style={{
                                marginLeft: i > 0 ? '-8px' : '0',
                                boxShadow: '0 0 0 2px var(--bg-secondary)',
                              }}
                            >
                              {(p.username || p.user_id).charAt(0).toUpperCase()}
                            </div>
                          </Tooltip>
                        ))}
                        {overflow > 0 && (
                          <div
                            className="flex h-7 w-7 items-center justify-center rounded-full bg-bg-mod-strong text-[11px] font-semibold text-text-secondary"
                            style={{ marginLeft: '-8px', boxShadow: '0 0 0 2px var(--bg-secondary)' }}
                          >
                            +{overflow}
                          </div>
                        )}
                      </div>
                      <Button
                        size="sm"
                        className="shrink-0"
                        onClick={() => navigate(`/app/guilds/${guild?.id}/channels/${channel.id}`)}
                      >
                        Join
                      </Button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <EmptyState
                className="rounded-md border border-border-subtle bg-bg-secondary px-5 shadow-sm"
                icon={<Headphones size={20} />}
                title="No one's in voice yet"
                description="When friends hop into a voice channel across your servers, you'll see the room here and can drop in with one click."
                action={
                  <Button variant="secondary" size="sm" onClick={() => navigate('/app/discovery')}>
                    Find a community
                  </Button>
                }
              />
            )}
          </section>

          <section>
            <SectionHeader icon={<MessageSquare size={15} />} label="Recent messages" />
            {recentDms.length > 0 ? (
              <div className="divide-y divide-border-subtle rounded-md border border-border-subtle bg-bg-secondary shadow-sm">
                {recentDms.map((dm) => {
                  const username = dm.recipient?.username || 'Direct Message';
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
                description="Direct messages you've been part of show up here. Start one from a friend's profile to pick up where you left off."
                action={
                  <Button variant="secondary" size="sm" onClick={() => navigate('/app/friends')}>
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

            <div className="border-t border-border-subtle px-4 pt-4">
              <SectionHeader icon={<MessageSquare size={15} />} label="Online now" count={onlineFriends.length} />
            </div>
            <div className="max-h-[240px] overflow-y-auto px-2 pb-2 scrollbar-thin">
              {onlineFriends.length === 0 ? (
                <p className="px-2 py-3 text-meta leading-relaxed text-text-muted">
                  None of your friends are online right now — they'll appear here the moment they sign in.
                </p>
              ) : (
                onlineFriends.map((rel) => (
                  <button
                    type="button"
                    key={rel.user.id}
                    onClick={() => void handleMessageFriend(rel.user.id)}
                    className="flex w-full items-center gap-3 rounded-sm px-2 py-2 text-left outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle focus-visible:bg-bg-mod-subtle focus-visible:shadow-[var(--focus-ring)]"
                  >
                    <PresenceAvatar name={rel.user.username} status="online" ring="var(--bg-secondary)" size={32} />
                    <span className="min-w-0 flex-1 truncate text-label font-medium text-text-primary">
                      {rel.user.username}
                    </span>
                    <MessageSquare size={15} className="shrink-0 text-text-muted" />
                  </button>
                ))
              )}
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

      {showCreateModal && <CreateGuildModal onClose={() => setShowCreateModal(false)} />}
    </div>
  );
}
