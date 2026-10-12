import { describe, expect, it } from 'vitest';

import { parseInviteLink } from './inviteLinks';
import { toPortableUri } from './portableLinks';

describe('parseInviteLink', () => {
  const accepted: [string, string, string][] = [
    ['https://chat.example.com/invite/abcd1234', 'https://chat.example.com', 'abcd1234'],
    ['  https://chat.example.com/invite/abcd1234/  ', 'https://chat.example.com', 'abcd1234'],
    ['https://chat.example.com:8443/invite/abcd1234', 'https://chat.example.com:8443', 'abcd1234'],
    ['HTTPS://Chat.Example.com/invite/Ab_d-234', 'https://chat.example.com', 'Ab_d-234'],
    ['https://chat.example.com/invite/abcd1234?utm=x#top', 'https://chat.example.com', 'abcd1234'],
    ['https://example.com/paracord/invite/abcd1234', 'https://example.com/paracord', 'abcd1234'],
    ['chat.example.com/invite/abcd1234', 'https://chat.example.com', 'abcd1234'],
    ['chat.example.com:8443/invite/abcd1234', 'https://chat.example.com:8443', 'abcd1234'],
    ['203.0.113.7:8090/invite/abcd1234', 'https://203.0.113.7:8090', 'abcd1234'],
    ['http://localhost:8090/invite/abcd1234', 'http://localhost:8090', 'abcd1234'],
    ['http://127.0.0.1:8090/invite/abcd1234', 'http://127.0.0.1:8090', 'abcd1234'],
    ['http://[::1]:8090/invite/abcd1234', 'http://[::1]:8090', 'abcd1234'],
    ['localhost:8090/invite/abcd1234', 'http://localhost:8090', 'abcd1234'],
    ['[::1]:8090/invite/abcd1234', 'http://[::1]:8090', 'abcd1234'],
    ['https://localhost:8443/invite/abcd1234', 'https://localhost:8443', 'abcd1234'],
  ];
  it.each(accepted)('reads %s', (input, serverUrl, code) => {
    expect(parseInviteLink(input)).toEqual({ serverUrl, code });
  });

  it('reads a paracord:// link, with or without a scheme in the server part', () => {
    expect(parseInviteLink(toPortableUri('https://chat.example.com', 'abcd1234'))).toEqual({
      serverUrl: 'https://chat.example.com',
      code: 'abcd1234',
    });
    expect(parseInviteLink(toPortableUri('chat.example.com:8443', 'abcd1234'))).toEqual({
      serverUrl: 'https://chat.example.com:8443',
      code: 'abcd1234',
    });
    expect(parseInviteLink(toPortableUri('http://127.0.0.1:8090', 'abcd1234'))).toEqual({
      serverUrl: 'http://127.0.0.1:8090',
      code: 'abcd1234',
    });
    expect(parseInviteLink(toPortableUri('localhost:8090/', 'abcd1234'))).toEqual({
      serverUrl: 'http://localhost:8090',
      code: 'abcd1234',
    });
  });

  const refused = [
    '',
    '   ',
    'abcd1234',
    'chat.example.com',
    'https://chat.example.com',
    'https://chat.example.com/invite/',
    'https://chat.example.com/invite/bad code',
    'https://chat.example.com/invite/ab$cd',
    'https://chat.example.com/invites/abcd1234',
    'http://chat.example.com/invite/abcd1234',
    'http://203.0.113.7:8090/invite/abcd1234',
    'ftp://chat.example.com/invite/abcd1234',
    'javascript://chat.example.com/invite/abcd1234',
    'https://user:pw@chat.example.com/invite/abcd1234',
    '/invite/abcd1234',
    'paracord://invite/',
    'paracord://invite/not-a-valid-token!',
    `paracord://invite/${btoa('no separator').replace(/=+$/, '')}`,
    toPortableUri('http://chat.example.com', 'abcd1234'),
    toPortableUri('ftp://chat.example.com', 'abcd1234'),
    toPortableUri('https://chat.example.com', 'bad code'),
  ];
  it.each(refused)('refuses %j', (input) => {
    expect(parseInviteLink(input)).toBeNull();
  });
});
