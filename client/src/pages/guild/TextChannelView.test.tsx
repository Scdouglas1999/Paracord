import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TextChannelView } from './TextChannelView';
import { useMemberStore } from '../../stores/memberStore';
import { entityScopeKey } from '../../lib/serverScope';
import type { Channel } from '../../types';

/**
 * A thread view is about the thread (docs/lantern-stage-spec.md §7.4).
 *
 * It used to be about the thread's *parent*: the body rendered the parent room
 * behind a "Parent channel" strip, so a page titled "Bracket tolerance" said
 * "design-notes is dark — nobody has posted in design-notes yet" about a room
 * with fifty messages in it.
 *
 * The timeline and composer are stubbed to the one thing that matters here —
 * which channel they were given.
 */
vi.mock('../../components/message/MessageList', () => ({
  MessageList: ({ channelId }: { channelId: string }) => (
    <div data-testid="timeline">{channelId}</div>
  ),
}));
vi.mock('../../components/message/MessageInput', () => ({
  MessageInput: ({ channelId }: { channelId: string }) => (
    <div data-testid="composer">{channelId}</div>
  ),
}));

const SCOPE = { serverId: '__local__', userId: 'user-1' };

vi.mock('../../hooks/useCurrentUser', () => ({
  useCurrentAccountScope: () => SCOPE,
}));

const PARENT = { id: '2001', guild_id: 'g1', type: 0, name: 'design-notes' } as Channel;
const THREAD = {
  id: '2003',
  guild_id: 'g1',
  type: 6,
  name: 'Bracket tolerance',
  parent_id: '2001',
  owner_id: '101',
} as Channel;

function Probe() {
  return <div data-testid="pathname">{useLocation().pathname}</div>;
}

function renderThread(channel: Channel = THREAD, channels: Channel[] = [PARENT, THREAD]) {
  return render(
    <MemoryRouter initialEntries={['/app/guilds/g1/channels/2003']}>
      <Routes>
        <Route
          path="*"
          element={
            <TextChannelView
              guildId="g1"
              channelId={channel.id}
              channelName={channel.name ?? ''}
              channel={channel}
              channels={channels}
            />
          }
        />
      </Routes>
      <Probe />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useMemberStore.setState({ members: new Map() });
});

describe('a thread view', () => {
  it('shows the thread, not the room it lives in', () => {
    renderThread();
    expect(screen.getByTestId('timeline')).toHaveTextContent('2003');
    expect(screen.getByTestId('composer')).toHaveTextContent('2003');
    expect(screen.queryByText('Parent channel')).not.toBeInTheDocument();
  });

  it('says where the thread lives, and walks back to it', async () => {
    renderThread();
    expect(screen.getByText('A thread in')).toBeInTheDocument();
    const parent = screen.getByRole('button', { name: '#design-notes' });
    await userEvent.click(parent);
    expect(screen.getByTestId('pathname')).toHaveTextContent('/app/guilds/g1/channels/2001');
  });

  it('names the person who started it once the roster can be read', () => {
    renderThread();
    expect(screen.queryByText(/started by/)).not.toBeInTheDocument();

    cleanup();
    useMemberStore.setState({
      members: new Map([
        [
          entityScopeKey(SCOPE, 'g1'),
          [{ user: { id: '101', username: 'mara' }, nick: null }] as never,
        ],
      ]),
    });
    renderThread();
    expect(screen.getByText('· started by mara')).toBeInTheDocument();
  });

  it('says so plainly when the room the thread lives in is gone', () => {
    renderThread(THREAD, [THREAD]);
    expect(screen.getByText('a channel you can no longer see')).toBeInTheDocument();
  });

  it('leaves an ordinary room alone', () => {
    renderThread(PARENT, [PARENT]);
    expect(screen.queryByText('A thread in')).not.toBeInTheDocument();
    expect(screen.getByTestId('timeline')).toHaveTextContent('2001');
  });
});
