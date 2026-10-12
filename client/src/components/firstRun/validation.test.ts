import { describe, expect, it } from 'vitest';

import { usernameProblem } from './AccountStep';
import { serverFromInput } from './SignInStep';
import { preflightRefusal } from './NameStep';
import { usernameFrom, progressOf } from '../../stores/firstRunStore';

describe('the first run reads what people type', () => {
  it('fills a username from the name and checks it like the server (§1.6)', () => {
    expect(usernameFrom('Sam Rivera!')).toBe('samrivera');
    expect(usernameFrom('A'.repeat(30))).toHaveLength(20);
    expect(usernameProblem('sam')).toBeNull();
    expect(usernameProblem('s')).toMatch(/2 characters/);
    expect(usernameProblem('sam rivera')).toMatch(/letters/);
    expect(usernameProblem('.sam')).toMatch(/start or end/);
    expect(usernameProblem('sa..m')).toMatch(/two in a row/);
    expect(usernameProblem('sämi')).toMatch(/letters/);
  });

  it('takes an address or an invite in the Server field (§1.12)', () => {
    expect(serverFromInput('chat.example.com')).toEqual({ url: 'https://chat.example.com', inviteCode: null });
    expect(serverFromInput('https://kanto.home.arpa:8443/invite/Rf8kQ2')).toEqual({ url: 'https://kanto.home.arpa:8443', inviteCode: 'Rf8kQ2' });
    expect(serverFromInput('')).toBeNull();
  });

  it('says why this computer cannot host, in the spec words (§2.3)', () => {
    expect(preflightRefusal({ ok: false, reason: 'no_port' })).toBe('Every port Paracord could use (8443 to 8463) is taken.');
    expect(preflightRefusal({ ok: true, port: 8443 })).toBeNull();
  });

  it('counts progress from the welcome (§1.1)', () => {
    expect(progressOf('host', 'name')).toEqual({ segments: 5, filled: 1 });
    expect(progressOf('join', 'phrase')).toEqual({ segments: 4, filled: 4 });
  });
});
