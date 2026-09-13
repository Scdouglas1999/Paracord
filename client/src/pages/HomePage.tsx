import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';

import { SectionLabel } from '../components/ui';
import { HomeAddBuilding } from '../components/home/HomeAddBuilding';
import { HomeAroundNow } from '../components/home/HomeAroundNow';
import { HomeBuildingCard } from '../components/home/HomeBuildingCard';
import { HomeComingUp } from '../components/home/HomeComingUp';
import { HomeNeedsYou, homeAttention, type NeedsYouStatus } from '../components/home/HomeNeedsYou';
import { HomePickUp } from '../components/home/HomePickUp';
import { aroundNowPeople } from '../components/home/homeModel';
import { homeSentence, timeOfDayWord } from '../components/home/timeOfDay';
import { useComingUp } from '../components/home/useComingUp';
import { CreateGuildModal } from '../components/guild/CreateGuildModal';

import { useAvailableAccountScopes } from '../hooks/useAvailableAccountScopes';
import { useAvailableGuilds } from '../hooks/useGuilds';
import {
  useAroundNow,
  useBuildingLights,
  useLightClock,
  useLightsOnAcrossBuildings,
} from '../hooks/useLights';
import { useMutedGuilds } from '../hooks/useMutedGuilds';
import { useUnifiedConversations } from '../hooks/useUnifiedConversations';
import { useVoice } from '../hooks/useVoice';

import { extractApiError } from '../api/client';
import { activateChannel } from '../lib/channelNavigation';
import { activateGuild } from '../lib/guildNavigation';
import { activateConversation } from '../lib/attention/conversationNavigation';
import { accountScopeKey } from '../lib/serverScope';
import { cn } from '../lib/utils';
import type { BuildingLight, RoomLight } from '../lib/attention/light';
import type { ConversationEntry } from '../lib/attention/conversationModel';
import { useChannelStore } from '../stores/channelStore';
import { useMemberStore } from '../stores/memberStore';
import { useReadStateStore } from '../stores/readStateStore';
import { useRelationshipStore } from '../stores/relationshipStore';
import { toast } from '../stores/toastStore';

/** The right column is a shortlist; the buildings column carries the rest. */
const PICK_UP_CAP = 6;
/** Home's own clock: the title word and "Today 1:00 pm" only move by the minute. */
const HOME_CLOCK_MS = 60_000;

/**
 * App Home — the street outside your buildings (docs/lantern-stage-spec.md §7.5).
 *
 * Title, one sentence of fact, the Around-now well, **your buildings brightest
 * first**, what is coming up, and — down the right — what needs you and what
 * you can pick back up.
 *
 * Every light on this page comes from `useBuildingLights()`; the ranking in
 * Needs-you comes from the unified list's own scorer. Home derives no presence,
 * invents no count, and adds no endpoint: it is a different *view* of data the
 * sidebar and the Lobby already show, which is the only way the two can never
 * disagree.
 */
