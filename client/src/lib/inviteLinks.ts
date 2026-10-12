import { tryDecodePortableLink } from './portableLinks';

/**
 * The one parser for an invite someone pasted, tapped or was handed
 * (setup-spec §6.3). The connect page, the dock's Join tab, deep links and the
 * clipboard offer all go through here, so they agree on what a link is.
 *
 * Accepted:
 *   paracord://invite/<base64url(serverUrl|code)>
 *   https://host[:port]/invite/CODE
 *   host[:port]/invite/CODE            (https, or http for a loopback host)
 *
 * Plain `http` is accepted only for a loopback host. Anything else — another
 * scheme, a bare code, a link that is not an invite — returns null: the caller
 * says what it could not read, this function never guesses.
 */
export interface InviteLink {
  /** Scheme, host, port and any path prefix the server lives under; no trailing slash. */
  serverUrl: string;
  code: string;
}

const CODE = /^[A-Za-z0-9_-]{1,64}$/;
const INVITE_PATH = /^(.*)\/invite\/([A-Za-z0-9_-]{1,64})\/?$/;
const PORTABLE_PREFIX = 'paracord://invite/';

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '[::1]' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
}

/** `host[:port][/path]` or `scheme://…` to a checked base URL, or null. */
function serverBase(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  let url: URL;
  try {
    url = hasScheme ? new URL(text) : new URL(`http://${text}`);
  } catch {
    return null;
  }
  if (url.username || url.password || !url.hostname) return null;
  const loopback = isLoopbackHost(url.hostname);
  let protocol: string;
  if (hasScheme) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.protocol === 'http:' && !loopback) return null;
    protocol = url.protocol;
  } else {
    protocol = loopback ? 'http:' : 'https:';
  }
  const path = url.pathname.replace(/\/+$/, '');
  return `${protocol}//${url.host}${path}`;
}

export function parseInviteLink(input: string): InviteLink | null {
  const text = input.trim();
  if (!text || /\s/.test(text)) return null;

  if (text.toLowerCase().startsWith(PORTABLE_PREFIX)) {
    const decoded = tryDecodePortableLink(text.slice(PORTABLE_PREFIX.length));
    if (!decoded || !CODE.test(decoded.inviteCode)) return null;
    const serverUrl = serverBase(decoded.serverUrl);
    return serverUrl ? { serverUrl, code: decoded.inviteCode } : null;
  }

  // Drop a query or fragment (a share sheet may append tracking); the path is the invite.
  const withoutTail = text.replace(/[?#].*$/, '');
  const match = INVITE_PATH.exec(withoutTail);
  if (!match) return null;
  const serverUrl = serverBase(match[1]);
  return serverUrl ? { serverUrl, code: match[2] } : null;
}
