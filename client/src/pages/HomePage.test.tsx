import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HomePage } from './HomePage';
import {
  buildingLight,
  personLight,
  textRoomLight,
  voiceRoomLight,
  type BuildingLight,
  type PersonLight,
  type RoomLight,
} from '../lib/attention/light';
import type { ConversationEntry } from '../lib/attention/conversationModel';
import type { ComingUpEvent } from '../components/home/useComingUp';
import { useReadStateStore } from '../stores/readStateStore';

/* -------------------------------------------------------------------------- */
/* Fixtures — real light models, so the page is tested against the same shapes  */
/* `useBuildingLights` produces (its derivation is WP1's own suite).            */
/* -------------------------------------------------------------------------- */

const SCOPE = { serverId: '__local__', userId: 'user-1' };
const NOW = new Date(2026, 8, 12, 20, 0, 0, 0).getTime();

function who(userId: string, name: string, over: Record<string, unknown> = {}): PersonLight {
  return personLight({ userId, name, status: 'online', ...over });
}
const MARA = who('m', 'Mara');
const PRIYA = who('p', 'Priya');
const REN = who('r', 'Ren');

function litBuilding(): BuildingLight {
  const room: RoomLight = voiceRoomLight({
    scope: SCOPE,
    guildId: 'guild-1',
    channelId: 'voice-1',
    name: 'Shop floor',
    occupants: [{ person: MARA, sharingScreen: true }, { person: PRIYA }],
    nowMs: NOW,
  });
  const reading: RoomLight = textRoomLight({
    scope: SCOPE,
    guildId: 'guild-1',
    channelId: 'text-1',
    name: 'build-log',
    candidates: [MARA, PRIYA, REN],
    typingUserIds: ['p'],
    nowMs: NOW,
  });
  return buildingLight({
    scope: SCOPE,
    guildId: 'guild-1',
    name: 'Kestrel Robotics',
    rooms: [room, reading],
    members: [MARA, PRIYA, REN],
    memberCount: 61,
  });
}

function quietBuilding(): BuildingLight {
  return buildingLight({
    scope: SCOPE,
    guildId: 'guild-2',
    name: 'Saltmarsh Sailing',
    rooms: [
      voiceRoomLight({
        scope: SCOPE,
        guildId: 'guild-2',
        channelId: 'voice-2',
        name: 'Clubhouse',
        occupants: [],
        nowMs: NOW,
      }),
    ],
    members: [REN],
    memberCount: 20,
  });
}

const lights = vi.hoisted(() => ({
  buildings: [] as unknown[],
  lightsOn: 0,
  sentence: "Nobody's lights are on right now",
}));
const comingUp = vi.hoisted(() => ({ events: [] as unknown[], setGoing: vi.fn() }));
const unified = vi.hoisted(() => ({
  needsYou: [] as unknown[],
  recent: [] as unknown[],
  pinned: [] as unknown[],
  spaces: [] as unknown[],
  requests: [] as unknown[],
  needsYouOverflowCount: 0,
}));
const stores = vi.hoisted(() => ({
  guilds: [] as Array<{ id: string; key: string; scope: { serverId: string; userId: string } }>,
  channelErrors: {} as Record<string, string>,
  /** Whether the stores already hold this account's rooms and members. */
  loaded: true,
  fetchChannels: vi.fn(),
  fetchMembers: vi.fn(),
  fetchRelationships: vi.fn(),
  acceptFriend: vi.fn(),
  joinChannel: vi.fn(),
  activateGuild: vi.fn(),
  activateChannel: vi.fn(),
}));

