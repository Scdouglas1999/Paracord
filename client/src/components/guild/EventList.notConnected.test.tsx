import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AxiosInstance } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useServerConnectionStore, type ServerConnectionState } from '../../stores/serverConnectionStore';
import { useServerListStore } from '../../stores/serverListStore';
import { useServerSignInDialog } from '../ix/session/serverSignInDialogStore';
import { EventList, EventsIndicator } from './EventList';

/**
 * The Events page and its count chip for a selected server that has no connection yet
 * (a relaunch, a restart, a refused session). Asking at once used to throw "This server
 * is not connected" out of an effect and into the error boundary: the whole page went.
 * Now they wait, say where the server stands, and ask once it is there.
 */

const mocks = vi.hoisted(() => ({
  client: undefined as AxiosInstance | undefined,
  getApiClient: vi.fn((): AxiosInstance | undefined => undefined),
  retryServer: vi.fn(async () => {}),
}));

vi.mock('../../lib/connectionManager', () => ({
  LOCAL_SERVER_ID: '__local__',
  connectionManager: { getApiClient: mocks.getApiClient, retryServer: mocks.retryServer },
}));
vi.mock('../../api/client', () => ({
  apiClient: { get: vi.fn(), put: vi.fn(), patch: vi.fn(), post: vi.fn(), delete: vi.fn() },
  extractApiError: (error: { message?: string }) => error?.message ?? 'request failed',
}));
vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: () => ({ permissions: 0n, isAdmin: false, isOwner: false, isLoading: false }),
}));
vi.mock('../../stores/authStore', () => ({
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) => selector({ user: { id: 'user-1' } }),
}));
vi.mock('../../stores/toastStore', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const event = {
  id: 'event-1', guild_id: 'guild-1', channel_id: null, creator_id: 'user-1', name: 'Movie night', description: null,
  scheduled_start: '2099-06-01T16:00:00.000Z', scheduled_end: null, status: 1, entity_type: 2, location: 'Online',
  image_url: null, user_count: 1, user_rsvp: false, created_at: '2026-05-01T00:00:00.000Z',
};

function phase(state: Partial<ServerConnectionState> & Pick<ServerConnectionState, 'phase'>) {
  act(() => useServerConnectionStore.getState().set('s_lan', { attempts: 0, retryAt: null, endedHere: false, ...state }));
}

function connectWith(get: ReturnType<typeof vi.fn>) {
  mocks.getApiClient.mockReturnValue({ get } as unknown as AxiosInstance);
  phase({ phase: 'connected' });
}

beforeEach(() => {
  mocks.getApiClient.mockReset();
  mocks.getApiClient.mockReturnValue(undefined);
  mocks.retryServer.mockClear();
  useServerConnectionStore.getState().reset();
  useServerSignInDialog.setState({ serverId: null });
  useServerListStore.setState({
    activeServerId: 's_lan',
    servers: [{ id: 's_lan', name: 'Lantern', url: 'https://192.168.1.28:8443', token: 'x', connected: false }],
  });
});
afterEach(cleanup);

describe('EventList on a server that is not connected', () => {
  it('shows its loading state while the server connects, and asks nothing', () => {
    // A throw out of the effect would fail this render.
    const { container } = render(<EventList guildId="guild-1" variant="page" />);
    expect(container.querySelectorAll('.pc-skeleton')).toHaveLength(3);
    expect(screen.queryByText(/Failed to load events/)).toBeNull();
    expect(screen.queryByTestId('ix-section-waiting')).toBeNull();
    expect(mocks.getApiClient).not.toHaveBeenCalled();
  });

  it('asks once the server is connected, without a reload', async () => {
    render(<EventList guildId="guild-1" variant="page" />);
    const get = vi.fn().mockResolvedValue({ data: [event] });
    connectWith(get);
    expect(await screen.findByText('Movie night')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/guilds/guild-1/events');
  });

  it('says the server is unreachable, with Try now, instead of crashing', () => {
    phase({ phase: 'retrying', attempts: 2, retryAt: Date.now() + 4_000 });
    render(<EventList guildId="guild-1" variant="page" />);
    expect(screen.getByTestId('ix-section-waiting')).toHaveAttribute('data-state', 'retrying');
    expect(screen.getByRole('status')).toHaveTextContent('Can’t reach Lantern right now. Trying again.');
    fireEvent.click(screen.getByRole('button', { name: 'Try now' }));
    expect(mocks.retryServer).toHaveBeenCalledWith('s_lan');
    expect(mocks.getApiClient).not.toHaveBeenCalled();
  });

  it('offers Sign in again when the server refused the session', () => {
    phase({ phase: 'signed-out', endedHere: true });
    render(<EventList guildId="guild-1" variant="page" />);
    expect(screen.getByRole('status')).toHaveTextContent('You’re signed out of Lantern.');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect(useServerSignInDialog.getState().serverId).toBe('s_lan');
  });

  it('turns a connection that vanished at the last moment into the page’s own error, not a throw', async () => {
    // The phase says connected but the client is gone (a restart between the two reads).
    phase({ phase: 'connected' });
    render(<EventList guildId="guild-1" variant="page" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load events: This server is not connected');
    // Try again asks again, and now it works.
    const get = vi.fn().mockResolvedValue({ data: [event] });
    mocks.getApiClient.mockReturnValue({ get } as unknown as AxiosInstance);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Movie night')).toBeInTheDocument();
  });

  it('keeps the list on screen across a blip of the connection and does not ask again', async () => {
    const get = vi.fn().mockResolvedValue({ data: [event] });
    connectWith(get);
    render(<EventList guildId="guild-1" variant="page" />);
    expect(await screen.findByText('Movie night')).toBeInTheDocument();
    phase({ phase: 'connecting' });
    phase({ phase: 'connected' });
    expect(screen.getByText('Movie night')).toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(1);
  });
});

describe('EventsIndicator on a server that is not connected', () => {
  it('renders nothing and asks nothing until the server is connected', async () => {
    const { container } = render(<EventsIndicator guildId="guild-1" />);
    expect(container).toBeEmptyDOMElement();
    expect(mocks.getApiClient).not.toHaveBeenCalled();

    const get = vi.fn().mockResolvedValue({ data: [event, { ...event, id: 'event-2' }] });
    connectWith(get);
    await waitFor(() => expect(container).toHaveTextContent('2'));
  });

  it('shows no count when the client is gone at the last moment, and does not throw', async () => {
    phase({ phase: 'connected' });
    const { container } = render(<EventsIndicator guildId="guild-1" />);
    await waitFor(() => expect(mocks.getApiClient).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
