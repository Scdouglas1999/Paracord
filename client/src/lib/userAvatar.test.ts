import { describe, expect, it, vi } from 'vitest';

vi.mock('./config/apiBaseUrl', () => ({
  resolveResourceUrl: (url: string) => url,
}));
vi.mock('./downloadTicket', () => ({
  getDownloadTicket: () => null,
}));

import { resolveUserAvatarUrl } from './userAvatar';

/**
 * An avatar renders automatically for every viewer of a message or member list.
 * Honouring a remote URL another user chose would beacon each viewer's IP, user
 * agent and viewing time to a host that user controls, with no interaction and
 * no way for the viewer to notice.
 */
describe('resolveUserAvatarUrl', () => {
  it('refuses a remote URL another user could have stored', () => {
    for (const hostile of [
      'https://attacker.example/beacon.png',
      'http://attacker.example/beacon.png',
      '//attacker.example/beacon.png',
      '  https://attacker.example/beacon.png  ',
      'HTTPS://attacker.example/beacon.png',
    ]) {
      expect(resolveUserAvatarUrl(hostile)).toBeNull();
    }
  });

  it('still resolves the forms an avatar actually takes', () => {
    // The path this server serves.
    expect(resolveUserAvatarUrl('/api/v1/users/123/avatar')).toBe('/api/v1/users/123/avatar');
    // An inline image.
    expect(resolveUserAvatarUrl('data:image/png;base64,iVBORw0KGgo=')).toContain('data:image/png');
    // A local object URL created by the client itself.
    expect(resolveUserAvatarUrl('blob:http://localhost/abc')).toBe('blob:http://localhost/abc');
  });

  it('treats absent values as no avatar', () => {
    expect(resolveUserAvatarUrl(null)).toBeNull();
    expect(resolveUserAvatarUrl(undefined)).toBeNull();
    expect(resolveUserAvatarUrl('')).toBeNull();
  });
});
