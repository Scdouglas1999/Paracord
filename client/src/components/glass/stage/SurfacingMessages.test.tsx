import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { createStore, useStore, type StoreApi } from 'zustand';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { entityScopeKey } from '../../../lib/serverScope';
import { useChannelStore } from '../../../stores/channelStore';
import type { Message } from '../../../types';
import { SURFACE_MAX, SURFACE_MS, SurfacingMessages, surfaced } from './SurfacingMessages';

/**
 * Messages surfacing over the stream while the chat is hidden (docs/glass-spec.md
 * §6.2): only what arrives after the chat was hidden, never your own, a few
 * seconds each, a mention marked, and a click brings the chat back.
 */

const SCOPE = { serverId: '__local__', userId: '42' };
const ME = vi.hoisted(() => ({ id: '42', username: 'sean', display_name: 'Sean', avatar_hash: null }));
vi.mock('../../../hooks/useCurrentUser', () => ({
  useCurrentAccountScope: () => SCOPE,
  useCurrentUser: () => ME,
}));
interface MessagesState {
  messages: Record<string, Message[]>;
}
const messages = vi.hoisted(() => ({ store: null as unknown as StoreApi<MessagesState> }));
vi.mock('../../../hooks/useMessageStore', () => ({
  useCurrentMessageStore: <T,>(selector: (state: MessagesState) => T) => useStore(messages.store, selector),
}));
vi.mock('../../../api/files', () => ({
  fileApi: { resolveAttachmentObjectUrl: vi.fn(async () => 'blob:face') },
}));

messages.store = createStore<MessagesState>(() => ({ messages: {} }));

function message(id: string, authorId: string, name: string, content: string): Message {
  return {
    id,
    channel_id: 'general',
    author: { id: authorId, username: name.toLowerCase(), display_name: name, avatar_hash: null },
    content,
    tts: false,
    mention_everyone: false,
    pinned: false,
    type: 0,
    attachments: [],
    reactions: [],
  } as unknown as Message;
}

function add(...list: Message[]) {
  act(() => {
    messages.store.setState((state) => ({
      messages: { ...state.messages, general: [...(state.messages.general ?? []), ...list] },
    }));
  });
}

function renderSurfacing(active: boolean, onShowChat = vi.fn()) {
  const view = (on: boolean) => (
    <MemoryRouter initialEntries={['/app/guilds/g1/channels/general']}>
      <Routes>
        <Route path="/app/guilds/:guildId/channels/:channelId" element={<SurfacingMessages active={on} onShowChat={onShowChat} />} />
      </Routes>
    </MemoryRouter>
  );
  const result = render(view(active));
  return { ...result, setActive: (on: boolean) => result.rerender(view(on)), onShowChat };
}

beforeEach(() => {
  vi.useRealTimers();
  useChannelStore.setState({
    channelsById: {
      [entityScopeKey(SCOPE, 'general')]: { id: 'general', name: 'General', guild_id: 'g1', type: 0, position: 0 },
    } as never,
  });
  messages.store.setState({ messages: { general: [message('100', 'jeremy', 'Jeremy', 'earlier')] } });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('surfaced', () => {
  const context = { selfUserId: '42', channelName: 'General', names: new Map([['42', 'Sean']]) };
  it('says who and where, and marks a mention of you', () => {
    expect(surfaced(message('1', 'nick', 'Nick', 'that flare placement was perfect'), context)).toMatchObject({
      name: 'Nick',
      where: 'in General',
      text: 'that flare placement was perfect',
      mention: false,
    });
    expect(surfaced(message('2', 'jeremy', 'Jeremy', '<@42> is movie night still on?'), context)).toMatchObject({
      where: 'mentioned you',
      text: '@Sean is movie night still on?',
      mention: true,
    });
  });

  it('never surfaces your own messages or a system line', () => {
    expect(surfaced(message('3', '42', 'Sean', 'mine'), context)).toBeNull();
    expect(surfaced({ ...message('4', 'nick', 'Nick', 'joined'), type: 7 } as Message, context)).toBeNull();
  });
});

describe('SurfacingMessages', () => {
  it('shows only what arrives after the chat was hidden, and a click brings the chat back', () => {
    const { onShowChat } = renderSurfacing(true);
    expect(screen.queryByRole('button', { name: /Show chat/ })).not.toBeInTheDocument();
    add(message('101', 'nick', 'Nick', 'that flare placement was perfect'), message('102', '42', 'Sean', 'mine'));
    const button = screen.getByRole('button', { name: 'Show chat, 1 new message' });
    expect(button).toHaveTextContent('Nick in General');
    expect(button).not.toHaveTextContent('mine');
    add(message('103', 'jeremy', 'Jeremy', '<@42> is movie night still on?'));
    expect(screen.getByRole('button', { name: 'Show chat, 2 new messages' })).toHaveTextContent('Jeremy mentioned you');
    expect(document.querySelector('.glass-surfacing__bubble[data-mention="true"]')).toHaveTextContent('movie night');
    // Announced, since the chat that would carry it is hidden.
    expect(screen.getByRole('status')).toHaveTextContent('Jeremy mentioned you: @Sean is movie night still on?');
    fireEvent.click(screen.getByRole('button', { name: /Show chat/ }));
    expect(onShowChat).toHaveBeenCalledTimes(1);
  });

  it('keeps each for a few seconds, and at most a few at once', () => {
    vi.useFakeTimers();
    renderSurfacing(true);
    add(
      message('101', 'nick', 'Nick', 'one'),
      message('102', 'nick', 'Nick', 'two'),
      message('103', 'nick', 'Nick', 'three'),
      message('104', 'nick', 'Nick', 'four'),
    );
    expect(document.querySelectorAll('.glass-surfacing__bubble')).toHaveLength(SURFACE_MAX);
    expect(screen.getByRole('button', { name: /Show chat/ })).not.toHaveTextContent('one');
    act(() => {
      vi.advanceTimersByTime(SURFACE_MS + 10);
    });
    expect(document.querySelectorAll('.glass-surfacing__bubble')).toHaveLength(0);
  });

  it('draws nothing while the chat is shown, and clears when it comes back', () => {
    const view = renderSurfacing(false);
    add(message('101', 'nick', 'Nick', 'while shown'));
    expect(document.querySelector('.glass-surfacing')).toBeNull();
    view.setActive(true);
    // The line is drawn when the chat is hidden: what came before does not surface.
    expect(screen.queryByRole('button', { name: /Show chat/ })).not.toBeInTheDocument();
    add(message('102', 'nick', 'Nick', 'after hiding'));
    expect(screen.getByRole('button', { name: /Show chat/ })).toHaveTextContent('after hiding');
    view.setActive(false);
    expect(document.querySelector('.glass-surfacing')).toBeNull();
  });
});
