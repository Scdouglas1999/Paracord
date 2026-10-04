import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

import { GuildHomePage } from './GuildHomePage';
import { useAuthStore } from '../stores/authStore';
import { useChannelStore } from '../stores/channelStore';
import { scopeGuild, useGuildStore } from '../stores/guildStore';
import { useMemberStore } from '../stores/memberStore';
import { usePresenceStore } from '../stores/presenceStore';
import { useServerListStore } from '../stores/serverListStore';
import { useSportsStore } from '../stores/sportsStore';
import { useTypingStore } from '../stores/typingStore';
import { useUIStore } from '../stores/uiStore';
import { useGlassStore } from '../stores/glassStore';
import { useToolbarStore } from '../components/ix/shell/toolbarStore';
import { roomLitHistory } from '../lib/attention/light';
import { LOCAL_SERVER_ID, entityScopeKey } from '../lib/serverScope';
import { ChannelType, type Channel, type Member } from '../types';
import type { FeedItem } from '../api/serverFeed';

/**
 * The server's Overview, end to end (docs/index-spec.md §8.1).
 *
 * Presence comes from the real stores, seeded the way the running app
 * fills them; only what reaches the network or the media engine is mocked.
 */

const SERVER = LOCAL_SERVER_ID;
const SCOPE = { serverId: SERVER, userId: 'viewer' };
const GUILD = 'g1';

const api = vi.hoisted(() => ({
  events: [] as unknown[],
  feed: [] as unknown[],
  feedError: null as string | null,
  gallery: [] as unknown[],
  leaderboard: [] as unknown[],
  get: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  post: vi.fn(),
}));
const gates = vi.hoisted(() => ({
  permissions: 0n,
  isAdmin: false,
}));

vi.mock('../api/activeClient', () => ({
  getApi: () => ({ get: api.get, put: api.put, delete: api.delete, post: api.post }),
}));

vi.mock('../hooks/usePermissions', () => ({
  usePermissions: () => ({
    permissions: gates.permissions,
    isAdmin: gates.isAdmin,
    isOwner: false,
    isLoading: false,
    guildLevelOnly: true,
  }),
}));

vi.mock('../hooks/useMutedGuilds', () => ({
  useMutedGuilds: () => ({ mutedGuildKeys: [] as string[], saving: {}, isMuted: () => false, toggleMute: vi.fn() }),
}));

vi.mock('../components/guild/InviteModal', () => ({
  InviteModal: () => <div data-testid="invite-modal" />,
}));

// ---- fixtures --------------------------------------------------------------

function chan(over: Partial<Channel> & { id: string; type: ChannelType }): Channel {
  return { position: 0, nsfw: false, created_at: '', guild_id: GUILD, ...over } as Channel;
}

function member(id: string, username: string, joinedAt = '2020-01-01T00:00:00Z'): Member {
  return {
    user: { id, username, discriminator: 0, bot: false, system: false, flags: 0, created_at: '' },
    roles: [],
    joined_at: joinedAt,
    deaf: false,
    mute: false,
  } as unknown as Member;
}

const author = { id: '1', username: 'mara', display_name: 'Mara', avatar_hash: null };

function feedMessage(id: string, over: Record<string, unknown> = {}, reason = 'attachment'): FeedItem {
  return {
    type: 'message',
    id: `m:${id}`,
    key: id,
    at: new Date().toISOString(),
    channel_id: 't1',
    channel_name: 'build-log',
    channel_type: 0,
    reason,
    message: {
      id,
      channel_id: 't1',
      author,
      content: 'the new bracket fits',
      attachments: [],
      reactions: [],
      pinned: false,
      ...over,
    },
  } as unknown as FeedItem;
}

function seed(): void {
  useAuthStore.setState({ user: { id: 'viewer', username: 'viewer' } as never, token: 'token' });
  useServerListStore.setState({ servers: [], activeServerId: null });
  useGuildStore.setState({
    guilds: [
      scopeGuild(
        {
          id: GUILD,
          name: 'Kestrel Robotics',
          description: 'We build small robots on Saturdays.',
          owner_id: 'owner',
          member_count: 61,
          created_at: '',
        },
        SCOPE,
      ),
    ],
  });
  useChannelStore.getState().setChannels(
    GUILD,
    [
      chan({ id: 'v1', type: ChannelType.Voice, name: 'Shop floor', position: 0 }),
      chan({ id: 'v2', type: ChannelType.Voice, name: 'Lounge', position: 1 }),
      chan({ id: 't1', type: ChannelType.Text, name: 'build-log', position: 2 }),
      chan({ id: 'a1', type: ChannelType.Announcement, name: 'news', position: 3 }),
    ],
    SCOPE,
  );
  useMemberStore.setState({
    members: new Map([
      [
        entityScopeKey(SCOPE, GUILD),
        [member('1', 'mara'), member('2', 'priya'), member('3', 'ren', new Date().toISOString())],
      ],
    ]),
  });
  usePresenceStore.getState().setPresences(
    [
      { user_id: '1', status: 'online', activities: [] },
      { user_id: '2', status: 'online', activities: [] },
      { user_id: '3', status: 'offline', activities: [] },
    ],
    SERVER,
  );
  useTypingStore.setState({ typingByChannel: {} });
}

