import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode, Ref } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAuthStore } from '../../../stores/authStore';
import { useChannelStore } from '../../../stores/channelStore';
import { scopeGuild, useGuildStore } from '../../../stores/guildStore';
import { useToolbarStore } from '../shell/toolbarStore';
import { IxConversation } from './IxConversation';
import type { ConversationSubject } from './types';

/**
 * A conversation in main (docs/index-spec.md §4.11): the large title is the
 * timeline's header, the toolbar says the folded title and the DM call button, the
 * title opens the channel menu (a DM: the profile card), the welcome is the
 * timeline's empty state, and the message box is the column's.
 *
 * The timeline and the message box are stubs that draw what they were handed.
 */
const hooks = vi.hoisted(() => ({
  actions: {
    encrypted: false,
    encryption: 'ready',
    loading: false,
    error: null as string | null,
    actions: {
      send: { allowed: true, reason: null as string | null },
      voice: { allowed: true, reason: null as string | null },
      summary: { allowed: true, reason: null as string | null },
    },
  },
  messages: [] as unknown[],
  openChannelMenu: vi.fn(),
  openProfileCard: vi.fn(),
  list: { props: null as null | Record<string, unknown> },
  input: { props: null as null | Record<string, unknown> },
}));

vi.mock('../../../hooks/useConversationActions', () => ({ useConversationActions: () => hooks.actions }));
vi.mock('../../../hooks/useMessageStore', () => ({
  useCurrentMessageStore: (selector: (state: unknown) => unknown) => selector({ messages: { c1: hooks.messages, d1: hooks.messages } }),
  useCurrentMessageStoreApi: () => ({ getState: () => ({ sendMessage: vi.fn() }) }),
}));
vi.mock('../../../hooks/usePermissions', () => ({ usePermissions: () => ({ permissions: (1n << 40n) - 1n, isAdmin: false }) }));
vi.mock('../menus', () => ({
  openChannelMenu: hooks.openChannelMenu,
  openProfileCard: hooks.openProfileCard,
  openInvite: vi.fn(),
}));
vi.mock('../../message/MessageList', () => ({
  MessageList: (props: { header?: ReactNode; emptyState?: ReactNode; onScroller?: (el: HTMLDivElement | null) => void; channelId: string }) => {
    hooks.list.props = props as unknown as Record<string, unknown>;
    return (
      <div data-testid="list" data-channel={props.channelId}>
        <div ref={props.onScroller as Ref<HTMLDivElement>} className="scroller">
          {props.header}
          {props.emptyState && <div data-timeline-empty>{props.emptyState}</div>}
        </div>
      </div>
    );
  },
}));
vi.mock('../../message/MessageInput', () => ({
  MessageInput: (props: Record<string, unknown>) => {
    hooks.input.props = props;
    return <div data-testid="ix-composer" />;
  },
}));
vi.mock('../../../api/guilds', () => ({ guildApi: { getMyOnboardingState: vi.fn().mockRejectedValue(new Error('offline')) } }));
vi.mock('../../../api/users', () => ({ userApi: { getProfile: vi.fn().mockRejectedValue(new Error('offline')) } }));

const SCOPE = { serverId: '__local__', userId: 'me' };
const CHANNEL: ConversationSubject = { kind: 'channel', guildId: 'g1', guildName: 'Fuel', channelId: 'c1', channelName: 'general' };
const DM: ConversationSubject = {
  kind: 'dm',
  channelId: 'd1',
  title: 'Jeremy',
  isGroup: false,
  recipient: { id: 'jeremy', username: 'jeremy', display_name: 'Jeremy', avatar_hash: null },
};

const toolbar = () => useToolbarStore.getState().page;

function renderConversation(subject: ConversationSubject, props: Partial<React.ComponentProps<typeof IxConversation>> = {}) {
  return render(
    <MemoryRouter>
      <IxConversation subject={subject} {...props} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  hooks.actions.encrypted = false;
  hooks.actions.encryption = 'ready';
  hooks.actions.loading = false;
  hooks.actions.error = null;
  hooks.actions.actions.voice = { allowed: true, reason: null };
  hooks.messages = [];
  hooks.openChannelMenu.mockReset();
  hooks.openProfileCard.mockReset();
  window.localStorage.clear();
  useAuthStore.setState({ token: 'token', user: { id: 'me', username: 'sean', display_name: 'Sean' } as never });
  useGuildStore.setState({
    guilds: [scopeGuild({ id: 'g1', name: 'Fuel', owner_id: 'me', description: 'Haz 5 runs.', member_count: 2, default_channel_id: 'c1' } as never, SCOPE)],
  });
  useChannelStore.getState().reset();
  useChannelStore.getState().setChannels('g1', [{ id: 'c1', type: 0, channel_type: 0, guild_id: 'g1', name: 'general', position: 0 } as never], SCOPE);
});

