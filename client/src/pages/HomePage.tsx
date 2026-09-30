import { useFreshRelationships } from '../hooks/useFreshRelationships';
import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Plus } from 'lucide-react';

import { Button } from '../components/ui';
import { EmptyState } from '../components/ui/Feedback';
import { GlassPage, PageBar, PageScroll, PageSection } from '../components/home/GlassPage';
import { HomeAroundNow } from '../components/home/HomeAroundNow';
import { HomeComingUp } from '../components/home/HomeComingUp';
import { HomeLiveNow, liveRoomsOf } from '../components/home/HomeLiveNow';
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
import { activateConversation } from '../lib/attention/conversationNavigation';
import { accountScopeKey } from '../lib/serverScope';
import { litMembersCaption, type BuildingLight, type RoomLight } from '../lib/attention/light';
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
 * App Home: what needs you across every server, who is around, and what is
 * coming up (docs/glass-spec.md §3; docs/design/glass-plan.md §1.3, §8.4 "App Home
 * keeps DMs and friends"). The places panel beside it lists the conversations and
 * Friends; this is the pane you see when none is open.
 *
 * A calm list in the 720px column, in the order things matter: what needs you
 * (mentions, DMs waiting, friend requests), what is live (amber, with a way in),
 * who is around, what is coming up, and where you left off.
 *
 * Every light on this page comes from `useBuildingLights()`; the ranking in
 * For you comes from the unified list's own scorer. Home derives no presence,
 * invents no count, and adds no endpoint: it is a different *view* of data the
 * places panel and a server's Overview already show, which is the only way they
 * can never disagree.
 */
export function HomePage() {
  const navigate = useNavigate();
  const user = useCurrentUser();
  const nowMs = useLightClock(true, HOME_CLOCK_MS);

  const guilds = useAvailableGuilds();
  const availableScopes = useAvailableAccountScopes();
  const fetchChannels = useChannelStore((state) => state.fetchChannels);
  const acceptFriend = useRelationshipStore((state) => state.acceptFriend);

  const [showCreateModal, setShowCreateModal] = useState(false);

  useFreshRelationships();

  // The light on Home is only honest once every building's rooms AND the people
  // behind them are loaded. The places panel needs exactly the same thing, so
  // the loading lives in one hook that both surfaces mount and neither duplicates.
  useBuildingRosters();

  // ---- light ------------------------------------------------------------
  const buildings = useBuildingLights();
  const lightsOn = useLightsOnAcrossBuildings(buildings);
  const aroundNow = useAroundNow(buildings);
  const people = useMemo(() => aroundNowPeople(buildings), [buildings]);
  const liveRooms = useMemo(() => liveRoomsOf(buildings), [buildings]);
  /** Rooms with a call in them: the amber on a conversation you could pick up. */
  const litRooms = useMemo(() => new Set(liveRooms.map(({ room }) => room.key)), [liveRooms]);
  const inCall = useMemo(
    () => new Set(liveRooms.flatMap(({ room }) => room.occupants.map((occupant) => occupant.person.userId))),
    [liveRooms],
  );

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

  // The bar's line says the one thing worth knowing before you read on. It never
  // claims "nothing" while the activity behind it is still being checked.
  const waiting = attention.length + requests.length;
  const line =
    activityStatus === 'loading' && waiting === 0
      ? 'Checking for new messages…'
      : [
          waiting > 0 ? `${waiting} for you` : 'Nothing needs you',
          liveRooms.length > 0 ? `${liveRooms.length} live` : null,
        ]
          .filter(Boolean)
          .join(', ');

  const aroundShown = people.length > 0 || lightsOn > 0;

  return (
    <GlassPage label="Home">
      <PageBar title={homeGreeting(new Date(nowMs), user?.display_name || user?.username)} line={line} />

      <PageScroll>
        {guilds.length === 0 && (
          <EmptyState
            title="You are not in a server yet"
            description="Join one with an invite, or start your own. Direct messages and friends are already on the left."
            action={
              <Button onClick={() => setShowCreateModal(true)}>
                <Plus size={16} aria-hidden />
                Add a server
              </Button>
            }
          />
        )}

        <HomeNeedsYou
          entries={attention}
          requests={requests}
          status={activityStatus}
          onOpen={openConversation}
          onAccept={acceptRequest}
          onRefresh={refreshActivity}
        />

        <HomeLiveNow rooms={liveRooms} nowMs={nowMs} onOpenRoom={openRoom} onJoinRoom={joinRoom} />

        {aroundShown && (
          <PageSection kicker="Around now" list={false}>
            <HomeAroundNow
              people={people}
              // The rooms above already say where they are; the sentence would say it twice.
              sentence={liveRooms.length > 0 ? litMembersCaption(lightsOn) : aroundNow}
              lightsOn={lightsOn}
              inCall={inCall}
            />
          </PageSection>
        )}

        <HomeComingUp
          events={events}
          nowMs={nowMs}
          onSetGoing={(event, going) => void setGoing(event, going)}
        />

        <HomePickUp entries={pickUp} litRooms={litRooms} onOpen={openConversation} />
      </PageScroll>

      {showCreateModal && <CreateGuildModal onClose={() => setShowCreateModal(false)} />}
    </GlassPage>
  );
}
