import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../stores/authStore';
import { useChannelStore } from '../stores/channelStore';
import { useServerListStore } from '../stores/serverListStore';
import type { Channel } from '../types';
import type { ConversationSubject } from '../components/ix/conversation';
import { DMPage } from './DMPage';

/**
 * A direct message or a group as an Index conversation (docs/index-spec.md §4.11,
 * §6.6). `IxConversation` (the large title, the call button, the timeline, the
 * new-message welcome, the message box) is covered in components/ix/conversation;
 * this suite is about the page that finds the conversation and says who it is with.
 * `/app/dms` is not a page (it redirects: components/ix/people/LastPlaceRedirect).
 */
const seen = vi.hoisted(() => ({ subject: null as null | Record<string, unknown> }));
vi.mock('../components/ix/conversation', () => ({
  IxConversation: ({ subject }: { subject: ConversationSubject }) => {
    seen.subject = subject as unknown as Record<string, unknown>;
    return <div data-testid="conversation" data-channel-id={subject.channelId} />;
  },
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
  avatar_hash: 'a1',
  display_name: 'Bobby',
  flags: 0,
  bot: false,
  system: false,
  created_at: '2026-01-01T00:00:00.000Z',
};

function groupDm(recipients = [currentUser, bob, { ...bob, id: 'cy', username: 'Cy' }]): Channel {
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

function seedDmList(channels: Channel[]) {
  useChannelStore.getState().reset();
  useChannelStore.getState().setChannels('', channels, { serverId: '__local__', userId: 'me' });
}

function renderDmPage(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/app/dms" element={<DMPage />} />
        <Route path="/app/dms/:channelId" element={<DMPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  seen.subject = null;
  useAuthStore.setState({ token: 'token', user: currentUser });
  useServerListStore.setState({ activeServerId: null, servers: [] });
});

afterEach(cleanup);

describe('DMPage', () => {
  it('is a conversation: the one it was opened on, as a direct message', () => {
    seedDmList([directDm()]);

    renderDmPage('/app/dms/dm-2');

    expect(screen.getByTestId('conversation')).toHaveAttribute('data-channel-id', 'dm-2');
    expect(seen.subject).toMatchObject({
      kind: 'dm',
      channelId: 'dm-2',
      isGroup: false,
      // The title opens this person's profile card; the welcome draws their face.
      recipient: { id: 'bob', username: 'Bob', display_name: 'Bobby', avatar_hash: 'a1' },
    });
    expect(seen.subject?.participants).toBeUndefined();
  });

  it('titles a group by its name, and counts everyone in it', () => {
    seedDmList([groupDm()]);

    renderDmPage('/app/dms/dm-1');

    expect(seen.subject).toMatchObject({ kind: 'dm', channelId: 'dm-1', isGroup: true, title: 'Launch group', recipient: null, participants: 3 });
  });

  it('is not the list of conversations: with no conversation there is nothing to draw', () => {
    seedDmList([directDm()]);

    renderDmPage('/app/dms');

    expect(screen.queryByTestId('conversation')).not.toBeInTheDocument();
  });

  it('does not resolve a deep-link ID against another server account', () => {
    useServerListStore.setState({
      activeServerId: 'srv-a',
      servers: ['srv-a', 'srv-b'].map((id) => ({
        id,
        url: `https://${id}.test`,
        name: id,
        token: 'token',
        userId: 'me',
        user: currentUser,
        connected: true,
      })),
    });
    useChannelStore.getState().reset();
    useChannelStore.getState().setChannels('', [groupDm()], { serverId: 'srv-b', userId: 'me' });

    renderDmPage('/app/dms/dm-1');

    // Not found for this account: a plain "Direct message", and the active server is left alone.
    expect(seen.subject).toMatchObject({ kind: 'dm', channelId: 'dm-1', title: 'Direct message', isGroup: false });
    expect(useServerListStore.getState().activeServerId).toBe('srv-a');
  });
});
