import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

/**
 * The owner went through host setup again on a computer whose server already
 * has its owner (the profile had lost its account). Setup made no account at
 * the Account row, and the recovery-phrase step then failed with "Paracord
 * doesn't know which server to use yet". Host on such a computer is sign-in to
 * that server, with its address filled in.
 */

const HOSTED = 'https://127.0.0.1:8443';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string) => {
    if (command === 'host_info') {
      return {
        enabled: true, port: 8443, autostart: true, installed_version: '3.3.0',
        completed_steps: ['install', 'init', 'service', 'start', 'storage', 'claim', 'escrow', 'reach', 'backup'],
        service: { state: 'running', enabled: true, exit_code: null }, service_error: null,
        home_url: HOSTED, storage_key_problem: null, update_failure: null, held_version: null,
      };
    }
    if (command === 'probe_server_identity') return new Promise(() => undefined);
    return null;
  }),
}));
vi.mock('../../lib/trustedHosts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/trustedHosts')>()),
  probeServerIdentity: vi.fn(() => new Promise(() => undefined)),
}));
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
window.matchMedia ??= ((query: string) => ({
  matches: query.includes('reduce'), media: query, onchange: null,
  addListener: () => undefined, removeListener: () => undefined,
  addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

describe('Host on a computer whose server already has its owner', () => {
  it('goes to sign-in on that server instead of making an account', async () => {
    const { FirstRunPage, OWN_SERVER_SIGN_IN_SUB } = await import('./FirstRunPage');
    render(
      <MemoryRouter initialEntries={['/welcome']}>
        <Routes>
          <Route path="/welcome" element={<FirstRunPage mode="desktop" />} />
          <Route path="/welcome/sign-in" element={<FirstRunPage mode="desktop" />} />
          <Route path="/welcome/:path/:step" element={<FirstRunPage mode="desktop" />} />
        </Routes>
      </MemoryRouter>,
    );
    const host = await screen.findByTestId('fr-choose-host');
    fireEvent.click(host);
    const server = (await screen.findByTestId('fr-sign-in-server')) as HTMLInputElement;
    await vi.waitFor(() => expect(server.value).toBe(HOSTED));
    expect(screen.getByText(OWN_SERVER_SIGN_IN_SUB)).toBeTruthy();
    expect(screen.queryByText(/Name your server/i)).toBeNull();
  });
});
