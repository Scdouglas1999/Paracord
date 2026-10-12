import { afterEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
let desktop = true;
vi.mock('../../lib/tauriEnv', () => ({ isTauri: () => desktop }));

import { checkInvite } from './inviteCheck';

const LINK = { serverUrl: 'https://kanto.home.arpa:8443', code: 'Rf8kQ2' };
const FP = 'a1f3c97e0b52d684e1a07bc39d55f2486e7013ab94c8d02f5e61b7a30c94d8e1';
const PREVIEW = {
  code: 'Rf8kQ2',
  guild: { id: '1', name: 'Kanto Friends', hue: 200, online_count: 9, member_count: 41, icon_hash: null },
  faces: [],
  instance: { name: 'Kanto', version: '3.5.0', credential_version: 2, registration_mode: 'open', require_email: false },
};

describe('checking an invite (§1.5)', () => {
  afterEach(() => {
    invoke.mockReset();
    desktop = true;
  });

  it('desktop: the preview and the certificate from one first contact, with four words', async () => {
    invoke.mockResolvedValue({ status: 200, body: PREVIEW, fingerprint: FP, ca_verified: false });
    const check = await checkInvite(LINK);
    expect(invoke).toHaveBeenCalledWith('preview_invite', { serverUrl: LINK.serverUrl, code: 'Rf8kQ2' });
    expect(check.state).toBe('card');
    expect(check.identity?.words).toHaveLength(4);
    expect(check.host).toBe('kanto.home.arpa');
  });

  it('a public certificate needs no words', async () => {
    invoke.mockResolvedValue({ status: 200, body: PREVIEW, fingerprint: FP, ca_verified: true });
    expect((await checkInvite(LINK)).identity?.words).toEqual([]);
  });

  it('404 is an invite that stopped working; no instance is an older server; a refusal is unreachable', async () => {
    invoke.mockResolvedValueOnce({ status: 404, body: null, fingerprint: FP, ca_verified: false });
    expect((await checkInvite(LINK)).state).toBe('invalid');
    const { instance: _i, ...old } = PREVIEW;
    invoke.mockResolvedValueOnce({ status: 200, body: old, fingerprint: FP, ca_verified: false });
    expect((await checkInvite(LINK)).state).toBe('old-server');
    invoke.mockRejectedValueOnce('Connection refused or unreachable');
    expect((await checkInvite(LINK)).state).toBe('unreachable');
    invoke.mockRejectedValueOnce('TLS certificate pin mismatch for kanto.home.arpa');
    expect((await checkInvite(LINK)).state).toBe('identity-changed');
  });

  it('web: the page fetches its own server, and shows no words', async () => {
    desktop = false;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(PREVIEW), { status: 200 }));
    const check = await checkInvite(LINK);
    expect(fetchMock).toHaveBeenCalled();
    expect(check.state).toBe('card');
    expect(check.identity).toEqual({ fingerprint: null, caVerified: false, words: [] });
    fetchMock.mockRestore();
  });
});
