import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { entityScopeKey } from '../../../lib/serverScope';
import { useAuthStore } from '../../../stores/authStore';
import { useChannelStore } from '../../../stores/channelStore';
import { useMemberStore } from '../../../stores/memberStore';
import { usePresenceStore } from '../../../stores/presenceStore';
import type { Channel, Member } from '../../../types';
import { useMenuHostStore } from '../../ix/menus/hostStore';
import { PeopleSheet } from './PeopleSheet';

/**
 * The people sheet: who is here, and what each of them is doing. A server's
 * members with presence, an activity or the words they set, and the voice channel
 * they are in; a group message's recipients; the two people of a direct message.
 */

vi.mock('../../../hooks/useMobile', () => ({ useMobile: () => false }));
// An avatar subscribes to the download ticket, which mints one over the network.
vi.mock('../../../hooks/useDownloadTicket', () => ({ useDownloadTicket: () => null }));

const rooms = vi.hoisted(() => ({
  value: [] as Array<{ name: string; occupants: Array<{ person: { userId: string } }> }>,
}));
vi.mock('../../../hooks/useLights', () => ({ useRoomLights: () => rooms.value }));

vi.mock('../../layout/GroupDmMembersPanel', () => ({
  GroupDmMembersPanel: ({ channelId }: { channelId: string }) => <div data-testid="group-people" data-channel={channelId} />,
}));

// The roles that name the sections after "Here now" (docs/index-spec.md §8.6).
const roles = vi.hoisted(() => ({
  value: [] as Array<{ id: string; name: string; hoist: boolean; position: number }>,
}));
vi.mock('../../../lib/permissionDataCache', () => ({
  fetchGuildRoles: () => Promise.resolve(roles.value),
}));

const SCOPE = { serverId: '__local__', userId: 'me' };
const GUILD = 'g1';

const person = (id: string, name: string) => ({
  id,
  username: name.toLowerCase(),
  display_name: name,
  discriminator: '0001',
  avatar_hash: null,
  bot: false,
  system: false,
  flags: 0,
  created_at: '2026-01-01T00:00:00.000Z',
});

const member = (id: string, name: string, nick: string | null = null): Member => ({
  user: person(id, name),
  user_id: id,
  nick,
  roles: [],
  joined_at: '2026-01-01T00:00:00.000Z',
  deaf: false,
  mute: false,
});

const channel = (props: Partial<Channel> & { id: string }): Channel =>
  ({ position: 0, created_at: '2026-01-01T00:00:00.000Z', permission_overwrites: [], ...props }) as unknown as Channel;

function setMembers(list: Member[], loaded = true) {
  const key = entityScopeKey(SCOPE, GUILD);
  useMemberStore.setState({
    members: new Map([[key, list]]),
    membersLoaded: { [key]: loaded },
    fetchMembers: vi.fn().mockResolvedValue(undefined),
  } as never);
}

function setPresence(userId: string, status: 'online' | 'idle' | 'dnd' | 'offline', extra: Record<string, unknown> = {}) {
  usePresenceStore.getState().updatePresence({ user_id: userId, status, activities: [], ...extra } as never, SCOPE.serverId);
}

function renderSheet(props: { guildId?: string | null; channelId?: string | null } = {}) {
  return render(
    <MemoryRouter>
      <PeopleSheet open onClose={vi.fn()} guildId={props.guildId === undefined ? GUILD : props.guildId} channelId={props.channelId === undefined ? 'c1' : props.channelId} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  rooms.value = [];
  roles.value = [];
  useMenuHostStore.getState().reset();
  usePresenceStore.getState().reset();
  useAuthStore.setState({ token: 'token', user: person('me', 'Sean') as never });
  useChannelStore.getState().reset();
  useChannelStore.getState().setChannels(GUILD, [channel({ id: 'c1', guild_id: GUILD, name: 'General', type: 0, channel_type: 0 })], SCOPE);
});

