import { describe, expect, it, vi } from 'vitest';

/**
 * The browser and the desktop shell need opposite things from the same
 * function, and getting that backwards is how a face stays blank.
 *
 * In a browser a ticket-less cross-origin avatar URL is answered 401, so
 * `resolveUserAvatarUrl` reports "no avatar" and the component draws its
 * initials chip (pinned in `downloadTicket.activeServer.test.ts`).
 *
 * The desktop shell never loads that URL itself — `useAuthenticatedImage`
 * fetches it over the native bridge with the access token and the server's
 * pinned certificate — so gating it on a ticket would hold every face back for
 * no reason, and hold them back forever if the mint never succeeded.
 */
vi.mock('./tauriEnv', () => ({ isTauri: () => true }));
vi.mock('./config/apiBaseUrl', () => ({
  resolveResourceUrl: (url: string) => `https://server.example${url}`,
  resourceNeedsDownloadTicket: () => true,
}));
vi.mock('./downloadTicket', () => ({ getDownloadTicket: () => null }));

import { resolveUserAvatarUrl } from './userAvatar';

describe('resolveUserAvatarUrl on the desktop shell', () => {
  it('resolves an avatar with no download ticket, because it does not need one', () => {
    expect(resolveUserAvatarUrl('/api/v1/users/123/avatar')).toBe(
      'https://server.example/api/v1/users/123/avatar',
    );
  });

  it('still refuses a remote URL another user could have stored', () => {
    expect(resolveUserAvatarUrl('https://attacker.example/beacon.png')).toBeNull();
  });
});
