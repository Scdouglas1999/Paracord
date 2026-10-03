import { act, render } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';

import { useUIStore } from '../../../stores/uiStore';
import {
  isConversationRoute,
  isPlacesRoute,
  usePhoneNavStore,
  usePhoneNavigation,
  usePhoneScreen,
} from './phoneNav';

function Probe({ enabled }: { enabled: boolean }) {
  usePhoneNavigation(enabled);
  const screen = usePhoneScreen();
  return (
    <>
      <span data-testid="screen">{screen}</span>
      <Link to="/app/guilds/g1/channels/c1">a channel</Link>
      <Link to="/app/dms">the messages index</Link>
      <Link to="/app">home</Link>
      <Link to="/app/friends">friends</Link>
    </>
  );
}

function renderAt(path: string, enabled = true) {
  const tree = (on: boolean, at: string) => (
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route path="*" element={<Probe enabled={on} />} />
      </Routes>
    </MemoryRouter>
  );
  const view = render(tree(enabled, path));
  return { ...view, rerenderEnabled: (on: boolean) => view.rerender(tree(on, path)) };
}

beforeEach(() => {
  usePhoneNavStore.getState().setScreen(null);
  useUIStore.setState({ sidebarCollapsed: true });
});

describe('the phone routes', () => {
  it('knows which pages are the list itself: the messages index', () => {
    expect(isPlacesRoute('/app')).toBe(false);
    expect(isPlacesRoute('/app/')).toBe(false);
    expect(isPlacesRoute('/app/dms')).toBe(true);
    expect(isPlacesRoute('/app/dms/')).toBe(true);
    expect(isPlacesRoute('/app/dms/123')).toBe(false);
    expect(isPlacesRoute('/app/friends')).toBe(false);
    expect(isPlacesRoute('/app/guilds/g1')).toBe(false);
    expect(isPlacesRoute('/app/guilds/g1/channels/c1')).toBe(false);
  });

  it('knows which pages draw their own conversation pane (and so their own pill)', () => {
    expect(isConversationRoute('/app/guilds/g1/channels/c1')).toBe(true);
    expect(isConversationRoute('/app/dms/123')).toBe(true);
    expect(isConversationRoute('/app')).toBe(false);
    expect(isConversationRoute('/app/dms')).toBe(false);
    expect(isConversationRoute('/app/friends')).toBe(false);
    expect(isConversationRoute('/app/guilds/g1')).toBe(false);
    expect(isConversationRoute('/app/guilds/g1/settings')).toBe(false);
  });
});

describe('usePhoneNavigation', () => {
  it('chooses no screen until the window is a phone, and a conversation for a page that is not the list', () => {
    const view = renderAt('/app/guilds/g1/channels/c1', false);
    expect(usePhoneNavStore.getState().screen).toBeNull();
    // Nothing chosen draws as the conversation: a wide window never shows places as a screen.
    expect(view.getByTestId('screen')).toHaveTextContent('conversation');

    view.rerenderEnabled(true);
    expect(usePhoneNavStore.getState().screen).toBe('conversation');
  });

  it('opens the messages index on places', () => {
    renderAt('/app/dms');
    expect(usePhoneNavStore.getState().screen).toBe('places');
  });

  it('opens a deep link on its page', () => {
    renderAt('/app/dms/123');
    expect(usePhoneNavStore.getState().screen).toBe('conversation');
  });

  it('forgets its screen when the window stops being a phone', () => {
    const view = renderAt('/app');
    expect(usePhoneNavStore.getState().screen).toBe('conversation');
    view.rerenderEnabled(false);
    expect(usePhoneNavStore.getState().screen).toBeNull();
  });

  it('shows places for the messages index and the welcome page for Home', () => {
    const view = renderAt('/app/guilds/g1/channels/c1');
    expect(usePhoneNavStore.getState().screen).toBe('conversation');

    act(() => view.getByRole('link', { name: 'the messages index' }).click());
    expect(usePhoneNavStore.getState().screen).toBe('places');

    act(() => usePhoneNavStore.getState().showConversation());
    act(() => view.getByRole('link', { name: 'home' }).click());
    expect(usePhoneNavStore.getState().screen).toBe('conversation');
  });

  it('leaves the screen alone for any other navigation: the list decides what a tap on a row means', () => {
    const view = renderAt('/app/guilds/g1/channels/c1');
    act(() => usePhoneNavStore.getState().showPlaces());
    act(() => view.getByRole('link', { name: 'friends' }).click());
    expect(usePhoneNavStore.getState().screen).toBe('places');
    act(() => usePhoneNavStore.getState().showConversation());
    act(() => view.getByRole('link', { name: 'a channel' }).click());
    expect(usePhoneNavStore.getState().screen).toBe('conversation');
  });

  it('turns the old drawer request into the places screen and puts the flag back', () => {
    renderAt('/app/guilds/g1/channels/c1');
    expect(usePhoneNavStore.getState().screen).toBe('conversation');

    // The conversation header's drawer button and Ctrl+B open the drawer flag.
    act(() => useUIStore.getState().setSidebarCollapsed(false));
    expect(usePhoneNavStore.getState().screen).toBe('places');
    expect(useUIStore.getState().sidebarCollapsed).toBe(true);
  });

  it('takes no drawer request when it is not a phone', () => {
    renderAt('/app/guilds/g1/channels/c1', false);
    act(() => useUIStore.getState().setSidebarCollapsed(false));
    expect(usePhoneNavStore.getState().screen).toBeNull();
    expect(useUIStore.getState().sidebarCollapsed).toBe(false);
  });

  it('is reset with the session', async () => {
    const { resetSessionStores } = await import('../../../stores/sessionReset');
    renderAt('/app');
    expect(usePhoneNavStore.getState().screen).toBe('conversation');
    await resetSessionStores();
    expect(usePhoneNavStore.getState().screen).toBeNull();
  });
});