describe('a server\'s members', () => {
  beforeEach(() => {
    setMembers([
      member('me', 'Sean'),
      member('u2', 'Vincent'),
      member('u3', 'Jeremy'),
      member('u4', 'Luke'),
      member('u5', 'Eric'),
      member('u6', 'Nick', 'Nicky'),
    ]);
    setPresence('me', 'online');
    setPresence('u2', 'online');
    setPresence('u3', 'idle', { custom_status: 'Back in ten' });
    setPresence('u4', 'dnd', { activities: [{ name: 'Spotify', type: 2, details: 'Windowlicker', state: 'Aphex Twin' }] });
    setPresence('u6', 'online', { activities: [{ name: 'Deep Cave', type: 0 }] });
    // Eric has no presence: offline.
  });

  it('is a dialog named Members, with how many are here', () => {
    renderSheet();
    const sheet = screen.getByRole('dialog', { name: 'Members' });
    expect(within(sheet).getByText('5 here now, 6 in all')).toBeInTheDocument();
  });

  it('lists those who are here first, and everyone else under Offline', () => {
    renderSheet();
    const here = screen.getByRole('region', { name: 'Here now' });
    const offline = screen.getByRole('region', { name: 'Offline' });
    for (const name of ['Sean', 'Vincent', 'Jeremy', 'Luke', 'Nicky']) {
      expect(within(here).getByText(name)).toBeInTheDocument();
    }
    expect(within(offline).getByText('Eric')).toBeInTheDocument();
    expect(within(offline).getByText('Offline', { selector: '.glass-sheet-row__detail' })).toBeInTheDocument();
  });

  it('says what someone is doing, in words: a custom status, an activity, or their presence', () => {
    renderSheet();
    expect(screen.getByText('Back in ten')).toBeInTheDocument();
    expect(screen.getByText('Windowlicker — Aphex Twin')).toBeInTheDocument();
    expect(screen.getByText('Playing Deep Cave')).toBeInTheDocument();
    expect(screen.getAllByText('Online').length).toBeGreaterThan(0);
  });

  it('uses the nickname the server gave someone', () => {
    renderSheet();
    expect(screen.getByText('Nicky')).toBeInTheDocument();
    expect(screen.queryByText('Nick')).not.toBeInTheDocument();
  });

  it('marks a person in a voice channel, in amber, with the channel\'s name', () => {
    rooms.value = [{ name: 'Lounge', occupants: [{ person: { userId: 'u2' } }] }];
    renderSheet();
    const line = screen.getByText('In Lounge');
    expect(line).toHaveClass('glass-sheet-live');
  });

  it('draws presence as ink, and never only as ink: the word is in the row', () => {
    renderSheet();
    // The Index dots (index-spec §2.3): online, idle and do not disturb; offline draws none.
    const marks = document.querySelectorAll('.ix-presence');
    expect([...marks].map((mark) => mark.getAttribute('data-presence'))).toEqual(
      expect.arrayContaining(['online', 'idle', 'dnd']),
    );
    expect(marks).toHaveLength(5);
    // The mark is decoration for a screen reader (its word is the row's second line).
    for (const mark of marks) expect(mark.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('puts everyone else under the highest hoisted role they hold, then Offline', async () => {
    roles.value = [
      { id: 'r-all', name: '@everyone', hoist: false, position: 0 },
      { id: 'r-mod', name: 'Moderators', hoist: true, position: 3 },
      { id: 'r-vip', name: 'Regulars', hoist: true, position: 1 },
    ];
    setMembers([
      member('me', 'Sean'),
      { ...member('u5', 'Eric'), roles: ['r-vip'] },
      { ...member('u8', 'Maud'), roles: ['r-vip', 'r-mod'] },
      member('u7', 'Zed'),
    ]);
    setPresence('me', 'online');
    renderSheet();
    // Eric and Maud are away: Maud holds the higher role, so she is under Moderators.
    expect(await screen.findByRole('region', { name: 'Moderators' })).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Moderators' })).getByText('Maud')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Regulars' })).getByText('Eric')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Offline' })).getByText('Zed')).toBeInTheDocument();
    const order = screen.getAllByRole('region').map((region) => region.getAttribute('aria-label'));
    expect(order).toEqual(['Here now', 'Moderators', 'Regulars', 'Offline']);
  });

  it('opens someone\'s profile card from their row', async () => {
    const user = userEvent.setup();
    renderSheet();
    const row = screen.getByRole('button', { name: /^Vincent/ });
    // Named by what it shows, so a screen reader hears who and what they are doing.
    expect(row).toHaveAccessibleName(/^Vincent,\s*Online$/);
    expect(row).toHaveAttribute('aria-haspopup', 'dialog');
    await user.click(row);
    // The card is the menu host's (components/ix/menus), opened beside the row.
    expect(useMenuHostStore.getState().profile?.user.username).toBe('vincent');
  });

  it('says it is loading before the roster arrives, and does not pretend the server is empty', () => {
    setMembers([], false);
    renderSheet();
    expect(screen.getByText('Loading members…')).toBeInTheDocument();
  });

  it('says so when there is no one to show', () => {
    setMembers([], true);
    renderSheet();
    expect(screen.getByText('No one to show')).toBeInTheDocument();
  });

  it('shows a long roster a page at a time', async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 150 }, (_, i) => member(`m${i}`, `Person ${String(i).padStart(3, '0')}`));
    setMembers(many);
    for (const entry of many) setPresence(entry.user.id, 'online');
    renderSheet();
    expect(screen.getAllByRole('listitem')).toHaveLength(120);
    await user.click(screen.getByRole('button', { name: 'Show 30 more' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(150);
    expect(screen.queryByRole('button', { name: /Show .* more/ })).not.toBeInTheDocument();
  });

  it('asks the server for the roster when it opens', () => {
    renderSheet();
    expect(useMemberStore.getState().fetchMembers).toHaveBeenCalledWith(GUILD, SCOPE);
  });
});

describe('a group message', () => {
  it('shows who it is addressed to, on the group\'s own page', () => {
    useChannelStore.getState().setChannels('', [
      channel({ id: 'dm3', name: 'Launch group', type: 3, channel_type: 3, guild_id: null }),
    ], SCOPE);
    renderSheet({ guildId: null, channelId: 'dm3' });
    const sheet = screen.getByRole('dialog', { name: 'People in this message' });
    expect(within(sheet).getByTestId('group-people')).toHaveAttribute('data-channel', 'dm3');
    expect(within(sheet).getByText('Launch group')).toBeInTheDocument();
  });
});

describe('a direct message', () => {
  it('shows the two of you, and marks which is you', () => {
    useChannelStore.getState().setChannels('', [
      channel({
        id: 'dm1',
        type: 1,
        channel_type: 1,
        guild_id: null,
        recipient: { id: 'u2', username: 'Vincent', discriminator: '0001', avatar_hash: null },
      } as never),
    ], SCOPE);
    setPresence('u2', 'online', { activities: [{ name: 'Deep Cave', type: 0 }] });
    renderSheet({ guildId: null, channelId: 'dm1' });
    const sheet = screen.getByRole('dialog', { name: 'People in this message' });
    expect(within(sheet).getByText('Vincent')).toBeInTheDocument();
    expect(within(sheet).getByText('Playing Deep Cave')).toBeInTheDocument();
    const mine = within(sheet).getByText(/Sean.*\(you\)/);
    expect(mine).toBeInTheDocument();
    // "(you)" is said beside the name; the face still draws just the initial.
    expect(mine.closest('li')?.querySelector('.ix-av')?.textContent).toBe('S');
  });
});
