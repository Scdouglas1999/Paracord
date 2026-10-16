import { describe, expect, it } from 'vitest';

import { hostInviteShare, shareNoteText } from './shareAddress';

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

describe('hostInviteShare (first-run Invite screen)', () => {
  it('uses the public address with the note', () => {
    expect(hostInviteShare({ url: OUTSIDE, reach: 'internet_unconfirmed', note: 'port_not_forwarded', port: 8443, source: 'stun' })).toEqual({
      base: OUTSIDE,
      noPublicAddress: false,
      onlyHere: false,
      addressChanged: false,
      note: 'People outside your network may not reach this until port 8443 is forwarded on your router.',
    });
  });

  it('has no link, with the reason, when no public address is known', () => {
    const view = hostInviteShare({ url: null, reach: 'unknown', note: 'carrier_nat', port: 8443 });
    expect(view).toMatchObject({ base: null, noPublicAddress: true, onlyHere: false });
    expect(view.note).toMatch(/^Your internet provider shares its public address/);
  });

  it('confirmed links carry no note; a loopback server has no link', () => {
    expect(hostInviteShare({ url: OUTSIDE, reach: 'internet', previous_url: 'https://198.51.100.3:8443' })).toMatchObject({
      note: null,
      addressChanged: true,
    });
    expect(hostInviteShare({ url: null, reach: 'this_computer' })).toMatchObject({ base: null, onlyHere: true, noPublicAddress: false });
  });
});
