import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../stores/authStore';
import { useChannelStore } from '../stores/channelStore';
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
    channelsById: { [channel.id]: channel },
    channels: [channel],
    selectedChannelId: channel.id,
    selectedGuildId: null,
  });
}

function renderDmPage(channelId: string) {
  return render(
    <MemoryRouter initialEntries={[`/app/dms/${channelId}`]}>
      <Routes>
        <Route path="/app/dms/:channelId" element={<DMPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('DMPage — ContextPanel-driven member surface (new IA)', () => {
  beforeEach(() => {
    useAuthStore.setState({ user: currentUser });
    useUIStore.setState({ contextPanelMode: null });
  });

  it('renders the message surface with no docked member <aside>', () => {
    seedChannel(groupDm());

    renderDmPage('dm-1');

    expect(screen.getByTestId('message-list')).toBeInTheDocument();
    expect(screen.getByTestId('message-input')).toBeInTheDocument();
    // The bespoke docked recipient list is gone; recipients live in ContextPanel.
    expect(screen.queryByText('Bob')).not.toBeInTheDocument();
  });

  it('toggles the shared members surface via contextPanelMode for a group DM', async () => {
    const user = userEvent.setup();
    seedChannel(groupDm());

    renderDmPage('dm-1');

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

    renderDmPage('dm-2');

    expect(screen.queryByRole('button', { name: 'Members' })).not.toBeInTheDocument();
  });
});
