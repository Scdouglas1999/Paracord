import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useGuildStore } from '../../../stores/guildStore';
import { useServerConnectionStore, type ServerConnectionState } from '../../../stores/serverConnectionStore';
import { useServerListStore } from '../../../stores/serverListStore';
import { PLACE_MEMORY_KEY } from '../people/lastPlace';
import { useServerSignInDialog } from '../session/serverSignInDialogStore';
import { ServerUnavailable } from './ServerUnavailable';

const retryServer = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../../gateway/manager', () => ({ gateway: { retryServer } }));

/**
 * The sidebar of a server you cannot see yet: it says where its saved server stands,
 * never "not available" while the server is only connecting, unreachable or signed out.
 */

function phase(serverId: string, state: Partial<ServerConnectionState> & Pick<ServerConnectionState, 'phase'>) {
  useServerConnectionStore.getState().set(serverId, { attempts: 0, retryAt: null, endedHere: false, ...state });
}

beforeEach(() => {
  window.localStorage.clear();
  retryServer.mockClear();
  useServerConnectionStore.getState().reset();
  useServerSignInDialog.setState({ serverId: null });
  useGuildStore.setState({ guilds: [] });
  useServerListStore.setState({
    activeServerId: 's_lan',
    servers: [
      { id: 's_lan', name: 'Lantern', url: 'https://192.168.1.28:8443', token: 'x', connected: false },
      { id: 's_other', name: '', url: 'https://other.example:8443', token: 'y', connected: false },
    ],
  });
});

describe('ServerUnavailable', () => {
  it('says it is connecting, quietly, while the first connect is under way (or not asked yet)', () => {
    render(<ServerUnavailable guildId="g1" />);
    expect(screen.getByTestId('ix-server-unavailable')).toHaveAttribute('data-state', 'connecting');
    expect(screen.getByRole('status')).toHaveTextContent('Connecting to Lantern…');
    expect(screen.queryByText(/not available/)).toBeNull();
  });

  it('offers Try now while the server is unreachable and being retried', () => {
    phase('s_lan', { phase: 'retrying', attempts: 3, retryAt: Date.now() + 8_000 });
    render(<ServerUnavailable guildId="g1" />);
    expect(screen.getByRole('status')).toHaveTextContent('Can’t reach Lantern right now. Trying again.');
    fireEvent.click(screen.getByRole('button', { name: 'Try now' }));
    expect(retryServer).toHaveBeenCalledWith('s_lan');
  });

  it('offers Sign in again when the server refused the session', () => {
    phase('s_lan', { phase: 'signed-out', endedHere: true });
    render(<ServerUnavailable guildId="g1" />);
    expect(screen.getByText('You’re signed out of Lantern.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect(useServerSignInDialog.getState().serverId).toBe('s_lan');
  });

  it('is "not available" only once its server is connected and the server is still not in your list', () => {
    phase('s_lan', { phase: 'connected' });
    render(<ServerUnavailable guildId="g1" />);
    expect(screen.getByTestId('ix-server-unavailable')).toHaveAttribute('data-state', 'unavailable');
    expect(screen.getByText('This server is not available.')).toBeInTheDocument();
  });

  it('finds the saved server from the remembered place before any list has arrived, and names it by address when unnamed', () => {
    window.localStorage.setItem(PLACE_MEMORY_KEY, JSON.stringify({ userId: 'me', place: 'g7', path: null, people: null, serverId: 's_other' }));
    phase('s_other', { phase: 'retrying', attempts: 1, retryAt: Date.now() + 1_000 });
    render(<ServerUnavailable guildId="g7" />);
    expect(screen.getByRole('status')).toHaveTextContent('Can’t reach other.example:8443 right now.');
  });
});
