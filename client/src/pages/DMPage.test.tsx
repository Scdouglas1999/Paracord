import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../stores/authStore';
import { useChannelStore } from '../stores/channelStore';
import { usePresenceStore } from '../stores/presenceStore';
import { useReadStateStore } from '../stores/readStateStore';
import { useUIStore } from '../stores/uiStore';
import type { Channel } from '../types';
import { DMPage } from './DMPage';

vi.mock('../components/layout/TopBar', () => ({
  TopBar: () => <div data-testid="topbar" />,
}));

vi.mock('../components/message/MessageList', () => ({
  MessageList: () => <div data-testid="message-list" />,
}));

vi.mock('../components/message/MessageInput', () => ({
  MessageInput: () => <div data-testid="message-input" />,
}));

vi.mock('../components/message/DmPickerModal', () => ({
  DmPickerModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="dm-picker" /> : null,
}));

const currentUser = {
  id: 'me',
  username: 'Self',
  discriminator: 1,
  flags: 0,
  bot: false,
  system: false,
  created_at: '2026-01-01T00:00:00.000Z',
};

const bob = {
  id: 'bob',
  username: 'Bob',
  discriminator: 2,
  flags: 0,
  bot: false,
  system: false,
  created_at: '2026-01-01T00:00:00.000Z',
};

function groupDm(recipients = [currentUser, bob]): Channel {
  return {
    id: 'dm-1',
    name: 'Launch group',
    type: 3,
    channel_type: 3,
    guild_id: null,
    owner_id: 'me',
    recipients,
    position: 0,
    permission_overwrites: [],
    created_at: '2026-01-01T00:00:00.000Z',
  } as unknown as Channel;
}

function directDm(): Channel {
  return {
    id: 'dm-2',
    type: 1,
    channel_type: 1,
    guild_id: null,
    recipient: bob,
    position: 0,
    permission_overwrites: [],
    created_at: '2026-01-01T00:00:00.000Z',
  } as unknown as Channel;
}

function seedChannel(channel: Channel) {
  useChannelStore.setState({
    channelsByGuild: { '': [channel] },
    dmChannelsByServer: {},
    channelsById: { [channel.id]: channel },
    channels: [channel],
    selectedChannelId: channel.id,
    selectedGuildId: null,
  });
}

function seedDmList(channels: Channel[]) {
  const byId: Record<string, Channel> = {};
  for (const c of channels) byId[c.id] = c;
  useChannelStore.setState({
    channelsByGuild: { '': channels },
    dmChannelsByServer: {},
    channelsById: byId,
    channels,
    selectedChannelId: null,
    selectedGuildId: null,
  });
}

function renderDmPage(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/app/dms" element={<DMPage />} />
        <Route path="/app/dms/:channelId" element={<DMPage />} />
        <Route path="/app/friends" element={<div>Friends route</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('DMPage — conversation view (ContextPanel-driven member surface)', () => {
  beforeEach(() => {
    useAuthStore.setState({ user: currentUser });
    useUIStore.setState({ contextPanelMode: null });
  });

  it('renders the message surface with no docked member <aside>', () => {
    seedChannel(groupDm());

    renderDmPage('/app/dms/dm-1');

    expect(screen.getByTestId('message-list')).toBeInTheDocument();
    expect(screen.getByTestId('message-input')).toBeInTheDocument();
    // The bespoke docked recipient list is gone; recipients live in ContextPanel.
    expect(screen.queryByText('Bob')).not.toBeInTheDocument();
  });

  it('toggles the shared members surface via contextPanelMode for a group DM', async () => {
    const user = userEvent.setup();
    seedChannel(groupDm());

    renderDmPage('/app/dms/dm-1');

    const membersButton = screen.getByRole('button', { name: 'Members' });
    expect(useUIStore.getState().contextPanelMode).toBeNull();

    await user.click(membersButton);
    expect(useUIStore.getState().contextPanelMode).toBe('members');
    expect(membersButton).toHaveAttribute('aria-pressed', 'true');

    await user.click(membersButton);
    expect(useUIStore.getState().contextPanelMode).toBeNull();
  });

  it('does not render the group-DM members toggle for a 1:1 DM', () => {
    seedChannel(directDm());

    renderDmPage('/app/dms/dm-2');

    expect(screen.queryByRole('button', { name: 'Members' })).not.toBeInTheDocument();
  });
});

describe('DMPage — all-conversations index (/app/dms)', () => {
  beforeEach(() => {
    useAuthStore.setState({ user: currentUser });
    useUIStore.setState({ contextPanelMode: null });
    useReadStateStore.setState({ byServer: {}, readStates: {} });
    usePresenceStore.setState({ presences: new Map(), presenceOrder: new Map() });
  });

  it('offers "New message" as the primary action and shows a designed empty state', async () => {
    const user = userEvent.setup();
    seedDmList([]);

    renderDmPage('/app/dms');

    // Primary action lives in the page header (the empty state also offers one).
    const newMessageButtons = screen.getAllByRole('button', { name: /new message/i });
    expect(newMessageButtons.length).toBeGreaterThan(0);

    // Designed empty state pointing at friends (left-aligned, warm copy).
    expect(screen.getByText('No conversations yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /find friends/i })).toBeInTheDocument();

    // The header primary action opens the shared DM picker.
    await user.click(newMessageButtons[0]);
    expect(screen.getByTestId('dm-picker')).toBeInTheDocument();
  });

  it('lists every DM sorted by last activity and opens one on click', async () => {
    const user = userEvent.setup();
    const ancient: Channel = {
      id: 'dm-ancient',
      type: 1,
      channel_type: 1,
      guild_id: null,
      recipient: { id: 'ancient-user', username: 'Ancient', discriminator: 3 },
      last_message_id: '100',
      position: 0,
      permission_overwrites: [],
      created_at: '2026-01-01T00:00:00.000Z',
    } as unknown as Channel;
    const fresh: Channel = {
      id: 'dm-fresh',
      type: 1,
      channel_type: 1,
      guild_id: null,
      recipient: { id: 'bob', username: 'Nova', discriminator: 4 },
      last_message_id: '9000000000000000000',
      position: 0,
      permission_overwrites: [],
      created_at: '2026-01-01T00:00:00.000Z',
    } as unknown as Channel;
    seedDmList([ancient, fresh]);

    renderDmPage('/app/dms');

    expect(screen.getByText('Conversations — 2')).toBeInTheDocument();

    const rows = screen
      .getAllByRole('button')
      .filter((b) => /Nova|Ancient/.test(b.textContent ?? ''));
    // Most-recent-activity conversation sorts first.
    expect(rows[0].textContent).toContain('Nova');
    expect(rows[1].textContent).toContain('Ancient');

    // No read state + a last message ⇒ unread indicator.
    expect(screen.getAllByTestId('unread-dot').length).toBeGreaterThan(0);

    await user.click(rows[0]);
    expect(screen.getByTestId('message-list')).toBeInTheDocument();
    expect(useChannelStore.getState().selectedChannelId).toBe('dm-fresh');
  });
});