vi.mock('../hooks/useLights', () => ({
  useBuildingLights: () => lights.buildings,
  useLightsOnAcrossBuildings: () => lights.lightsOn,
  useAroundNow: () => lights.sentence,
  useLightClock: () => NOW,
}));
vi.mock('../hooks/useRoomThumbnail', () => ({
  useRoomThumbnail: () => ({ state: { live: false, reason: 'no-engine', label: 'LIVE' }, frame: null }),
}));
vi.mock('../components/home/useComingUp', () => ({
  useComingUp: () => comingUp,
  COMING_UP_CAP: 3,
}));
vi.mock('../hooks/useUnifiedConversations', () => ({ useUnifiedConversations: () => unified }));
vi.mock('../hooks/useMutedGuilds', () => ({ useMutedGuilds: () => ({ mutedGuildKeys: [] }) }));
vi.mock('../hooks/useAvailableAccountScopes', () => ({ useAvailableAccountScopes: () => [] }));
vi.mock('../hooks/useGuilds', () => ({ useAvailableGuilds: () => stores.guilds }));
vi.mock('../hooks/useVoice', () => ({ useVoice: () => ({ joinChannel: stores.joinChannel }) }));
vi.mock('../lib/guildNavigation', () => ({ activateGuild: (...a: unknown[]) => stores.activateGuild(...a) }));
vi.mock('../lib/channelNavigation', () => ({ activateChannel: (...a: unknown[]) => stores.activateChannel(...a) }));
vi.mock('../lib/operationContext', () => ({
  captureScopedOperation: () => ({
    request: () => new Promise(() => {}),
    dispose: vi.fn(),
    assertCurrent: vi.fn(),
  }),
}));
vi.mock('../components/guild/CreateGuildModal', () => ({
  CreateGuildModal: () => <div>Add a server dialog</div>,
}));
vi.mock('../stores/channelStore', () => {
  const state = {
    get errors() {
      return stores.channelErrors;
    },
    loading: {},
    guildChannelsLoaded: new Proxy({} as Record<string, boolean>, { get: () => stores.loaded }),
    fetchChannels: (...a: unknown[]) => stores.fetchChannels(...a),
  };
  return {
    useChannelStore: Object.assign(
      (selector: (s: typeof state) => unknown) => selector(state),
      { getState: () => state },
    ),
  };
});
vi.mock('../stores/memberStore', () => {
  const state = {
    loading: {},
    membersLoaded: new Proxy({} as Record<string, boolean>, { get: () => stores.loaded }),
    fetchMembers: (...a: unknown[]) => stores.fetchMembers(...a),
  };
  return {
    useMemberStore: Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
      getState: () => state,
    }),
  };
});
vi.mock('../stores/relationshipStore', () => {
  const state = {
    fetchRelationships: (...a: unknown[]) => stores.fetchRelationships(...a),
    acceptFriend: (...a: unknown[]) => stores.acceptFriend(...a),
  };
  return {
    useRelationshipStore: Object.assign(
      (selector: (s: typeof state) => unknown) => selector(state),
      { getState: () => state },
    ),
  };
});

function conversation(over: Partial<ConversationEntry> = {}): ConversationEntry {
  return {
    key: over.key ?? 'k1',
    scope: SCOPE,
    serverId: SCOPE.serverId,
    channelId: 'text-1',
    guildId: 'guild-1',
    kind: 'guild_text',
    title: 'build-log',
    contextLabel: 'Kestrel Robotics',
    lastActivityId: '900',
    unread: true,
    mentionCount: 0,
    isDMUnread: false,
    isThreadReply: false,
    hasVoiceActivity: false,
    pinned: false,
    ...over,
  };
}

function tree() {
  return (
    <MemoryRouter initialEntries={['/app']}>
      <Routes>
        <Route path="/app" element={<HomePage />} />
        <Route path="/app/guilds/:guildId" element={<div>Server route</div>} />
        <Route path="/app/guilds/:guildId/channels/:channelId" element={<div>Room route</div>} />
      </Routes>
    </MemoryRouter>
  );
}

function renderHome() {
  return render(tree());
}

