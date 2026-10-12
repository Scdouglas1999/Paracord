import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAuthStore } from '../../../stores/authStore';
import { useServerConnectionStore } from '../../../stores/serverConnectionStore';
import { useServerListStore } from '../../../stores/serverListStore';
import { ServerSessionBanner } from './ServerSessionBanner';
import { ServerSignInDialog } from './ServerSignInDialog';
import { useServerSignInDialog } from './serverSignInDialogStore';

const signIn = vi.hoisted(() => ({
  signInToServer: vi.fn(),
  completeServerSecondFactor: vi.fn(),
}));
vi.mock('../../../lib/serverSignIn', () => ({
  ...signIn,
  serverSignInError: (_error: unknown, name: string) => `Could not reach ${name}.`,
}));

beforeEach(() => {
  signIn.signInToServer.mockReset();
  signIn.completeServerSecondFactor.mockReset();
  useServerConnectionStore.getState().reset();
  useServerSignInDialog.setState({ serverId: null });
  useAuthStore.setState({ token: null });
  useServerListStore.setState({
    servers: [
      { id: 's_lan', name: 'Lantern', url: 'https://192.168.1.28:8443', token: '', connected: false },
      { id: 's_home', name: 'Home', url: 'https://home.example', token: 'live', connected: true },
    ],
  });
});

describe('the signed-out banner', () => {
  it('names a server that ended your session during this run and opens Sign in again', () => {
    useServerConnectionStore.getState().set('s_lan', { phase: 'signed-out', attempts: 0, retryAt: null, endedHere: true });
    render(<ServerSessionBanner />);
    expect(screen.getByTestId('ix-banner-signed-out')).toHaveTextContent('You’re signed out of Lantern.');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect(useServerSignInDialog.getState().serverId).toBe('s_lan');
  });

  it('says nothing about an entry that never had a session, or when no session is left at all', () => {
    useServerConnectionStore.getState().set('s_lan', { phase: 'signed-out', attempts: 0, retryAt: null, endedHere: false });
    const { rerender } = render(<ServerSessionBanner />);
    expect(screen.queryByTestId('ix-banner-signed-out')).toBeNull();

    useServerConnectionStore.getState().set('s_lan', { phase: 'signed-out', attempts: 0, retryAt: null, endedHere: true });
    useServerListStore.setState({ servers: useServerListStore.getState().servers.map((server) => ({ ...server, token: '' })) });
    rerender(<ServerSessionBanner />);
    expect(screen.queryByTestId('ix-banner-signed-out')).toBeNull();
  });
});

describe('the identity-changed banner (docs/setup-spec.md §7.4)', () => {
  it('names a server whose certificate changed and opens the review sheet', async () => {
    useServerConnectionStore.getState().set('s_lan', { phase: 'identity-changed', attempts: 0, retryAt: null, endedHere: false });
    render(<ServerSessionBanner />);
    expect(screen.getByTestId('ix-banner-identity-changed')).toHaveTextContent(
      'Lantern has a new identity. It stays disconnected until you review it.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(await screen.findByRole('heading', { name: 'Lantern has a new identity' })).toBeInTheDocument();
  });
});

describe('Sign in again', () => {
  it('signs in with the password and closes', async () => {
    signIn.signInToServer.mockResolvedValue({ kind: 'signed-in' });
    act(() => useServerSignInDialog.getState().open('s_lan'));
    render(<ServerSignInDialog />);
    expect(screen.getByRole('heading', { name: 'Sign in to Lantern' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Email or username'), { target: { value: 'owner' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Correct-Horse-9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(useServerSignInDialog.getState().serverId).toBeNull());
    expect(signIn.signInToServer).toHaveBeenCalledWith('s_lan', 'owner', 'Correct-Horse-9');
  });

  it('asks for the second factor when the account has one', async () => {
    signIn.signInToServer.mockResolvedValue({ kind: 'second-factor', ticket: 't1' });
    signIn.completeServerSecondFactor.mockResolvedValue({ kind: 'signed-in' });
    act(() => useServerSignInDialog.getState().open('s_lan'));
    render(<ServerSignInDialog />);
    fireEvent.change(screen.getByLabelText('Email or username'), { target: { value: 'owner' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    const code = await screen.findByLabelText('Code');
    fireEvent.change(code, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(useServerSignInDialog.getState().serverId).toBeNull());
    expect(signIn.completeServerSecondFactor).toHaveBeenCalledWith('s_lan', 't1', '123456');
  });

  it('says why a sign-in did not work and stays open', async () => {
    signIn.signInToServer.mockRejectedValue(new Error('offline'));
    act(() => useServerSignInDialog.getState().open('s_lan'));
    render(<ServerSignInDialog />);
    fireEvent.change(screen.getByLabelText('Email or username'), { target: { value: 'owner' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach Lantern.');
    expect(useServerSignInDialog.getState().serverId).toBe('s_lan');
  });
});
