import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TextChannelView } from './TextChannelView';
import { useMemberStore } from '../../stores/memberStore';
import { entityScopeKey } from '../../lib/serverScope';
import type { Channel } from '../../types';
import type { ConversationSubject } from '../../components/ix/conversation';

/**
 * A thread view is about the thread (docs/lantern-stage-spec.md §7.4), and a pushed
 * page (docs/index-spec.md §6.1, §8.1): the thread's name is the title, "Thread in
 * design-notes · started by mara" is under it, the toolbar has a back chevron to the
 * channel it lives in, and Esc goes there too.
 *
 * `IxConversation` (the large title, the timeline, the welcome, the message box) has
 * its own suite; here it is reduced to what this page hands it.
 */
const seen = vi.hoisted(() => ({ props: null as null | Record<string, unknown> }));
vi.mock('../../components/ix/conversation', () => ({
  IxConversation: (props: { subject: ConversationSubject; onBack?: () => void; backLabel?: string }) => {
    seen.props = props as unknown as Record<string, unknown>;
    const { subject, onBack, backLabel } = props;
    return (
      <div data-testid="conversation">
        <h1>{subject.kind === 'channel' ? subject.channelName : subject.title}</h1>
        {subject.kind === 'channel' && subject.subtitle && <p data-testid="subtitle">{subject.subtitle}</p>}
        {onBack && (
          <button type="button" onClick={onBack}>
            {backLabel}
          </button>
        )}
      </div>
    );
  },
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
              subject={{
                kind: 'channel',
                guildId: 'g1',
                channelId: channel.id,
                channelName: channel.name ?? '',
              }}
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
  seen.props = null;
});

afterEach(cleanup);

describe('a thread view', () => {
  it('is the thread, titled by its own name, and says where it lives', () => {
    renderThread();
    expect(screen.getByRole('heading', { name: 'Bracket tolerance' })).toBeInTheDocument();
    expect(screen.getByTestId('subtitle')).toHaveTextContent('Thread in design-notes');
    expect((seen.props?.subject as { isThread?: boolean }).isThread).toBe(true);
  });

  it('walks back to the channel it lives in, from the toolbar chevron and from Esc', async () => {
    renderThread();
    await userEvent.click(screen.getByRole('button', { name: 'Back to design-notes' }));
    expect(screen.getByTestId('pathname')).toHaveTextContent('/app/guilds/g1/channels/2001');
    await userEvent.keyboard('{Escape}');
    expect(screen.getByTestId('pathname')).toHaveTextContent('/app/guilds/g1/channels/2001');
  });

  it('goes back with Alt+Left too', async () => {
    renderThread();
    await userEvent.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    expect(screen.getByTestId('pathname')).toHaveTextContent('/app/guilds/g1/channels/2001');
  });

  it('names the person who started it once the roster can be read', () => {
    renderThread();
    expect(screen.getByTestId('subtitle')).not.toHaveTextContent('started by');

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
    expect(screen.getByTestId('subtitle')).toHaveTextContent('Thread in design-notes · started by mara');
  });

  it('says so plainly when the channel the thread lives in is gone, and goes back to the server', async () => {
    renderThread(THREAD, [THREAD]);
    expect(screen.getByTestId('subtitle')).toHaveTextContent('Thread in a channel you can no longer see');
    await userEvent.click(screen.getByRole('button', { name: 'Back to the server' }));
    expect(screen.getByTestId('pathname')).toHaveTextContent('/app/guilds/g1');
    expect(screen.getByTestId('pathname')).not.toHaveTextContent('channels');
  });

  it('leaves an ordinary channel alone: no back chevron, no thread line, Esc does nothing', async () => {
    renderThread(PARENT, [PARENT]);
    expect(screen.queryByTestId('subtitle')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Back/ })).not.toBeInTheDocument();
    expect((seen.props?.subject as { isThread?: boolean }).isThread).toBeUndefined();
    await userEvent.keyboard('{Escape}');
    expect(screen.getByTestId('pathname')).toHaveTextContent('/app/guilds/g1/channels/2003');
  });
});
