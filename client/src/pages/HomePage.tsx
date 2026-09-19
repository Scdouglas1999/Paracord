import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';

import { SectionLabel } from '../components/ui';
import { HomeAddBuilding } from '../components/home/HomeAddBuilding';
import { HomeAroundNow } from '../components/home/HomeAroundNow';
import { HomeBuildingCard } from '../components/home/HomeBuildingCard';
import { HomeComingUp } from '../components/home/HomeComingUp';
import { HomeNeedsYou, homeAttention, type NeedsYouStatus } from '../components/home/HomeNeedsYou';
import { HomePickUp } from '../components/home/HomePickUp';
import { aroundNowPeople } from '../components/home/homeModel';
import { homeGreeting } from '../components/home/timeOfDay';
import { useComingUp } from '../components/home/useComingUp';
import { CreateGuildModal } from '../components/guild/CreateGuildModal';

import { useAvailableAccountScopes } from '../hooks/useAvailableAccountScopes';
import { useCurrentUser } from '../hooks/useCurrentUser';
import { useAvailableGuilds } from '../hooks/useGuilds';
import { useBuildingRosters } from '../hooks/useBuildingRosters';
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
import { snowflakeToMs, type ConversationEntry } from '../lib/attention/conversationModel';
import { useChannelStore } from '../stores/channelStore';
import { useReadStateStore } from '../stores/readStateStore';
import { useRelationshipStore } from '../stores/relationshipStore';
import { toast } from '../stores/toastStore';

/** A short set of conversations leaves room for the people here now. */
const PICK_UP_CAP = 6;
/** Home's own clock: the title word and "Today 1:00 pm" only move by the minute. */
const HOME_CLOCK_MS = 60_000;

/**
 * Home puts people and their servers first, then conversations to return to.
 * Direct attention and upcoming events sit alongside those conversations.
 *
 * Every light on this page comes from `useBuildingLights()`; the ranking in
 * Needs-you comes from the unified list's own scorer. Home derives no presence,
 * invents no count, and adds no endpoint: it is a different *view* of data the
 * sidebar and the Lobby already show, which is the only way the two can never
 * disagree.
 */
export function HomePage() {
  const navigate = useNavigate();
  const user = useCurrentUser();
  const nowMs = useLightClock(true, HOME_CLOCK_MS);

  const guilds = useAvailableGuilds();
  const availableScopes = useAvailableAccountScopes();
  const fetchChannels = useChannelStore((state) => state.fetchChannels);
  const fetchRelationships = useRelationshipStore((state) => state.fetchRelationships);
  const acceptFriend = useRelationshipStore((state) => state.acceptFriend);

  const [showCreateModal, setShowCreateModal] = useState(false);

  useEffect(() => {
    void fetchRelationships();
  }, [fetchRelationships]);

  // The light on Home is only honest once every building's rooms AND the people
  // behind them are loaded. The sidebar needs exactly the same thing, so the
  // loading lives in one hook that both surfaces mount and neither duplicates.
  useBuildingRosters();

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
    const conversations = new Map([...needsYou, ...pinned, ...recent].map((entry) => [entry.key, entry]));
    return [...conversations.values()]
      .filter((entry) => entry.lastActivityId && !claimed.has(entry.key))
      .sort((a, b) =>
        snowflakeToMs(b.lastActivityId!) - snowflakeToMs(a.lastActivityId!) || a.key.localeCompare(b.key),
      )
      .slice(0, PICK_UP_CAP);
  }, [needsYou, pinned, recent, attention]);

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

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-7 px-4 py-6 sm:px-8 sm:py-8">
        <header className="flex min-w-0 flex-col gap-3">
          <h1 className="pc-display break-words text-display font-bold text-text-primary">
            {homeGreeting(new Date(nowMs), user?.display_name || user?.username)}
          </h1>
          <HomeAroundNow
            people={people}
            sentence={aroundNow}
            lightsOn={lightsOn}
            showFaces={!buildings.some((building) => building.brightestRoom)}
          />
        </header>

        <section aria-label="Your servers" className="flex min-w-0 flex-col gap-3">
          <SectionLabel className="px-0 pb-0 pt-0">Your servers</SectionLabel>
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
          <HomeAddBuilding onClick={() => setShowCreateModal(true)} />
        </section>

        <div className={cn('grid min-w-0 grid-cols-1 gap-7 lg:gap-8', pickUp.length > 0 && 'lg:grid-cols-[minmax(0,1fr)_300px]')}>
          <HomePickUp entries={pickUp} litRooms={litRooms} onOpen={openConversation} />
          <div className={cn(
            'flex min-w-0 flex-col gap-6',
            pickUp.length > 0 && 'border-t border-border-subtle pt-6 lg:col-start-2 lg:border-l lg:border-t-0 lg:pl-7 lg:pt-0',
          )}>
            <HomeNeedsYou
              entries={attention}
              requests={requests}
              status={activityStatus}
              onOpen={openConversation}
              onAccept={acceptRequest}
              onRefresh={refreshActivity}
            />
            <HomeComingUp
              events={events}
              nowMs={nowMs}
              onSetGoing={(event, going) => void setGoing(event, going)}
            />
          </div>
        </div>
      </div>

      {showCreateModal && <CreateGuildModal onClose={() => setShowCreateModal(false)} />}
    </div>
  );
}
