import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  UserPlus,
  Plus,
  Compass,
  MessageSquare,
  FileText,
  PhoneCall,
} from 'lucide-react';

import { useAuthStore } from '../stores/authStore';
import { useGuildStore } from '../stores/guildStore';
import { useRelationshipStore } from '../stores/relationshipStore';
import { usePresenceStore } from '../stores/presenceStore';
import { useChannelStore } from '../stores/channelStore';
import { useServerListStore } from '../stores/serverListStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useUIStore } from '../stores/uiStore';
import { useMutedGuilds } from '../hooks/useMutedGuilds';
import { useUnifiedConversations } from '../hooks/useUnifiedConversations';
import { useVoice } from '../hooks/useVoice';
import { dmApi } from '../api/dms';
import { extractApiError } from '../api/client';
import { CreateGuildModal } from '../components/guild/CreateGuildModal';
import { DmPickerModal } from '../components/message/DmPickerModal';
import { RoomCard } from '../components/rooms/RoomCard';
import { HomeAroundStrip, activityLineFrom, type AroundFriend } from '../components/home/HomeAroundStrip';
import { HomeJumpInRow } from '../components/home/HomeJumpInRow';
import { HomePickUpRow } from '../components/home/HomePickUpRow';
import { HomeResumeHero } from '../components/home/HomeResumeHero';
import { HomeServersRail, type HomeServerAttention } from '../components/home/HomeServersRail';
import { HomeSetupChecklist, type SetupStep } from '../components/home/HomeSetupChecklist';
import { HomeSectionHeader } from '../components/home/HomeSectionHeader';
import { Button } from '../components/ui/Button';
import { toast } from '../stores/toastStore';
import { displayName } from '../lib/displayName';
import type { ConversationEntry } from '../lib/attention/conversationModel';
import type { GuildSummary } from '../hooks/useUnifiedConversations';

import { ChannelType, type Channel, type VoiceState } from '../types';

const EMPTY_CHANNELS: Channel[] = [];
const EMPTY_PARTICIPANTS: VoiceState[] = [];
/** Denser continue list — Home canvas can carry more than the sidebar glance. */
const PICK_UP_CAP = 10;
const RELATIONSHIP_PENDING_INCOMING = 3;

/** Human name for a DM/group-DM channel — recipient, group title, or member list. */
function dmDisplayName(channel: Channel): string {
  if (channel.type === ChannelType.GroupDM) {
    if (channel.name) return channel.name;
    const names = (channel.recipients ?? []).map((r) => r.username).filter(Boolean);
    return names.length > 0 ? names.join(', ') : 'Group DM';
  }
  return channel.recipient ? displayName(channel.recipient) : 'Direct Message';
}