beforeEach(() => {
  vi.clearAllMocks();
  useReadStateStore.setState({ byAccount: {}, loading: {}, errors: {}, attentionRevisions: {} });
  stores.loaded = true;
  lights.buildings = [];
  lights.lightsOn = 0;
  lights.sentence = "Nobody's lights are on right now";
  comingUp.events = [];
  unified.needsYou = [];
  unified.recent = [];
  unified.pinned = [];
  unified.requests = [];
  stores.guilds = [];
  stores.channelErrors = {};
});

/* -------------------------------------------------------------------------- */

describe('Home, people and conversations', () => {
  it('opens with a greeting and the current presence summary', () => {
    lights.buildings = [litBuilding(), quietBuilding()];
    lights.lightsOn = 30;
    renderHome();
    expect(screen.getByRole('heading', { name: 'Evening' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Around now' })).toHaveTextContent(lights.sentence);
  });

  it('keeps the shared presence summary above the named voice cards', () => {
    lights.buildings = [litBuilding()];
    lights.lightsOn = 9;
    lights.sentence = 'Mara and Priya are in Shop floor';
    renderHome();
    const well = screen.getByRole('region', { name: 'Around now' });
    expect(within(well).getByText('Mara and Priya are in Shop floor')).toBeInTheDocument();
    expect(within(well).queryByText(/lights on/)).not.toBeInTheDocument();
  });

  it('draws each server in the order the light hook gave them', () => {
    lights.buildings = [litBuilding(), quietBuilding()];
    renderHome();
    expect(screen.getByRole('article', { name: 'Kestrel Robotics' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Saltmarsh Sailing' })).toBeInTheDocument();
    const servers = screen.getByRole('region', { name: 'Your servers' });
    expect(within(servers).getByRole('article', { name: 'Kestrel Robotics' }).compareDocumentPosition(
      within(servers).getByRole('group', { name: 'Saltmarsh Sailing' }),
    ) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('joins a lit room in the room it is showing, not the server', async () => {
    lights.buildings = [litBuilding()];
    renderHome();
    await userEvent.click(screen.getByRole('button', { name: 'Join voice' }));
    expect(stores.activateChannel).toHaveBeenCalledWith({ scope: SCOPE, id: 'voice-1' });
    expect(stores.joinChannel).toHaveBeenCalledWith('voice-1', 'guild-1');
    expect(await screen.findByText('Room route')).toBeInTheDocument();
  });

  it('opens a server from its name', async () => {
    lights.buildings = [quietBuilding()];
    renderHome();
    await userEvent.click(screen.getByRole('button', { name: 'Saltmarsh Sailing' }));
    expect(stores.activateGuild).toHaveBeenCalledWith({ scope: SCOPE, id: 'guild-2' });
    expect(await screen.findByText('Server route')).toBeInTheDocument();
  });

  it('always offers a way in, and opens the join-or-create dialog', async () => {
    renderHome();
    const add = screen.getByRole('button', {
      name: 'Add a server — join with an invite, or start your own',
    });
    await userEvent.click(add);
    expect(screen.getByText('Add a server dialog')).toBeInTheDocument();
  });

  it('loads the rooms and people of every server it has not got, once', () => {
    stores.loaded = false;
    stores.guilds = [
      { id: 'guild-1', key: 'k1', scope: SCOPE },
      { id: 'guild-2', key: 'k2', scope: SCOPE },
    ];
    const { rerender } = renderHome();
    rerender(tree());
    expect(stores.fetchChannels).toHaveBeenCalledTimes(2);
    expect(stores.fetchMembers).toHaveBeenCalledTimes(2);
  });

  it('asks for nothing it already has', () => {
    stores.guilds = [{ id: 'guild-1', key: 'k1', scope: SCOPE }];
    renderHome();
    expect(stores.fetchChannels).not.toHaveBeenCalled();
    expect(stores.fetchMembers).not.toHaveBeenCalled();
  });
});

describe('Coming up on Home', () => {
  const event: ComingUpEvent = {
    key: 'e',
    buildingKey: 'k1',
    scope: SCOPE,
    guildId: 'guild-1',
    buildingName: 'Kestrel Robotics',
    id: 'e1',
    name: 'Thermal test — driver v3',
    startsAtMs: new Date(2026, 8, 12, 21, 0, 0, 0).getTime(),
    roomName: 'Shop floor',
    location: null,
    going: 6,
    rsvp: false,
  };

  it('shows scheduled events from across the servers', () => {
    lights.buildings = [litBuilding()];
    comingUp.events = [event];
    renderHome();
    const section = screen.getByRole('region', { name: 'Coming up' });
    expect(within(section).getByText('Thermal test — driver v3')).toBeInTheDocument();
    expect(
      within(section).getByText('Kestrel Robotics · Shop floor · 6 going'),
    ).toBeInTheDocument();
  });

  it('omits the section entirely when nothing is scheduled', () => {
    lights.buildings = [litBuilding()];
    renderHome();
    expect(screen.queryByRole('region', { name: 'Coming up' })).not.toBeInTheDocument();
  });
});

describe('For you and Pick up', () => {
  it('ranks direct attention, accepts a friend request, and never repeats a row in Pick up', async () => {
    unified.needsYou = [conversation({ key: 'mention', mentionCount: 2 })];
    unified.recent = [
      conversation({ key: 'mention', mentionCount: 2 }),
      conversation({ key: 'quiet', channelId: 'text-9', title: 'regatta-2026', unread: false }),
    ];
    unified.requests = [
      { key: 'request:9', userId: '9', username: 'Devon Park', createdMs: NOW - 3_600_000 },
    ];
    renderHome();

    const needs = screen.getByRole('region', { name: 'For you' });
    expect(within(needs).getByText('Devon Park')).toBeInTheDocument();
    expect(within(needs).getByText('2 mentions for you')).toBeInTheDocument();

    const pickUp = screen.getByRole('region', { name: 'Pick up the conversation' });
    expect(within(pickUp).getByText('regatta-2026')).toBeInTheDocument();
    expect(within(pickUp).queryByText(/mention/)).not.toBeInTheDocument();

    await userEvent.click(
      screen.getByRole('button', { name: "Accept Devon Park's friend request" }),
    );
    expect(stores.acceptFriend).toHaveBeenCalledWith('9');
  });

  it('never says nothing needs you while a server’s rooms failed to load', () => {
    stores.guilds = [{ id: 'guild-1', key: 'k1', scope: SCOPE }];
    stores.channelErrors = { k1: 'offline' };
    renderHome();
    expect(screen.getByText(/Some activity could not be checked/)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing new for you/)).not.toBeInTheDocument();
  });

  it('says nothing is waiting only once it knows', () => {
    renderHome();
    expect(screen.getByText('Nothing new for you right now.')).toBeInTheDocument();
    expect(screen.queryByText(/No data|It's quiet/)).not.toBeInTheDocument();
  });

  it('keeps casual unread conversations visible without turning them into direct attention', () => {
    const casual = conversation({ key: 'casual', channelId: 'text-9', title: 'music' });
    unified.needsYou = [casual, conversation({ key: 'mention', mentionCount: 1 })];
    unified.pinned = [casual];
    lights.buildings = [litBuilding()];
    renderHome();
    const direct = screen.getByRole('region', { name: 'For you' });
    const pickUp = screen.getByRole('region', { name: 'Pick up the conversation' });
    expect(within(direct).queryByRole('button', { name: 'Open music' })).not.toBeInTheDocument();
    expect(within(pickUp).getAllByRole('button', { name: 'Open music' })).toHaveLength(1);
    const servers = screen.getByRole('region', { name: 'Your servers' });
    expect(servers.compareDocumentPosition(pickUp) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(pickUp.compareDocumentPosition(direct) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
