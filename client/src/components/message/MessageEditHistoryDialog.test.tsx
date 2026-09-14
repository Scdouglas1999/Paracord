import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode, useState } from 'react';
import { AxiosError, AxiosHeaders, type AxiosInstance, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../../types';

const clients = vi.hoisted(() => ({ byId: new Map<string, AxiosInstance>() }));
vi.mock('../../lib/connectionManager', () => ({ connectionManager: { getApiClient: (id: string) => clients.byId.get(id) } }));
vi.mock('../../lib/secureStorage', () => ({ secureSet: vi.fn(), secureGet: vi.fn(), secureDelete: vi.fn() }));
import { createApiClient } from '../../api/client';
import { useServerListStore } from '../../stores/serverListStore';
import { MessageEditHistoryDialog } from './MessageEditHistoryDialog';

const user = (id: string): User => ({ id, username: id, discriminator: 0, bot: false, system: false, flags: 0, created_at: '' });
const response = (config: InternalAxiosRequestConfig, data: unknown): AxiosResponse => ({ config, data, headers: new AxiosHeaders(), status: 200, statusText: 'OK' });
const entry = (content = 'Earlier text', message_id = '100') => ({ id: '1', message_id, content, edited_at: '2026-09-09T10:00:00Z' });
const props = () => ({ scope: { serverId: 'a', userId: '42' }, channelId: '10', messageId: '100', position: { x: 100, y: 100 }, onClose: vi.fn() });
function pending() {
  let resolve!: (value: AxiosResponse) => void;
  const promise = new Promise<AxiosResponse>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  clients.byId.clear();
  useServerListStore.setState({ activeServerId: 'a', servers: ['a', 'b'].map(id => ({ id, url: `https://${id}.test`, name: id, token: `${id}-token`, userId: '42', user: user('42'), connected: true })) });
  for (const id of ['a', 'b']) {
    const client = createApiClient(`https://${id}.test/api/v1`, () => useServerListStore.getState().getServer(id)?.token ?? null);
    client.defaults.adapter = async config => response(config, [entry()]);
    clients.byId.set(id, client);
  }
});