afterEach(() => {
  cleanup();
  useToolbarStore.setState({ page: null, owner: null });
});

describe('IxConversation: the title', () => {
  it('is the timeline’s header: the large title, and under it the first channel’s "main channel" line', () => {
    renderConversation(CHANNEL);
    const header = screen.getByTestId('list').querySelector('.ix-conv-head') as HTMLElement;
    expect(header).toContainElement(screen.getByTestId('ix-title'));
    expect(screen.getByTestId('ix-title')).toHaveTextContent('general');
    expect(header).toHaveTextContent('Fuel’s main channel');
  });

  it('says the topic, and puts what the page pinned under the title', () => {
    renderConversation({ ...CHANNEL, topic: 'Haz 5 runs from 9.' }, { notices: <div data-testid="pin">A score</div> });
    const header = screen.getByTestId('list').querySelector('.ix-conv-head') as HTMLElement;
    expect(header).toHaveTextContent('Haz 5 runs from 9.');
    expect(header).toContainElement(screen.getByTestId('pin'));
  });

  it('an encrypted conversation says so with a lock, once the server has said it', () => {
    hooks.actions.encrypted = true;
    renderConversation(DM);
    expect(screen.getByTestId('ix-encrypted-line')).toHaveTextContent('End-to-end encrypted');
    expect(screen.getByTestId('list').querySelector('.ix-conv-head')).toHaveTextContent('Direct message');
    cleanup();
    hooks.actions.loading = true;
    renderConversation(DM);
    expect(screen.queryByTestId('ix-encrypted-line')).not.toBeInTheDocument();
  });

  it('a group says how many are in it', () => {
    renderConversation({ kind: 'dm', channelId: 'd1', title: 'Crew', isGroup: true, participants: 4 });
    expect(screen.getByTestId('list').querySelector('.ix-conv-head')).toHaveTextContent('Group · 4 people');
  });
});

describe('IxConversation: the toolbar', () => {
  it('registers the folded title, the title’s menu, and search and members', () => {
    renderConversation(CHANNEL);
    expect(toolbar()).toMatchObject({ title: 'general', titleHasPopup: 'menu', folded: expect.any(Boolean), search: true, members: true });
    expect(toolbar()?.onBack).toBeNull();
    expect(toolbar()?.call).toBeUndefined();
  });

  it('the title opens the channel menu with the server’s catch-up answer', () => {
    renderConversation(CHANNEL);
    act(() => toolbar()?.onTitleClick?.());
    expect(hooks.openChannelMenu).toHaveBeenCalledTimes(1);
    const [request] = hooks.openChannelMenu.mock.calls[0];
    expect(request).toEqual({
      subject: { kind: 'channel', guildId: 'g1', channelId: 'c1', channelName: 'general' },
      summary: { allowed: true, reason: null },
    });
  });

  it('clicking the large title does the same', async () => {
    renderConversation(CHANNEL);
    await userEvent.click(screen.getByRole('button', { name: 'general' }));
    expect(hooks.openChannelMenu).toHaveBeenCalledTimes(1);
  });

  it('a one-to-one message’s title is the person’s profile card; a right click still reaches the channel menu', async () => {
    renderConversation(DM);
    expect(toolbar()?.titleHasPopup).toBe('dialog');
    act(() => toolbar()?.onTitleClick?.());
    expect(hooks.openProfileCard).toHaveBeenCalledTimes(1);
    expect(hooks.openProfileCard.mock.calls[0][0]).toMatchObject({ id: 'jeremy', username: 'jeremy' });
    expect(hooks.openChannelMenu).not.toHaveBeenCalled();
    await userEvent.pointer({ keys: '[MouseRight]', target: screen.getByTestId('ix-title') });
    expect(hooks.openChannelMenu).toHaveBeenCalledTimes(1);
    expect(hooks.openChannelMenu.mock.calls[0][0].subject).toMatchObject({ kind: 'dm', channelId: 'd1' });
  });

  it('a group’s title is the channel menu', () => {
    renderConversation({ kind: 'dm', channelId: 'd1', title: 'Crew', isGroup: true, participants: 3 });
    act(() => toolbar()?.onTitleClick?.());
    expect(hooks.openChannelMenu).toHaveBeenCalledTimes(1);
    expect(hooks.openProfileCard).not.toHaveBeenCalled();
  });

  it('a DM puts the call button left of search', () => {
    renderConversation(DM);
    render(<>{toolbar()?.call}</>);
    expect(screen.getByTestId('ix-dm-call')).toBeInTheDocument();
  });

  it('a pushed page (a thread) gets the back chevron the host gave it', () => {
    const onBack = vi.fn();
    renderConversation({ ...CHANNEL, isThread: true }, { onBack, backLabel: 'Back to general' });
    expect(toolbar()?.onBack).toBe(onBack);
    expect(toolbar()?.backLabel).toBe('Back to general');
  });
});