function greetingFor(hour: number): string {
  if (hour < 5) return 'Still up';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function isRoomChannel(channel: Channel): boolean {
  const type = channel.type ?? channel.channel_type;
  return type === ChannelType.Voice || type === ChannelType.Stage;
}

interface LiveRoomItem {
  key: string;
  channel: Channel;
  participants: VoiceState[];
  guildId: string;
  contextLabel: string | null;
}

/**
 * App Home — Pulse Lobby + Catch-up hybrid.
 *
 * Complementary canvas to the unified sidebar (NeedsYou / RecentList / SpacesList
 * stay there). Quiet accounts get a deliberate stacked composition: resume hero,
 * denser Pick up, Your spaces cards, and always-visible Jump-in — never a barren
 * two-column void or stacked EmptyStates.
 */
export function HomePage() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const guilds = useGuildStore((s) => s.guilds);
  const selectGuild = useGuildStore((s) => s.selectGuild);
  const selectedGuildId = useGuildStore((s) => s.selectedGuildId);
  const relationships = useRelationshipStore((s) => s.relationships);
  const fetchRelationships = useRelationshipStore((s) => s.fetchRelationships);
  const pendingRequestCount = useMemo(
    () => relationships.filter((r) => r.type === RELATIONSHIP_PENDING_INCOMING).length,
    [relationships],
  );
  const presences = usePresenceStore((s) => s.presences);
  const getPresence = usePresenceStore((s) => s.getPresence);
  const channelsByGuild = useChannelStore((s) => s.channelsByGuild);
  const fetchChannels = useChannelStore((s) => s.fetchChannels);
  const channelParticipants = useVoiceStore((s) => s.channelParticipants);
  const speakingUsers = useVoiceStore((s) => s.speakingUsers);
  const activeServerId = useServerListStore((s) => s.activeServerId);
  const { mutedGuildIds } = useMutedGuilds();
  // Presence is intentionally NOT read inside useUnifiedConversations — Home
  // keeps presence on the Around strip / Pick-up DM rows only.
  const { recent, spaces, needsYou } = useUnifiedConversations(mutedGuildIds);
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
  // online states flips, giving `aroundFriends` a stable identity across the
  // unrelated presence writes that constantly swap the presences Map.
  const onlineKey = friends.map((r, i) => `${r.user.id}:${onlineFlags[i] ? 1 : 0}`).join('|');

  const aroundFriends = useMemo<AroundFriend[]>(() => {
    return friends
      .filter((_, i) => onlineFlags[i])
      .map((rel) => {
        const presence = getPresence(rel.user.id, presenceScope);
        return {
          user: rel.user,
          status: presence?.status || 'online',
          activity: activityLineFrom(presence?.activities),
        };
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onlineKey captures friends + onlineFlags
  }, [onlineKey, getPresence, presenceScope]);

  // Live rooms across private life (DM/group calls) AND guild voice/stage —
  // the Pulse Lobby "Happening now" surface. Omit the whole section when empty.
  const liveRooms = useMemo<LiveRoomItem[]>(() => {
    const items: LiveRoomItem[] = [];

    const dmChannels = channelsByGuild[''] ?? EMPTY_CHANNELS;
    for (const c of dmChannels) {
      if (c.type !== ChannelType.DM && c.type !== ChannelType.GroupDM) continue;
      const participants = (channelParticipants.get(c.id) || EMPTY_PARTICIPANTS).filter(
        (p) => !p.guild_id,
      );
      if (participants.length === 0) continue;
      items.push({
        key: `dm:${c.id}`,
        channel: { ...c, name: dmDisplayName(c) },
        participants,
        guildId: '',
        contextLabel: null,
      });
    }

    for (const guild of guilds) {
      const channels = channelsByGuild[guild.id] ?? EMPTY_CHANNELS;
      for (const c of channels) {
        if (!isRoomChannel(c)) continue;
        const participants = (channelParticipants.get(c.id) || EMPTY_PARTICIPANTS).filter(
          (p) => p.guild_id === guild.id,
        );
        if (participants.length === 0) continue;
        items.push({
          key: `guild:${guild.id}:${c.id}`,
          channel: c,
          participants,
          guildId: guild.id,
          contextLabel: guild.name,
        });
      }
    }

    return items;
  }, [channelsByGuild, channelParticipants, guilds]);

  const pickUp = useMemo(
    () => recent.filter((e) => e.lastActivityId).slice(0, PICK_UP_CAP),
    [recent],
  );

  const guildById = useMemo(() => {
    const map = new Map(guilds.map((g) => [g.id, g]));
    return map;
  }, [guilds]);

  /**
   * Primary space for the Resume hero: prefer the last-selected guild when it
   * still exists in spaces; else the space tied to the newest pick-up guild row;
   * else the first space. Home-unique — not a sidebar Recent clone.
   */
  const primarySpace = useMemo<GuildSummary | null>(() => {
    if (spaces.length === 0) return null;
    if (selectedGuildId) {
      const selected = spaces.find((s) => s.id === selectedGuildId);
      if (selected) return selected;
    }
    const fromRecent = pickUp.find((e) => e.guildId);
    if (fromRecent?.guildId) {
      const match = spaces.find((s) => s.id === fromRecent.guildId);
      if (match) return match;
    }
    return spaces[0] ?? null;
  }, [spaces, selectedGuildId, pickUp]);

  const primaryLastChannel = useMemo(() => {
    if (!primarySpace) return null;
    return (
      pickUp.find(
        (e) =>
          e.guildId === primarySpace.id &&
          (e.kind === 'guild_text' || e.kind === 'thread' || e.kind === 'voice'),
      ) ?? null
    );
  }, [primarySpace, pickUp]);

  const serverAttention = useMemo(() => {
    const map = new Map<string, HomeServerAttention>();
    for (const space of spaces) {
      const guild = guildById.get(space.id);
      map.set(space.id, {
        unread: false,
        live: false,
        memberCount: guild?.member_count,
      });
    }
    for (const e of needsYou) {
      if (!e.guildId) continue;
      const cur = map.get(e.guildId) ?? { unread: false, live: false };
      cur.unread = true;
      map.set(e.guildId, cur);
    }
    // Pick-up / recent can still carry unread guild rows that lost the Needs-you
    // cap race — keep space cards + resume hero in sync with those rows.
    for (const e of pickUp) {
      if (!e.guildId) continue;
      if (!(e.unread || e.mentionCount > 0 || e.isThreadReply)) continue;
      const cur = map.get(e.guildId) ?? { unread: false, live: false };
      cur.unread = true;
      map.set(e.guildId, cur);
    }
    for (const room of liveRooms) {
      if (!room.guildId) continue;
      const cur = map.get(room.guildId) ?? { unread: false, live: false };
      cur.live = true;
      map.set(room.guildId, cur);
    }
    return map;
  }, [spaces, needsYou, pickUp, liveRooms, guildById]);

  /** Quiet = no live rooms and no online friends — still compose a full canvas. */
  const isQuiet = liveRooms.length === 0 && aroundFriends.length === 0;

  // Onboarding progress, derived live from store state rather than a stored
  // flag — a step un-checks itself if the underlying thing goes away, and the
  // whole block vanishes once every step is done (see HomeSetupChecklist).
  const setupSteps = useMemo<SetupStep[]>(
    () => [
      {
        key: 'space',
        label: 'Create or join a space',
        hint: 'Spaces hold your channels, rooms, and people.',
        done: spaces.length > 0,
        action: () => setShowCreateModal(true),
        actionLabel: 'Create',
      },
      {
        key: 'profile',
        label: 'Set a display name and avatar',
        hint: 'How people recognize you across every server.',
        done: Boolean(user?.display_name || user?.avatar_hash),
        action: () => useUIStore.getState().setUserSettingsOpen(true, 'identity'),
        actionLabel: 'Edit profile',
      },
      {
        key: 'friend',
        label: 'Add a friend',
        hint: 'Send a request by username to start a DM.',
        done: friends.length > 0,
        action: () => navigate('/app/friends'),
        actionLabel: 'Add',
      },
      {
        key: 'conversation',
        label: 'Start a conversation',
        hint: 'Message someone directly, or post in a channel.',
        done: pickUp.length > 0,
        action: () => setShowDmPicker(true),
        actionLabel: 'Message',
      },
    ],
    [spaces.length, user?.display_name, user?.avatar_hash, friends.length, pickUp.length, navigate],
  );

  const handleMessageFriend = useCallback(
    async (userId: string) => {
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
    },
    [navigate],
  );

  const openConversation = useCallback(
    (entry: ConversationEntry) => {
      if (useServerListStore.getState().activeServerId !== entry.serverId) {
        useServerListStore.getState().setActive(entry.serverId);
      }
      if (entry.kind === 'guild_home' && entry.guildId) {
        navigate(`/app/guilds/${entry.guildId}`);
      } else if (entry.guildId) {
        navigate(`/app/guilds/${entry.guildId}/channels/${entry.channelId}`);
      } else {
        navigate(`/app/dms/${entry.channelId}`);
      }
    },
    [navigate],
  );

  const openSpace = useCallback(
    async (space: GuildSummary) => {
      if (useServerListStore.getState().activeServerId !== space.serverId) {
        useServerListStore.getState().setActive(space.serverId);
      }
      selectGuild(space.id);
      await useChannelStore.getState().selectGuild(space.id);
      navigate(`/app/guilds/${space.id}`);
    },
    [navigate, selectGuild],
  );

  const statusLine = useMemo(() => {
    if (liveRooms.length > 0) {
      const n = liveRooms.length;
      return `${n} live room${n === 1 ? '' : 's'} you can jump into`;
    }
    if (aroundFriends.length > 0) {
      const n = aroundFriends.length;
      return `${n} friend${n === 1 ? '' : 's'} around — say hello`;
    }
    if (pendingRequestCount > 0) {
      const n = pendingRequestCount;
      return `${n} friend request${n === 1 ? '' : 's'} waiting`;
    }
    if (primarySpace) {
      return `${primarySpace.name} is quiet — jump back in or start something`;
    }
    if (pickUp.length > 0) {
      return 'Pick up where you left off — or start something new';
    }
    return 'A quiet moment — reach out, explore, or start a space';
  }, [
    liveRooms.length,
    aroundFriends.length,
    pendingRequestCount,
    primarySpace,
    pickUp.length,
  ]);

  const jumpInActions = useMemo(
    () => [
      {
        icon: MessageSquare,
        label: 'New message',
        hint: 'Start a DM',
        onClick: () => setShowDmPicker(true),
      },
      {
        icon: UserPlus,
        label: 'Add a friend',
        hint: 'By username or ID',
        onClick: () => navigate('/app/friends'),
      },
      {
        icon: Compass,
        label: 'Explore spaces',
        hint: 'Find public communities',
        onClick: () => navigate('/app/discovery'),
      },
      {
        icon: spaces.length === 0 ? Plus : FileText,
        label: spaces.length === 0 ? 'Create a space' : 'Browse templates',
        hint: spaces.length === 0 ? 'Start a new community' : 'Launch from a blueprint',
        onClick: () =>
          spaces.length === 0 ? setShowCreateModal(true) : navigate('/app/templates'),
      },
    ],
    [navigate, spaces.length],
  );

  const primaryAttn = primarySpace ? serverAttention.get(primarySpace.id) : undefined;

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-bg-primary scrollbar-thin">
      {/* Solid raised header — Fraunces greeting + meaningful status (kill-list #1). */}
      <header className="shrink-0 border-b border-border-subtle bg-bg-secondary shadow-sm">
        <div className="flex items-center gap-4 px-6 py-5 sm:px-8 sm:py-6">
          <div
            className="hidden h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-md bg-accent-tint text-xl font-bold text-accent-primary shadow-sm sm:flex"
            aria-hidden
          >
            P
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="font-display text-title text-text-primary sm:text-display">
              {greetingFor(new Date().getHours())}, {displayName(user)}
            </h1>
            <p className="mt-1.5 text-body text-text-secondary">{statusLine}</p>
            {pendingRequestCount > 0 && (
              <button
                type="button"
                onClick={() => navigate('/app/friends')}
                className="mt-2 inline-flex items-center gap-1.5 rounded-sm bg-accent-tint px-2 py-1 text-meta font-semibold text-accent-primary outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-accent-tint-strong focus-visible:shadow-[var(--focus-ring)]"
              >
                {pendingRequestCount === 1
                  ? '1 friend request waiting'
                  : `${pendingRequestCount} friend requests waiting`}
              </button>
            )}
          </div>
          <Button size="sm" className="shrink-0" onClick={() => setShowDmPicker(true)}>
            <MessageSquare size={16} />
            New message
          </Button>
        </div>
      </header>

      {/* Single stacked column — fills vertical space; no xl two-column dead half. */}
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-6 sm:px-8 sm:py-8">
        {/* (1) Happening now — omit entirely when empty. */}
        {liveRooms.length > 0 && (
          <section aria-label="Happening now">
            <HomeSectionHeader
              icon={<PhoneCall size={14} />}
              label="Happening now"
              count={liveRooms.length}
            />
            <div className="flex flex-col gap-3">
              {liveRooms.map((item) => (
                <div key={item.key} className="flex flex-col gap-1">
                  {item.contextLabel && (
                    <span className="px-0.5 text-meta text-text-muted">
                      in {item.contextLabel}
                    </span>
                  )}
                  <RoomCard
                    channel={item.channel}
                    participants={item.participants}
                    speakingUsers={speakingUsers}
                    guildId={item.guildId}
                    onJoin={() => {
                      if (!item.guildId) {
                        void joinChannel(item.channel.id, 'dm');
                        useChannelStore.getState().selectChannel(item.channel.id);
                        navigate(`/app/dms/${item.channel.id}`);
                      } else {
                        void joinChannel(item.channel.id, item.guildId);
                        navigate(
                          `/app/guilds/${item.guildId}/channels/${item.channel.id}`,
                        );
                      }
                    }}
                    onWatch={(streamerId) => {
                      useVoiceStore.getState().setWatchedStreamer(streamerId);
                      if (!item.guildId) {
                        useChannelStore.getState().selectChannel(item.channel.id);
                        navigate(`/app/dms/${item.channel.id}`);
                      } else {
                        navigate(
                          `/app/guilds/${item.guildId}/channels/${item.channel.id}`,
                        );
                      }
                    }}
                  />
                </div>
              ))}
            </div>
          </section>
        )}

        {/* (2) Around now — omit when empty. */}
        <HomeAroundStrip friends={aroundFriends} onMessage={handleMessageFriend} />

        {/* (2b) Get set up — only while the account still has open steps. */}
        <HomeSetupChecklist steps={setupSteps} />

        {/* (3) Resume the primary space — continuity must not disappear when Home is active. */}
        {primarySpace && (
          <HomeResumeHero
            space={primarySpace}
            lastChannel={primaryLastChannel}
            memberCount={primaryAttn?.memberCount}
            live={primaryAttn?.live}
            unread={primaryAttn?.unread}
            onOpenHome={() => void openSpace(primarySpace)}
            onOpenChannel={openConversation}
          />
        )}

        {/* (4) Pick up — denser continue list. */}
        {pickUp.length > 0 && (
          <section aria-label="Pick up">
            <HomeSectionHeader
              icon={<MessageSquare size={14} />}
              label="Pick up"
              count={pickUp.length}
            />
            <div className="divide-y divide-border-subtle overflow-hidden rounded-md border border-border-subtle bg-bg-secondary shadow-sm">
              {pickUp.map((entry) => (
                <HomePickUpRow
                  key={entry.key}
                  entry={entry}
                  onClick={openConversation}
                />
              ))}
            </div>
          </section>
        )}

        {/* (5) Your spaces — larger cards with member/live/unread context. */}
        <HomeServersRail
          spaces={spaces}
          attention={serverAttention}
          primaryId={primarySpace?.id}
          onOpen={(space) => void openSpace(space)}
        />

        {/* (6) Start something — useful alongside activity, not only in a zero-state. */}
        <HomeJumpInRow actions={jumpInActions} quiet={isQuiet} />

        {/* Brand-new account with nothing at all — still a composed start strip. */}
        {isQuiet && spaces.length === 0 && pickUp.length === 0 && (
          <p className="px-0.5 text-body text-text-secondary">
            When friends come online or a call starts, it lands above. Until then —
            message someone, add a friend, or explore a public space.
          </p>
        )}
      </div>

      <DmPickerModal open={showDmPicker} onClose={() => setShowDmPicker(false)} />
      {showCreateModal && <CreateGuildModal onClose={() => setShowCreateModal(false)} />}
    </div>
  );
}
