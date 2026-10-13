import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearStoredServerUrl, setStoredServerUrl } from '../../../lib/config/apiBaseUrl';
import { LOCAL_SERVER_ID } from '../../../lib/serverScope';
import { useIdentityChangeStore } from '../../../lib/trustedHosts';
import { useAuthStore } from '../../../stores/authStore';
import { useServerConnectionStore } from '../../../stores/serverConnectionStore';
import { HomeIdentityChanged, useHomeIdentityChange } from './HomeIdentityChanged';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../../../lib/tauriEnv', () => ({ isTauri: () => true }));
const gateway = vi.hoisted(() => ({ connectAll: vi.fn(async () => undefined) }));
vi.mock('../../../gateway/manager', () => ({ gateway }));

const HOME = 'https://203.0.113.1:8443';
const OLD = '00'.repeat(32);
const NEW = 'ff'.repeat(32);

function Probe() {
  const found = useHomeIdentityChange();
  return found ? <HomeIdentityChanged url={found.url} /> : <p>signed-in form</p>;
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  gateway.connectAll.mockClear();
  setStoredServerUrl(HOME);
  useIdentityChangeStore.setState({
    changes: { '203.0.113.1': { host: '203.0.113.1', pinnedFp: OLD, presentedFp: NEW } },
  });
});

afterEach(() => {
  clearStoredServerUrl();
  useIdentityChangeStore.setState({ changes: {} });
});

describe('the launch screen for the first run server whose identity changed (bug F1)', () => {
  it('names it and holds until it is reviewed, instead of the sign-in form', async () => {
    render(<Probe />);
    expect(screen.getByRole('heading', { name: '203.0.113.1:8443 has a new identity' })).toBeInTheDocument();
    expect(screen.getByText('It stays disconnected until you review it.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(await screen.findByRole('alertdialog')).toHaveAccessibleName('203.0.113.1:8443 has a new identity');
    fireEvent.click(screen.getByRole('button', { name: 'Stay disconnected' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    // Held: still this screen, nothing asked of the shell or the server.
    expect(screen.getByTestId('home-identity-changed')).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
    expect(gateway.connectAll).not.toHaveBeenCalled();
  });

  it('re-pins, restores the session and connects when the new identity is trusted', async () => {
    const initializeSession = vi.fn(async () => {
      useAuthStore.setState({ token: 'home-access', sessionBootstrapComplete: true });
    });
    useAuthStore.setState({ initializeSession, sessionBootstrapComplete: true });
    useServerConnectionStore.getState().set(LOCAL_SERVER_ID, { phase: 'identity-changed', attempts: 0, retryAt: null, endedHere: false });
    vi.mocked(invoke).mockResolvedValue(undefined);
    render(<Probe />);
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    const trust = await screen.findByRole('button', { name: 'Trust the new identity' });
    await waitFor(() => expect(trust).toBeEnabled());
    fireEvent.click(trust);

    await waitFor(() => expect(gateway.connectAll).toHaveBeenCalled());
    expect(invoke).toHaveBeenCalledWith('accept_changed_identity', { host: '203.0.113.1', presentedFp: NEW });
    expect(initializeSession).toHaveBeenCalled();
    expect(useServerConnectionStore.getState().servers[LOCAL_SERVER_ID]).toBeUndefined();
    // The record is gone, so the guard lets the app open.
    expect(screen.getByText('signed-in form')).toBeInTheDocument();
  });
});