export function HomePage() {
  const navigate = useNavigate();
  const nowMs = useLightClock(true, HOME_CLOCK_MS);

  const guilds = useAvailableGuilds();
  const availableScopes = useAvailableAccountScopes();
  const fetchChannels = useChannelStore((state) => state.fetchChannels);
  const fetchMembers = useMemberStore((state) => state.fetchMembers);
  const fetchRelationships = useRelationshipStore((state) => state.fetchRelationships);
  const acceptFriend = useRelationshipStore((state) => state.acceptFriend);
  const loadedGuildsRef = useRef<Set<string>>(new Set());

  const [showCreateModal, setShowCreateModal] = useState(false);

  useEffect(() => {
    void fetchRelationships();
  }, [fetchRelationships]);

  useEffect(() => {
    // Once per building, ever. A new `guilds` array identity (a presence tick,
    // say) must not refetch every guild — and the light on Home is only honest
    // once the rooms AND the people behind them are loaded.
    guilds.forEach((guild) => {
      if (loadedGuildsRef.current.has(guild.key)) return;
      loadedGuildsRef.current.add(guild.key);
      void fetchChannels(guild.id, guild.scope);
      void fetchMembers(guild.id, guild.scope);
    });
  }, [guilds, fetchChannels, fetchMembers]);

  // ---- light ------------------------------------------------------------
  const buildings = useBuildingLights();
  const lightsOn = useLightsOnAcrossBuildings(buildings);
  const aroundNow = useAroundNow(buildings);
  const people = useMemo(() => aroundNowPeople(buildings), [buildings]);
  const litRooms = useMemo(() => {
    const keys = new Set<string>();
    for (const building of buildings) {
      for (const room of building.rooms) if (room.lit) keys.add(room.key);
    }
    return keys;
  }, [buildings]);

  // ---- attention --------------------------------------------------------
  const { mutedGuildKeys } = useMutedGuilds();
  const { recent, needsYou, pinned, requests } = useUnifiedConversations(mutedGuildKeys);
  const attention = useMemo(
    () => homeAttention([...needsYou, ...pinned, ...recent]),
    [needsYou, pinned, recent],
  );
  const pickUp = useMemo(() => {
    const claimed = new Set(attention.map((entry) => entry.key));
    return recent.filter((entry) => entry.lastActivityId && !claimed.has(entry.key)).slice(0, PICK_UP_CAP);
  }, [recent, attention]);

  /** Mentions by room key, so a building's text rooms can say "1 mention for you". */
  const mentions = useMemo(() => {
    const map = new Map<string, number>();
    for (const entry of [...attention, ...recent]) {
      if (entry.mentionCount > 0) map.set(entry.key, entry.mentionCount);
    }
    return map;
  }, [attention, recent]);

  const readActivityStatus = useReadStateStore((state) => {
    const keys = availableScopes.map(accountScopeKey);
    if (keys.some((key) => state.errors[key])) return 'error';
    if (
      keys.some(
        (key) =>
          state.loading[key] || !Object.prototype.hasOwnProperty.call(state.byAccount, key),
      )
    ) {
      return 'loading';
    }
    return 'ready';
  });
  const channelActivityStatus = useChannelStore((state) => {
    if (guilds.some((guild) => state.errors[guild.key])) return 'error';
    if (guilds.some((guild) => state.loading[guild.key] || !state.guildChannelsLoaded[guild.key])) {
      return 'loading';
    }
    return 'ready';
  });
  const activityStatus: NeedsYouStatus =
    readActivityStatus === 'error' || channelActivityStatus === 'error'
      ? 'error'
      : readActivityStatus === 'loading' || channelActivityStatus === 'loading'
        ? 'loading'
        : 'ready';

  // ---- coming up --------------------------------------------------------
  const { events, setGoing } = useComingUp(buildings, nowMs);

  // ---- actions ----------------------------------------------------------
  const { joinChannel } = useVoice();

  const openBuilding = useCallback(
    (building: BuildingLight) => {
      try {
        activateGuild({ scope: building.scope, id: building.guildId });
        navigate(`/app/guilds/${building.guildId}`);
      } catch (error) {
        toast.error(`Could not open ${building.name}: ${extractApiError(error)}`);
      }
    },
    [navigate],
  );

  const openRoom = useCallback(
    (building: BuildingLight, room: RoomLight) => {
      try {
        activateChannel({ scope: room.scope, id: room.channelId });
        navigate(`/app/guilds/${building.guildId}/channels/${room.channelId}`);
      } catch (error) {
        toast.error(`Could not open ${room.name}: ${extractApiError(error)}`);
      }
    },
    [navigate],
  );

  const joinRoom = useCallback(
    (building: BuildingLight, room: RoomLight) => {
      try {
        activateChannel({ scope: room.scope, id: room.channelId });
        void joinChannel(room.channelId, building.guildId);
        navigate(`/app/guilds/${building.guildId}/channels/${room.channelId}`);
      } catch (error) {
        toast.error(`Could not join ${room.name}: ${extractApiError(error)}`);
      }
    },
    [joinChannel, navigate],
  );

  const openConversation = useCallback(
    (entry: ConversationEntry, messageId?: string) => {
      try {
        navigate(
          activateConversation(entry) +
            (messageId ? `?message=${encodeURIComponent(messageId)}` : ''),
        );
      } catch (error) {
        toast.error(`Failed to open conversation: ${extractApiError(error)}`);
      }
    },
    [navigate],
  );

  const acceptRequest = useCallback(
    (userId: string) => {
      void (async () => {
        try {
          await acceptFriend(userId);
        } catch (error) {
          toast.error(`Could not accept the request: ${extractApiError(error)}`);
        }
      })();
    },
    [acceptFriend],
  );

  const refreshActivity = useCallback(() => {
    void Promise.allSettled([
      useReadStateStore.getState().refreshAll(),
      ...guilds.map((guild) => fetchChannels(guild.id, guild.scope)),
    ]);
  }, [guilds, fetchChannels]);

  const needsYouFirst = attention.length + requests.length > 0;

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-5 px-4 py-5 sm:px-7 sm:py-6">
        <header className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1">
          <h1 className="pc-display text-display font-bold text-text-primary">
            {timeOfDayWord(new Date(nowMs))}
          </h1>
          <p className="min-w-0 text-[13px] text-text-faint">
            {homeSentence(new Date(nowMs), lightsOn, buildings.length)}
          </p>
        </header>

        <HomeAroundNow people={people} sentence={aroundNow} lightsOn={lightsOn} />

        <div className="grid min-w-0 grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
          {/* Your buildings — brightest first (§7.1 ordering, §7.5 presentation). */}
          <div className="order-2 flex min-w-0 flex-col gap-3 lg:order-1">
            <SectionLabel
              className="px-0 pb-0.5 pt-0"
              meta={buildings.length > 1 ? 'brightest first' : undefined}
            >
              Your buildings
            </SectionLabel>
            {buildings.map((building) => (
              <HomeBuildingCard
                key={building.key}
                building={building}
                mentions={mentions}
                onOpenBuilding={openBuilding}
                onOpenRoom={openRoom}
                onJoinRoom={joinRoom}
              />
            ))}
            <HomeComingUp
              events={events}
              nowMs={nowMs}
              onSetGoing={(event, going) => void setGoing(event, going)}
            />
            <HomeAddBuilding onClick={() => setShowCreateModal(true)} />
          </div>

          {/*
            Needs you + Pick up.

            On a phone the column dissolves (`display: contents`) so its two
            blocks take their own place in the single column: work somebody is
            waiting on you for leads, then the buildings, then what you can
            pick back up (§6, layout-spec §6). On a wide viewport it is one
            right-hand column again, and the same two order values keep the
            blocks in the same sequence inside it.
          */}
          <div className="contents lg:order-2 lg:flex lg:min-w-0 lg:flex-col lg:gap-4">
            <div className={cn('min-w-0', needsYouFirst ? 'order-1' : 'order-3')}>
              <HomeNeedsYou
                entries={attention}
                requests={requests}
                status={activityStatus}
                onOpen={openConversation}
                onAccept={acceptRequest}
                onRefresh={refreshActivity}
              />
            </div>
            <div className="order-4 min-w-0">
              <HomePickUp entries={pickUp} litRooms={litRooms} onOpen={openConversation} />
            </div>
          </div>
        </div>
      </div>

      {showCreateModal && <CreateGuildModal onClose={() => setShowCreateModal(false)} />}
    </div>
  );
}