describe('IxConversation: the welcome and the box', () => {
  it('draws the welcome as the timeline’s empty state, and the message box in its column', () => {
    renderConversation(CHANNEL);
    expect(screen.getByTestId('ix-welcome')).toHaveAttribute('data-variant', 'server');
    expect(screen.getByTestId('ix-composer').closest('.ix-composer-column')).not.toBeNull();
    expect(hooks.input.props).toMatchObject({ channelId: 'c1', guildId: 'g1', channelName: 'general', conversationKind: 'channel' });
  });

  it('a thread has no welcome: the list’s own "No replies yet" stands', () => {
    renderConversation({ ...CHANNEL, isThread: true });
    expect(hooks.list.props?.emptyState).toBeUndefined();
    expect(screen.queryByTestId('ix-welcome')).not.toBeInTheDocument();
  });

  it('a DM gets the new-message welcome and the person’s name in the box', () => {
    renderConversation(DM);
    expect(screen.getByTestId('ix-welcome')).toHaveAttribute('data-variant', 'dm');
    expect(hooks.input.props).toMatchObject({ channelId: 'd1', channelName: 'Jeremy', conversationKind: 'person' });
  });

  it('an encrypted conversation on a locked device says "Locked" with one Unlock, in place of the welcome', () => {
    hooks.actions.encrypted = true;
    hooks.actions.encryption = 'unlock';
    renderConversation(DM);
    expect(screen.getByRole('heading', { name: 'Locked' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeInTheDocument();
    expect(screen.queryByTestId('ix-welcome')).not.toBeInTheDocument();
  });
});

describe('IxConversation: the joiner card', () => {
  beforeEach(() => {
    useGuildStore.setState({
      guilds: [scopeGuild({ id: 'g1', name: 'Game Night', owner_id: 'someone', description: 'Haz 5 runs.', member_count: 12 } as never, SCOPE)],
    });
    hooks.messages = [{ id: '1' }];
  });

  it('welcomes a first visit to a server you did not make, above the message box', async () => {
    renderConversation(CHANNEL);
    const joiner = screen.getByTestId('ix-joiner');
    expect(joiner).toHaveTextContent('Welcome to Game Night');
    expect(joiner).toHaveTextContent('Haz 5 runs.');
    expect(joiner.closest('.ix-composer-column')).not.toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss the welcome' }));
    expect(screen.queryByTestId('ix-joiner')).not.toBeInTheDocument();
    expect(window.localStorage.getItem('paracord:v2:guild-welcomed:g1')).toBe('1');
  });

  it('does not come back once it was dismissed, and never greets the server’s own owner', () => {
    window.localStorage.setItem('paracord:v2:guild-welcomed:g1', '1');
    renderConversation(CHANNEL);
    expect(screen.queryByTestId('ix-joiner')).not.toBeInTheDocument();
    cleanup();
    window.localStorage.clear();
    useGuildStore.setState({ guilds: [scopeGuild({ id: 'g1', name: 'Game Night', owner_id: 'me', member_count: 12 } as never, SCOPE)] });
    renderConversation(CHANNEL);
    expect(screen.queryByTestId('ix-joiner')).not.toBeInTheDocument();
  });

  it('is the empty channel’s welcome, not a card, when nothing has been said', () => {
    hooks.messages = [];
    renderConversation(CHANNEL);
    expect(screen.queryByTestId('ix-joiner')).not.toBeInTheDocument();
    expect(screen.getByTestId('ix-welcome')).toHaveAttribute('data-variant', 'joiner');
  });

  it('a card’s action is being welcomed: See who’s here opens the people sheet and puts the card away', async () => {
    const { useGlassStore } = await import('../../../stores/glassStore');
    renderConversation(CHANNEL);
    await userEvent.click(screen.getByRole('button', { name: 'See who’s here' }));
    expect(useGlassStore.getState().sheet).toBe('people');
    expect(screen.queryByTestId('ix-joiner')).not.toBeInTheDocument();
  });
});
