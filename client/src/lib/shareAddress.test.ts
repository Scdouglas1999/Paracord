import { describe, expect, it } from 'vitest';

import { hostInviteShare, onThisNetworkUrl, shareNoteText } from './shareAddress';

const LAN = 'https://192.168.1.20:8443';
const OUTSIDE = 'https://198.51.100.4:8443';

describe('shareNoteText', () => {
  it('names the real port for an unforwarded port', () => {
    expect(shareNoteText({ url: 'https://198.51.100.4:9443', reach: 'internet_unconfirmed', note: 'port_not_forwarded', port: 9443 })).toBe(
      'People outside your network may not reach this until port 9443 is forwarded on your router.',
    );
    // An older answer without `port` takes it from the link.
    expect(shareNoteText({ url: 'https://198.51.100.4:8450', reach: 'internet_unconfirmed', note: 'port_not_forwarded' })).toMatch(
      /port 8450 is forwarded/,
    );
  });

  it('says plainly when the provider or another router is in the way', () => {
    expect(shareNoteText({ url: OUTSIDE, reach: 'internet_unconfirmed', note: 'carrier_nat', port: 8443 })).toMatch(
      /^Your internet provider shares this public address with other customers/,
    );
    expect(shareNoteText({ url: OUTSIDE, reach: 'internet_unconfirmed', note: 'outer_router', port: 8443 })).toBe(
      "Another router sits in front of yours, so people outside can't reach this until port 8443 is forwarded on both routers.",
    );
    expect(shareNoteText({ url: OUTSIDE, reach: 'internet_unconfirmed', note: 'firewall_blocked', port: 8443 })).toMatch(/Windows Firewall allows port 8443/);
  });

  it('has nothing to say when nothing is in the way', () => {
    expect(shareNoteText({ url: OUTSIDE, reach: 'internet' })).toBeNull();
  });
});

describe('onThisNetworkUrl', () => {
  it('is the local address only when it differs from the link', () => {
    expect(onThisNetworkUrl({ url: OUTSIDE, local_url: `${LAN}/` })).toBe(LAN);
    expect(onThisNetworkUrl({ url: LAN, local_url: LAN })).toBeNull();
    expect(onThisNetworkUrl({ url: OUTSIDE })).toBeNull();
  });
});

describe('hostInviteShare (first-run Invite screen)', () => {
  it('uses the outside address with the note and the home link', () => {
    expect(
      hostInviteShare({ url: OUTSIDE, reach: 'internet_unconfirmed', local_url: LAN, note: 'port_not_forwarded', port: 8443, source: 'stun' }),
    ).toEqual({
      base: OUTSIDE,
      localBase: LAN,
      lan: false,
      onlyHere: false,
      addressChanged: false,
      note: 'People outside your network may not reach this until port 8443 is forwarded on your router.',
    });
  });

  it('is home-only, with the reason, when no public address is known', () => {
    const view = hostInviteShare({ url: LAN, reach: 'local_network', note: 'carrier_nat', port: 8443 });
    expect(view).toMatchObject({ base: LAN, localBase: null, lan: true, onlyHere: false });
    expect(view.note).toMatch(/^Your internet provider shares its public address/);
  });

  it('confirmed links carry no note; a loopback server has no link', () => {
    expect(hostInviteShare({ url: OUTSIDE, reach: 'internet', local_url: LAN, previous_url: 'https://198.51.100.3:8443' })).toMatchObject({
      note: null,
      addressChanged: true,
      localBase: LAN,
    });
    expect(hostInviteShare({ url: null, reach: 'this_computer' })).toMatchObject({ base: null, onlyHere: true });
  });
});
