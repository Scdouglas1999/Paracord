import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { AccountVault } from './accountVault';
import { openAccountVault } from './accountVaultSession';
import { clearUnlockedPrivateKey, setUnlockedPrivateKey } from '../accountSession';
import { useServerListStore } from '../../stores/serverListStore';
import { bytesToHex } from './util';

const clients = vi.hoisted(() => ({ remote: null as unknown }));
vi.mock('../connectionManager', () => ({ connectionManager: { getApiClient: () => clients.remote } }));
vi.mock('../secureStorage', () => ({ secureSet: vi.fn(), secureGet: vi.fn(), secureDelete: vi.fn() }));
const scope = { serverId: 'a', userId: 'viewer' };
const close = vi.fn();

beforeEach(() => {
  clients.remote = axios.create(); close.mockReset();
  const key = new Uint8Array(32).fill(7);
  const publicKey = bytesToHex(ed25519.getPublicKey(key));
  setUnlockedPrivateKey(key);
  useServerListStore.setState({ activeServerId: 'a', servers: ['a', 'b'].map(id => ({
    id, url: `https://${id}.test`, name: id, token: 'token', userId: 'viewer', connected: true,
    user: { id: 'viewer', public_key: publicKey } as never,
  })) });
  vi.spyOn(AccountVault, 'open').mockResolvedValue({ close } as unknown as AccountVault);
});
afterEach(() => { clearUnlockedPrivateKey(); vi.restoreAllMocks(); });

describe('verified encrypted storage session', () => {
  it('binds storage and network to the row account across selection changes', async () => {
    const session = await openAccountVault(scope);
    useServerListStore.getState().setActive('b');
    session.assertCurrent();
    expect(session.context.scope).toEqual(scope);
    expect(AccountVault.open).toHaveBeenCalledWith(scope, expect.any(Uint8Array), expect.any(Object));
    expect(session.signal.aborted).toBe(false);
    session.dispose();
    expect(session.privateKey.every(value => value === 0)).toBe(true);
    expect(session.signal.aborted).toBe(true);
  });

  it('requires the identity enrolled for the verified server account', async () => {
    setUnlockedPrivateKey(new Uint8Array(32).fill(8));
    await expect(openAccountVault(scope)).rejects.toThrow(/identity enrolled/);
    expect(AccountVault.open).not.toHaveBeenCalled();
  });

  it('closes storage and wipes the lease immediately on account revocation', async () => {
    const session = await openAccountVault(scope);
    useServerListStore.getState().updateToken('a', '');
    expect(session.signal.aborted).toBe(true);
    expect(close).toHaveBeenCalled();
    expect(session.privateKey.every(value => value === 0)).toBe(true);
    expect(() => session.assertCurrent()).toThrow();
  });

  it('closes storage immediately on identity lock', async () => {
    const session = await openAccountVault(scope);
    clearUnlockedPrivateKey();
    expect(session.signal.aborted).toBe(true);
    expect(close).toHaveBeenCalled();
    expect(session.context.signal.aborted).toBe(true);
  });
});


it('rejects further operations after the enrolled identity changes for the same account', async () => {
  const session = await openAccountVault(scope);
  useServerListStore.setState(state => ({ servers: state.servers.map(server => server.id === 'a'
    ? { ...server, user: { ...server.user!, public_key: bytesToHex(ed25519.getPublicKey(new Uint8Array(32).fill(8))) } }
    : server) }));
  expect(() => session.assertCurrent()).toThrow(/identity enrolled/);
  expect(session.signal.aborted).toBe(true);
  expect(session.privateKey.every(value => value === 0)).toBe(true);
});