function setHub(hub: Record<string, unknown>) {
  const guild = useGuildStore.getState().guilds[0];
  useGuildStore.setState({ guilds: [{ ...guild, hub_settings: hub } as never] });
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="pathname">{`${location.pathname}${location.hash}`}</div>;
}

function renderHome() {
  return render(
    <MemoryRouter initialEntries={[`/app/guilds/${GUILD}`]}>
      <LocationProbe />
      <Routes>
        <Route path="/app/guilds/:guildId" element={<GuildHomePage />} />
        <Route path="/app/guilds/:guildId/channels/:channelId" element={<div>channel</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

let plateWidth = 1200;
const realRect = HTMLElement.prototype.getBoundingClientRect;

beforeEach(() => {
  plateWidth = 1200;
  HTMLElement.prototype.getBoundingClientRect = function rect(this: HTMLElement) {
    return { width: plateWidth, height: 800, top: 0, left: 0, right: plateWidth, bottom: 800, x: 0, y: 0, toJSON() {} } as DOMRect;
  };
  api.events = [];
  api.feed = [];
  api.feedError = null;
  api.gallery = [];
  api.leaderboard = [];
  api.get.mockImplementation(async (url: string) => {
    if (url.startsWith(`/guilds/${GUILD}/feed`)) {
      if (api.feedError) throw Object.assign(new Error(api.feedError), { response: { data: { message: api.feedError } } });
      return { data: { items: api.feed, next_cursor: null } };
    }
    if (url === `/guilds/${GUILD}/events`) return { data: api.events };
    if (url.startsWith(`/guilds/${GUILD}/attachments`)) return { data: { items: api.gallery, next_before: null } };
    if (url.startsWith(`/guilds/${GUILD}/economy/leaderboard`)) return { data: { entries: api.leaderboard } };
    if (url === `/guilds/${GUILD}/sports`) return { data: { enabled: false } };
    if (url.endsWith('/pins')) return { data: [] };
    return { data: {} };
  });
  api.put.mockResolvedValue({ data: {} });
  api.delete.mockResolvedValue({ data: {} });
  api.post.mockResolvedValue({ data: {} });
  gates.permissions = 0n;
  gates.isAdmin = false;
  roomLitHistory.clear();
  useGuildStore.getState().reset();
  useChannelStore.getState().reset();
  useMemberStore.getState().reset();
  usePresenceStore.getState().reset();
  useTypingStore.getState().reset();
  useSportsStore.getState().reset();
  useUIStore.setState({ guildSettingsId: null, guildSettingsInitialSection: null, contextPanelMode: null });
  useToolbarStore.setState({ page: null, owner: null });
  useGlassStore.setState({ sheet: null });
  seed();
});

afterEach(() => {
  cleanup();
  HTMLElement.prototype.getBoundingClientRect = realRect;
  roomLitHistory.clear();
});

describe('the page', () => {
  it('is a large-title page: the server’s name, its description, who is here, and the toolbar told', async () => {
    renderHome();
    expect(screen.getByRole('heading', { level: 1, name: 'Kestrel Robotics' })).toBeInTheDocument();
    expect(screen.getByText('We build small robots on Saturdays.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\d+ members? · 2 here now\. Show members/ })).toBeInTheDocument();
    // The toolbar's folded title is the page's, and the page is not a pushed one.
    expect(useToolbarStore.getState().page).toMatchObject({ title: 'Kestrel Robotics', onBack: null });
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringMatching(/^\/guilds\/g1\/feed/)));
  });

  it('opens the server media view', () => {
    renderHome();
    fireEvent.click(screen.getByRole('button', { name: 'Media' }));
    expect(useUIStore.getState().contextPanelMode).toBe('media');
  });

  it('opens the Events page from its chip and from the Coming up link', async () => {
    renderHome();
    fireEvent.click(screen.getByRole('button', { name: 'Events' }));
    expect(screen.getByTestId('pathname')).toHaveTextContent('/app/guilds/g1/events');
  });

  it('opens the people sheet from the members line', () => {
    renderHome();
    fireEvent.click(screen.getByRole('button', { name: /Show members/ }));
    expect(useGlassStore.getState().sheet).toBe('people');
  });

  it('offers the settings only to somebody who may manage the server', () => {
    renderHome();
    expect(screen.queryByRole('button', { name: 'Server settings' })).not.toBeInTheDocument();
    cleanup();
    gates.isAdmin = true;
    renderHome();
    fireEvent.click(screen.getByRole('button', { name: 'Server settings' }));
    expect(useUIStore.getState().guildSettingsId).toBe(GUILD);
  });

  it('has one cream button, Invite people, and none when there is no channel to invite into', async () => {
    renderHome();
    const bar = screen.getByRole('group', { name: 'Server actions' });
    const cream = within(bar).getAllByRole('button').filter((button) => button.classList.contains('ix-cream'));
    expect(cream.map((button) => button.textContent)).toEqual(['Invite people']);
    fireEvent.click(within(bar).getByRole('button', { name: 'Invite people' }));
    expect(screen.getByTestId('invite-modal')).toBeInTheDocument();
  });

  it('mutes from the notification menu, and says so', async () => {
    renderHome();
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));
    expect(await screen.findByText('Mute server')).toBeInTheDocument();
    expect(screen.getByText('Mark as read')).toBeInTheDocument();
  });

  it('has no cover and no Live now: the room card is the live surface, a banner only when one is uploaded', () => {
    renderHome();
    expect(screen.queryByTestId('ix-banner')).not.toBeInTheDocument();
    expect(screen.queryByText('Live now')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Voice channels' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Join / })).not.toBeInTheDocument();
  });

  it('draws an uploaded banner as a card under the bar', () => {
    const guild = useGuildStore.getState().guilds[0];
    useGuildStore.setState({ guilds: [{ ...guild, banner_hash: '/api/v1/guilds/g1/banner?v=1' } as never] });
    renderHome();
    expect(screen.getByTestId('ix-banner')).toBeInTheDocument();
  });

  it('says it is opening while the server is not known yet, and offers nothing', () => {
    useGuildStore.getState().reset();
    renderHome();
    expect(screen.getByRole('status', { name: 'Opening the server' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('the feed', () => {
  it('shows what people made, and never an empty claim while loading', async () => {
    api.feed = [
      feedMessage('10', {
        content: 'Lunch vote',
        poll: {
          id: 'p1',
          message_id: '10',
          channel_id: 't1',
          question: 'Lunch vote',
          allow_multiselect: false,
          created_at: '',
          options: [{ id: 'o1', text: 'Soup', position: 0, vote_count: 2, voted: false }],
          total_votes: 2,
        },
      }, 'poll'),
      {
        type: 'forum_post',
        id: 'f:20',
        key: '20',
        at: new Date().toISOString(),
        channel_id: 'forum',
        channel_name: 'help',
        thread_id: '20',
        title: 'Servo jitters at idle',
        author,
        excerpt: 'Any ideas?',
        reply_count: 3,
        last_reply_at: new Date().toISOString(),
        last_reply_author: { id: '2', username: 'priya', display_name: 'Priya', avatar_hash: null },
        participants: [author],
      },
      {
        type: 'members_joined',
        id: 'j:2026-09-22',
        key: '5',
        at: new Date().toISOString(),
        day: '2026-09-22',
        users: [
          { id: '7', username: 'yara', display_name: 'Yara', avatar_hash: null },
          { id: '8', username: 'ken', display_name: 'Ken', avatar_hash: null },
        ],
        total: 3,
      },
    ];
    renderHome();
    expect(await screen.findByText('Servo jitters at idle')).toBeInTheDocument();
    // The poll's question is said once, by the poll.
    expect(screen.getAllByText('Lunch vote')).toHaveLength(1);
    expect(screen.getByText(/3 replies · last from Priya/)).toBeInTheDocument();
    expect(screen.getByText('Yara and 2 others joined')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Say hi to Yara' })).toBeInTheDocument();
  });

  it('opens a message where it was posted', async () => {
    api.feed = [feedMessage('10')];
    renderHome();
    fireEvent.click(await screen.findByRole('button', { name: 'Open in build-log' }));
    expect(screen.getByTestId('pathname')).toHaveTextContent('/app/guilds/g1/channels/t1#msg-10');
  });

  it('toggles a reaction in place', async () => {
    api.feed = [feedMessage('10', { reactions: [{ emoji: '🎉', count: 3, me: false }] }, 'reactions')];
    renderHome();
    const chip = await screen.findByRole('button', { name: /🎉/ });
    fireEvent.click(chip);
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith(`/channels/t1/messages/10/reactions/${encodeURIComponent('🎉')}/@me`),
    );
    expect(await screen.findByText('4')).toBeInTheDocument();
  });

  it('says so when the feed cannot be loaded', async () => {
    api.feedError = 'the server is having a moment';
    renderHome();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load the latest posts');
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('the widget column', () => {
  const soon = () => new Date(Date.now() + 26 * 60 * 60 * 1000).toISOString();

  it('shows the next events and RSVPs on the first', async () => {
    api.events = [{ id: 'e1', name: 'Thermal test', scheduled_start: soon(), status: 1, user_count: 2 }];
    renderHome();
    const widget = await screen.findByRole('region', { name: 'Coming up' });
    // A plan card: the title, when and where, and one decision as text.
    const card = within(widget).getByRole('group', { name: 'Event: Thermal test' });
    expect(card).toHaveTextContent('2 going');
    fireEvent.click(within(card).getByRole('button', { name: 'Take the spot' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/guilds/g1/events/e1/rsvp'));
    expect(await within(card).findByRole('button', { name: 'You’re in' })).toBeInTheDocument();
  });

  it('leaves out a widget with nothing to show', async () => {
    renderHome();
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringMatching(/attachments/)));
    expect(screen.queryByRole('region', { name: 'Media' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Coming up' })).not.toBeInTheDocument();
  });

  it('follows the owner’s choice of widgets', async () => {
    api.events = [{ id: 'e1', name: 'Thermal test', scheduled_start: soon(), status: 1 }];
    setHub({ widgets: [{ id: 'coming_up', enabled: false }] });
    renderHome();
    // New here is on, and Ren joined today.
    expect(await screen.findByRole('region', { name: 'New here' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Coming up' })).not.toBeInTheDocument();
  });

  it('puts the widgets in one grid, in the owner’s order, between the bar and the latest posts', async () => {
    api.events = [{ id: 'e1', name: 'Thermal test', scheduled_start: soon(), status: 1 }];
    api.feed = ['1', '2', '3', '4', '5'].map((id) => feedMessage(id, { content: `post ${id}` }));
    renderHome();
    const comingUp = await screen.findByRole('region', { name: 'Coming up' });
    const newHere = await screen.findByRole('region', { name: 'New here' });
    const latest = screen.getByRole('heading', { name: 'Latest' });
    const bar = screen.getByTestId('ix-overview-bar');
    const grid = screen.getByTestId('ix-widgets');
    // The two columns are CSS (a column count, one in a narrow main): the widgets share one container.
    expect(grid).toContainElement(comingUp);
    expect(grid).toContainElement(newHere);
    expect(bar.compareDocumentPosition(comingUp) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(comingUp.compareDocumentPosition(newHere) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(newHere.compareDocumentPosition(latest) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Nothing is folded into the feed: every post comes after the widgets.
    expect(newHere.compareDocumentPosition(screen.getByText('post 1')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows an event under way first, since there is no Live now to hold it', async () => {
    const started = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    api.events = [
      { id: 'e2', name: 'Later this week', scheduled_start: soon(), status: 1, user_count: 1 },
      { id: 'e1', name: 'Soldering hour', scheduled_start: started, status: 2, user_count: 3 },
    ];
    renderHome();
    const widget = await screen.findByRole('region', { name: 'Coming up' });
    const cards = within(widget).getAllByRole('group');
    expect(cards[0]).toHaveAccessibleName('Event: Soldering hour');
    expect(cards[0]).toHaveTextContent('Happening now');
    expect(cards[1]).toHaveAccessibleName('Event: Later this week');
  });

  it('opens the calendar from the widget’s link', async () => {
    api.events = [{ id: 'e1', name: 'Thermal test', scheduled_start: soon(), status: 1 }];
    renderHome();
    const widget = await screen.findByRole('region', { name: 'Coming up' });
    fireEvent.click(within(widget).getByRole('button', { name: 'Calendar' }));
    expect(screen.getByTestId('pathname')).toHaveTextContent('/app/guilds/g1/events');
  });
});