describe('owned edit history', () => {
  it('shows failure explicitly and retries the original server after selection changes', async () => {
    const calls: InternalAxiosRequestConfig[] = [];
    clients.byId.get('a')!.defaults.adapter = async config => {
      calls.push(config);
      if (calls.length === 1) throw new AxiosError('unavailable', 'ERR_BAD_RESPONSE', config, undefined, { ...response(config, { message: 'History service is unavailable' }), status: 503 });
      return response(config, [entry()]);
    };
    const other = vi.fn(async (config: InternalAxiosRequestConfig) => response(config, [entry('Wrong server')]));
    clients.byId.get('b')!.defaults.adapter = other;
    render(<MessageEditHistoryDialog {...props()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('History service is unavailable');
    expect(screen.queryByText('No earlier versions are available.')).not.toBeInTheDocument();
    act(() => useServerListStore.getState().setActive('b'));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Earlier text')).toBeVisible();
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call).toMatchObject({ baseURL: 'https://a.test/api/v1', url: '/channels/10/messages/100/edits', headers: { Authorization: 'Bearer a-token' } });
    expect(other).not.toHaveBeenCalled();
  });

  it.each([null, {}, [entry('Wrong message', '101')], [{ ...entry(), edited_at: 'invalid' }], [entry(), entry()]])('rejects invalid or mismatched history: %j', async data => {
    clients.byId.get('a')!.defaults.adapter = async config => response(config, data);
    render(<MessageEditHistoryDialog {...props()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('invalid history for this message');
    expect(screen.queryByText('Wrong message')).not.toBeInTheDocument();
    expect(screen.queryByText('No earlier versions are available.')).not.toBeInTheDocument();
  });

  it('only shows an empty state after a successful empty response', async () => {
    clients.byId.get('a')!.defaults.adapter = async config => response(config, []);
    render(<MessageEditHistoryDialog {...props()} />);
    expect(await screen.findByText('No earlier versions are available.')).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('aborts a preceding message request and ignores its late response', async () => {
    const old = pending(); const calls: InternalAxiosRequestConfig[] = [];
    clients.byId.get('a')!.defaults.adapter = async config => {
      calls.push(config);
      return calls.length === 1 ? old.promise : response(config, [entry('New message history', '101')]);
    };
    const p = props(); const view = render(<MessageEditHistoryDialog {...p} />);
    await waitFor(() => expect(calls).toHaveLength(1));
    view.rerender(<MessageEditHistoryDialog {...p} messageId="101" />);
    expect(calls[0].signal?.aborted).toBe(true);
    expect(await screen.findByText('New message history')).toBeVisible();
    await act(async () => { old.resolve(response(calls[0], [entry('Old message history')])); await old.promise; });
    expect(screen.queryByText('Old message history')).not.toBeInTheDocument();
    expect(screen.getByText('New message history')).toBeVisible(); expect(p.onClose).not.toHaveBeenCalled();
  });

  it('does not flash another server’s history when account and entity IDs collide', async () => {
    const late = pending(); let config!: InternalAxiosRequestConfig;
    clients.byId.get('b')!.defaults.adapter = async current => { config = current; return late.promise; };
    const p = props(); const view = render(<MessageEditHistoryDialog {...p} />);
    expect(await screen.findByText('Earlier text')).toBeVisible();
    act(() => useServerListStore.getState().setActive('b'));
    view.rerender(<MessageEditHistoryDialog {...p} scope={{ serverId: 'b', userId: '42' }} />);
    expect(screen.queryByText('Earlier text')).not.toBeInTheDocument();
    expect(screen.getByText('Loading earlier versions')).toBeVisible();
    await waitFor(() => expect(config).toBeDefined());
    await act(async () => { late.resolve(response(config, [entry('Server B history')])); await late.promise; });
    expect(await screen.findByText('Server B history')).toBeVisible();
  });

  it.each(['pending', 'loaded'] as const)('closes on account revocation while %s', async phase => {
    const late = pending(); let config!: InternalAxiosRequestConfig;
    clients.byId.get('a')!.defaults.adapter = async current => { config = current; return phase === 'loaded' ? response(current, [entry()]) : late.promise; };
    const p = props(); render(<MessageEditHistoryDialog {...p} />);
    await waitFor(() => expect(config).toBeDefined());
    if (phase === 'loaded') await screen.findByText('Earlier text');
    act(() => useServerListStore.getState().updateToken('a', ''));
    expect(config.signal?.aborted).toBe(true); expect(p.onClose).toHaveBeenCalledOnce();
    if (phase === 'pending') await act(async () => { late.resolve(response(config, [entry('Revoked history')])); await late.promise; });
    expect(screen.queryByText('Revoked history')).not.toBeInTheDocument();
  });

  it('closing cancels HTTP, prevents late updates and restores keyboard focus', async () => {
    const late = pending(); let config!: InternalAxiosRequestConfig;
    clients.byId.get('a')!.defaults.adapter = async current => { config = current; return late.promise; };
    const p = props();
    function Owner() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>Open history</button>{open && <MessageEditHistoryDialog {...p} onClose={() => setOpen(false)} />}</>;
    }
    render(<Owner />);
    const opener = screen.getByRole('button', { name: 'Open history' }); opener.focus(); fireEvent.click(opener);
    await waitFor(() => expect(config).toBeDefined());
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close edit history' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(opener).toHaveFocus();
    expect(config.signal?.aborted).toBe(true);
    await act(async () => { late.resolve(response(config, [entry()])); await late.promise; });
    expect(screen.queryByText('Earlier text')).not.toBeInTheDocument();
  });

  it('StrictMode cleanup does not mistake local disposal for account expiration', async () => {
    const p = props(); render(<StrictMode><MessageEditHistoryDialog {...p} /></StrictMode>);
    expect(await screen.findByText('Earlier text')).toBeVisible(); expect(p.onClose).not.toHaveBeenCalled();
  });

  it('does not send a request for a missing or mismatched account', async () => {
    const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => response(config, []));
    clients.byId.get('a')!.defaults.adapter = adapter;
    const p = props(); const view = render(<MessageEditHistoryDialog {...p} scope={null} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign in to this instance');
    view.rerender(<MessageEditHistoryDialog {...p} scope={{ serverId: 'a', userId: 'other' }} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('no longer signed in');
    expect(adapter).not.toHaveBeenCalled();
  });
});
