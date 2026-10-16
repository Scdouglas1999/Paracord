import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * "Use your recovery phrase" failed on the desktop with "Native fetch requires
 * an absolute URL".
 *
 * A desktop page is served from the app bundle, so with no server chosen (a
 * fresh profile: the Server field on sign-in still empty, nothing saved) the
 * API base is a bare `/api/v1`. The recovery page sent its requests there, the
 * shell refused them with its own internal sentence, and the page showed that
 * sentence. These run the real page, the real account flows and the real
 * desktop HTTP adapter against a shell that refuses exactly as the Rust side
 * does.
 */

const shell = vi.hoisted(() => ({
  urls: [] as string[],
  answer: null as null | ((url: string) => unknown),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args?: { req?: { url: string } }) => {
    if (command !== 'native_fetch' && command !== 'native_multipart') return null;
    const url = args!.req!.url;
    shell.urls.push(url);
    // client/src-tauri/src/lib.rs ensure_native_fetch_target_is_trusted
    try {
      new URL(url);
    } catch {
      throw 'Native fetch requires an absolute URL';
    }
    if (shell.answer) return shell.answer(url);
    throw 'error sending request for url: Connection refused (os error 111)';
  }),
}));
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};

const legacyRecover = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../stores/accountStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../stores/accountStore')>();
  const state = () => ({ ...actual.useAccountStore.getState(), recover: legacyRecover });
  return {
    ...actual,
    useAccountStore: Object.assign(
      (selector: (s: ReturnType<typeof state>) => unknown) => selector(state()),
      { getState: state, setState: actual.useAccountStore.setState },
    ),
  };
});

const PHRASE = Array.from({ length: 24 }, () => 'abandon').join(' ');

async function renderRecover() {
  const { AccountRecoverPage } = await import('./AccountRecoverPage');
  render(
    <MemoryRouter initialEntries={['/welcome/sign-in', '/recover']} initialIndex={1}>
      <Routes>
        <Route path="/recover" element={<AccountRecoverPage />} />
        <Route path="/welcome/sign-in" element={<div>Sign-in screen</div>} />
        <Route path="/app" element={<div>App shell</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

async function submitPhraseAndPassword() {
  fireEvent.change(screen.getByPlaceholderText(/24 words/), { target: { value: PHRASE } });
  fireEvent.change(screen.getByPlaceholderText('ada'), { target: { value: 'sean' } });
  fireEvent.submit(screen.getByPlaceholderText('ada').closest('form')!);
  const passwords = await screen.findAllByLabelText(/password/i);
  for (const field of passwords) fireEvent.change(field, { target: { value: 'paper lantern orbit' } });
  fireEvent.submit(passwords[0].closest('form')!);
}

beforeEach(async () => {
  shell.urls = [];
  shell.answer = null;
  legacyRecover.mockClear();
  localStorage.clear();
  const { clearStoredServerUrl } = await import('../lib/config/apiBaseUrl');
  clearStoredServerUrl();
});

describe('recovering on the desktop', () => {
  it('with no server chosen, says so and sends nothing', async () => {
    await renderRecover();
    expect(await screen.findByText('Choose your server first')).toBeTruthy();
    expect(screen.queryByText(/absolute URL/)).toBeNull();
    // Nothing went out: no request named no server.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(shell.urls).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Go to sign-in' }));
    expect(await screen.findByText('Sign-in screen')).toBeTruthy();
  });

  it('with a server that does not answer, says that instead of the transport error, and recovers nothing locally', async () => {
    const { setStoredServerUrl } = await import('../lib/config/apiBaseUrl');
    setStoredServerUrl('https://127.0.0.1:8443');
    await renderRecover();
    await submitPhraseAndPassword();
    expect(await screen.findByText(/couldn't reach the server/)).toBeTruthy();
    expect(screen.queryByText(/os error|Connection refused|absolute URL/)).toBeNull();
    expect(legacyRecover).not.toHaveBeenCalled();
    expect(shell.urls.every((url) => url.startsWith('https://127.0.0.1:8443/'))).toBe(true);
    expect(screen.queryByText('App shell')).toBeNull();
  });
});

describe('the desktop HTTP adapter', () => {
  it('refuses a request that names no server, in words for the person, without asking the shell', async () => {
    const { tauriAdapter, NO_SERVER_CHOSEN, NO_SERVER_CHOSEN_MESSAGE } = await import('../lib/tauriAxiosAdapter');
    const { AxiosHeaders } = await import('axios');
    const refusal = await tauriAdapter({ method: 'get', url: '/auth/options', baseURL: '/api/v1', headers: new AxiosHeaders() } as never)
      .catch((error: unknown) => error);
    expect((refusal as { code?: string }).code).toBe(NO_SERVER_CHOSEN);
    expect((refusal as Error).message).toBe(NO_SERVER_CHOSEN_MESSAGE);
    expect(shell.urls).toEqual([]);
  });

  it('turns a refusal into a sentence on the account screens', async () => {
    const { credentialErrorMessage } = await import('../lib/oneCredential');
    const { AxiosError } = await import('axios');
    const raw = new AxiosError('Native fetch requires an absolute URL', AxiosError.ERR_NETWORK);
    expect(credentialErrorMessage(raw, 'fallback')).toMatch(/couldn't reach the server/);
    const { NO_SERVER_CHOSEN, NO_SERVER_CHOSEN_MESSAGE } = await import('../lib/tauriAxiosAdapter');
    expect(credentialErrorMessage(new AxiosError('x', NO_SERVER_CHOSEN), 'fallback')).toBe(NO_SERVER_CHOSEN_MESSAGE);
  });
});
