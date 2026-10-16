import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A computer that hosts a server, with no home server saved (the owner's
 * profile after the update: an empty store, the hosted server running on
 * :8443). Boot adopts the hosted server, so recovery, sign-in and every other
 * account screen talk to it instead of answering "Paracord doesn't know which
 * server to use yet".
 */

const HOSTED = 'https://127.0.0.1:8443';

const shell = vi.hoisted(() => ({
  hosted: 'https://127.0.0.1:8443' as string | null,
  hostFails: false,
  urls: [] as string[],
  commands: [] as string[],
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args?: { req?: { url: string } }) => {
    shell.commands.push(command);
    if (command === 'host_home_server') {
      if (shell.hostFails) throw new Error('host.json is unreadable');
      return shell.hosted;
    }
    if (command === 'native_fetch') {
      const url = args!.req!.url;
      shell.urls.push(url);
      try {
        new URL(url);
      } catch {
        throw 'Native fetch requires an absolute URL';
      }
      if (url.endsWith('/auth/options')) {
        return { status: 200, body: { allow_username_login: true, require_email: false, credential_version: 2 }, headers: {} };
      }
      throw 'error sending request: Connection refused';
    }
    return null;
  }),
}));
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};

const { adoptHostedHomeServer } = await import('./adoptHostedServer');
const { clearStoredServerUrl, getStoredServerUrl, setStoredServerUrl } = await import('../config/apiBaseUrl');

beforeEach(() => {
  localStorage.clear();
  clearStoredServerUrl();
  shell.hosted = HOSTED;
  shell.hostFails = false;
  shell.urls = [];
  shell.commands = [];
});

describe('boot on a computer that hosts a server', () => {
  it('adopts the hosted server when no home server is saved', async () => {
    expect(await adoptHostedHomeServer()).toBe(HOSTED);
    expect(getStoredServerUrl()).toBe(HOSTED);
  });

  it('never replaces a saved server', async () => {
    setStoredServerUrl('https://chat.example.com');
    expect(await adoptHostedHomeServer()).toBeNull();
    expect(getStoredServerUrl()).toBe('https://chat.example.com');
    expect(shell.commands).not.toContain('host_home_server');
  });

  it('leaves a computer that hosts nothing, or cannot say, without a server', async () => {
    shell.hosted = null;
    expect(await adoptHostedHomeServer()).toBeNull();
    shell.hostFails = true;
    expect(await adoptHostedHomeServer()).toBeNull();
    expect(getStoredServerUrl()).toBeNull();
  });

  it('then reaches recovery with the hosted server, not the choose-your-server screen', async () => {
    await adoptHostedHomeServer();
    const { AccountRecoverPage } = await import('../../pages/AccountRecoverPage');
    render(
      <MemoryRouter initialEntries={['/recover']}>
        <Routes>
          <Route path="/recover" element={<AccountRecoverPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('Enter your recovery phrase')).toBeTruthy();
    expect(screen.queryByTestId('choose-server-first')).toBeNull();
    await vi.waitFor(() => expect(shell.urls).toContain(`${HOSTED}/api/v1/auth/options`));
    expect(shell.urls.every((url) => url.startsWith(`${HOSTED}/`))).toBe(true);
    // The phrase step's copy is the one-password server's.
    fireEvent.change(screen.getByPlaceholderText(/24 words/), { target: { value: 'x' } });
    expect(screen.queryByText(/doesn't know which server/)).toBeNull();
  });
});
