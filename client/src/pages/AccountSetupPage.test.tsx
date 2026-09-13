import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, expect, it, vi } from 'vitest';
import type { User } from '../types';
const enrollment = vi.hoisted(() => ({ attach: vi.fn(), capture: vi.fn() }));
vi.mock('../lib/crypto/attachAccountIdentity', () => ({ attachAccountIdentity: enrollment.attach }));
vi.mock('../lib/operationContext', () => ({ captureScopedOperation: enrollment.capture }));
vi.mock('../lib/secureStorage', () => ({ secureGet: vi.fn(), secureSet: vi.fn(), secureDelete: vi.fn() }));
import { useAccountStore } from '../stores/accountStore';
import { useAuthStore } from '../stores/authStore';
import { useServerListStore } from '../stores/serverListStore';
import { AccountSetupPage } from './AccountSetupPage';

const account: User = { id: '42', username: 'alice', discriminator: 0, bot: false, system: false, flags: 0, created_at: '' };
const create = vi.fn(); const unlock = vi.fn();
function setup(query = 'migrate=1&server=a&user=42&returnTo=%2Fapp%2Fdm%2F100') {
  return render(<MemoryRouter initialEntries={[`/setup?${query}`]}><Routes>
    <Route path="/setup" element={<AccountSetupPage />} /><Route path="/app/dm/100" element={<p>Back to conversation</p>} />
  </Routes></MemoryRouter>);
}
beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ token: 'home-token', user: { ...account, id: 'home', username: 'home' } });
  useServerListStore.setState({ activeServerId: 'a', servers: [{ id: 'a', name: 'Studio', url: 'https://a.test', token: 'token', user: account, userId: account.id, connected: true }] });
  useAccountStore.setState({ publicKey: null, isUnlocked: false, create, unlock, getRecoveryPhrase: () => Array(24).fill('word').join(' '), hasAccount: () => Boolean(useAccountStore.getState().publicKey) });
  create.mockImplementation(async () => useAccountStore.setState({ publicKey: 'a'.repeat(64), isUnlocked: true }));
  unlock.mockImplementation(async () => useAccountStore.setState({ isUnlocked: true }));
  enrollment.capture.mockImplementation(scope => ({ scope, user: account, dispose: vi.fn() }));
  enrollment.attach.mockResolvedValue(account);
});

it('keeps the created key after a failed attach and retries with the separate server password', async () => {
  enrollment.attach.mockRejectedValueOnce(new Error('Server password rejected'));
  setup(); const user = userEvent.setup();
  await user.type(screen.getByLabelText('New Encryption Password', { exact: false }), 'local encryption password');
  await user.type(screen.getByLabelText('Confirm Password', { exact: false }), 'local encryption password');
  await user.type(screen.getByLabelText('Current Server Password', { exact: false }), 'wrong server password');
  await user.type(screen.getByLabelText('Two-factor or backup code'), '123456');
  await user.click(screen.getByRole('button', { name: 'Secure Account' }));
  expect(await screen.findByText('Server password rejected')).toBeInTheDocument();
  expect(screen.queryByText('Recovery Phrase', { exact: true })).not.toBeInTheDocument();
  expect(create).toHaveBeenCalledWith('alice', 'local encryption password', undefined);
  expect(enrollment.attach.mock.calls[0][1]).toBe('wrong server password');
  expect(enrollment.attach.mock.calls[0][2]).toBe('123456');
  await user.clear(screen.getByLabelText('Current Server Password', { exact: false }));
  await user.type(screen.getByLabelText('Current Server Password', { exact: false }), 'correct server password');
  await user.click(screen.getByRole('button', { name: 'Secure Account' }));
  expect(await screen.findByText('Recovery Phrase', { exact: true })).toBeInTheDocument();
  expect(create).toHaveBeenCalledTimes(1);
  expect(enrollment.attach.mock.calls[1][0].scope).toEqual({ serverId: 'a', userId: '42' });
  expect(enrollment.attach.mock.calls[1][1]).toBe('correct server password');
  await user.click(screen.getByRole('checkbox'));
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  expect(screen.getByText('Back to conversation')).toBeInTheDocument();
});

it('unlocks a saved identity instead of replacing it after reopening setup', async () => {
  useAccountStore.setState({ publicKey: 'a'.repeat(64), isUnlocked: false });
  setup(); const user = userEvent.setup();
  await user.type(screen.getByLabelText('Encryption Password', { exact: false }), 'existing encryption password');
  await user.type(screen.getByLabelText('Current Server Password', { exact: false }), 'server password');
  await user.click(screen.getByRole('button', { name: 'Secure Account' }));
  expect(await screen.findByText('Recovery Phrase', { exact: true })).toBeInTheDocument();
  expect(unlock).toHaveBeenCalledWith('existing encryption password'); expect(create).not.toHaveBeenCalled();
});

it('rejects an account-swapped setup link before creating an identity', async () => {
  setup('migrate=1&server=a&user=another-account');
  expect(screen.getByText('Account changed')).toBeInTheDocument();
  expect(create).not.toHaveBeenCalled(); expect(enrollment.attach).not.toHaveBeenCalled();
});


it('waits for profile hydration before binding a reloaded setup page', async () => {
  const server = useServerListStore.getState().servers[0];
  useServerListStore.setState({ servers: [{ ...server, user: undefined, userId: undefined }] });
  setup();
  expect(screen.getByText('Waiting for your server account')).toBeInTheDocument();
  act(() => useServerListStore.setState({ servers: [server] }));
  expect(await screen.findByLabelText('Username', { exact: false })).toHaveValue('alice');
  expect(screen.getByRole('button', { name: 'Secure Account' })).toBeInTheDocument();
});
