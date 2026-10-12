import { beforeEach, describe, expect, it, vi } from 'vitest';

import { toPortableUri } from '../../../lib/portableLinks';
import { getServerAccountScope } from '../../../lib/serverIdentity';
import { useServerListStore } from '../../../stores/serverListStore';
import { accountForInvite, defaultServerName, inviteTargetOf } from './useAddServer';

vi.mock('../../../lib/serverIdentity', () => ({ getServerAccountScope: vi.fn() }));

describe('inviteTargetOf', () => {
  it('reads a link with its server, or a bare code with none', () => {
    expect(inviteTargetOf('https://chat.example.com/invite/hTKzmak')).toEqual({
      code: 'hTKzmak',
      serverUrl: 'https://chat.example.com',
    });
    expect(inviteTargetOf('  hTKzmak  ')).toEqual({ code: 'hTKzmak', serverUrl: null });
    expect(inviteTargetOf('chat.example.com:8443/invite/abc123')).toEqual({
      code: 'abc123',
      serverUrl: 'https://chat.example.com:8443',
    });
    expect(inviteTargetOf(toPortableUri('https://chat.example.com', 'abc123'))).toEqual({
      code: 'abc123',
      serverUrl: 'https://chat.example.com',
    });
  });

  it('refuses what is neither, instead of guessing a code from the last path segment', () => {
    expect(inviteTargetOf('')).toBeNull();
    expect(inviteTargetOf('https://chat.example.com/hTKzmak')).toBeNull();
    expect(inviteTargetOf('http://chat.example.com/invite/hTKzmak')).toBeNull();
    expect(inviteTargetOf('two words')).toBeNull();
  });
});

describe('accountForInvite', () => {
  const inView = { serverId: 's_home', userId: '10' };

  beforeEach(() => {
    useServerListStore.setState({
      servers: [
        { id: 's_home', name: 'Home', url: 'https://home.example.com', connected: true, apiReachable: true },
        { id: 's_other', name: 'Other', url: 'https://other.example.com', connected: true, apiReachable: true },
      ] as never,
      activeServerId: 's_home',
    });
    vi.mocked(getServerAccountScope).mockReset();
  });

  it('keeps the account in view for a bare code and for a link to the same server', () => {
    expect(accountForInvite({ code: 'abc', serverUrl: null }, inView)).toBe(inView);
    expect(accountForInvite({ code: 'abc', serverUrl: 'https://home.example.com' }, inView)).toBe(inView);
  });

  it('uses the other server\'s account for a link to it', () => {
    vi.mocked(getServerAccountScope).mockReturnValue({ serverId: 's_other', userId: '77' });
    expect(accountForInvite({ code: 'abc', serverUrl: 'https://other.example.com' }, inView)).toEqual({
      serverId: 's_other',
      userId: '77',
    });
  });

  it('says why when the server is unknown or not signed in', () => {
    expect(() => accountForInvite({ code: 'abc', serverUrl: 'https://new.example.com' }, inView)).toThrow(
      /new\.example\.com, which you have not added yet/,
    );
    vi.mocked(getServerAccountScope).mockReturnValue(null);
    expect(() => accountForInvite({ code: 'abc', serverUrl: 'https://other.example.com' }, inView)).toThrow(
      /Other, which you are not signed in to/,
    );
  });
});

describe('defaultServerName', () => {
  it('suggests the person\'s server, or "My" before their name is known', () => {
    expect(defaultServerName('ada')).toBe("ada's server");
    expect(defaultServerName(null)).toBe("My's server");
    expect(defaultServerName('')).toBe("My's server");
  });
});
