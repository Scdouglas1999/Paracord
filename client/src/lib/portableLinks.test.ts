import { describe, it, expect } from 'vitest';
import {
  encodePortableLink,
  decodePortableLink,
  tryDecodePortableLink,
  isPortableLink,
  toPortableUri,
} from './portableLinks';

describe('portableLinks', () => {
  const serverUrl = 'https://chat.example.com';
  const inviteCode = 'abc123XYZ';

  it('round-trips a portable link through encode/decode', () => {
    const token = encodePortableLink(serverUrl, inviteCode);
    expect(decodePortableLink(token)).toEqual({ serverUrl, inviteCode });
  });

  it('round-trips a paracord://invite/<token> URI', () => {
    const uri = toPortableUri(serverUrl, inviteCode);
    expect(uri.startsWith('paracord://invite/')).toBe(true);
    expect(decodePortableLink(uri)).toEqual({ serverUrl, inviteCode });
  });

  it('recognises valid portable links', () => {
    expect(isPortableLink(encodePortableLink(serverUrl, inviteCode))).toBe(true);
    expect(isPortableLink(toPortableUri(serverUrl, inviteCode))).toBe(true);
  });

  it('rejects malformed input without throwing', () => {
    expect(isPortableLink('')).toBe(false);
    expect(isPortableLink('not a link')).toBe(false);
    expect(isPortableLink('https://chat.example.com/invite/CODE')).toBe(false);
    // Prefixed but with an undecodable / componentless payload.
    expect(isPortableLink('paracord://invite/!!!not-base64!!!')).toBe(false);
    expect(isPortableLink('paracord://invite/')).toBe(false);
  });

  it('tryDecodePortableLink returns null instead of throwing on bad input', () => {
    expect(tryDecodePortableLink('')).toBeNull();
    expect(tryDecodePortableLink('paracord://invite/')).toBeNull();
    // Valid base64url that decodes to "helloworld" — no "|" separator present.
    expect(tryDecodePortableLink('aGVsbG93b3JsZA')).toBeNull();
  });

  it('decodePortableLink throws on an empty component', () => {
    // Encodes "https://x|" — a present separator but an empty invite code.
    const token = encodePortableLink('https://x', '');
    expect(() => decodePortableLink(token)).toThrow();
    expect(tryDecodePortableLink(token)).toBeNull();
  });
});
