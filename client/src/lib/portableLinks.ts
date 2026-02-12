const SEPARATOR = '|';
const PROTOCOL = 'paracord';
const INVITE_PREFIX = `${PROTOCOL}://invite/`;

function base64urlEncode(input: string): string {
  const encoded = btoa(
    Array.from(new TextEncoder().encode(input), (b) => String.fromCharCode(b)).join('')
  );
  return encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(input: string): string {
  let b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4 !== 0) b64 += '=';
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function encodePortableLink(serverUrl: string, inviteCode: string): string {
  const payload = `${serverUrl}${SEPARATOR}${inviteCode}`;
  return base64urlEncode(payload);
}

export function decodePortableLink(token: string): { serverUrl: string; inviteCode: string } {
  const cleaned = token.startsWith(INVITE_PREFIX) ? token.slice(INVITE_PREFIX.length) : token;
  const decoded = base64urlDecode(cleaned);
  const sepIndex = decoded.lastIndexOf(SEPARATOR);
  if (sepIndex === -1) {
    throw new Error('Invalid portable link: missing separator');
  }
  return {
    serverUrl: decoded.slice(0, sepIndex),
    inviteCode: decoded.slice(sepIndex + 1),
  };
}

export function isPortableLink(input: string): boolean {
  const trimmed = input.trim();
  if (trimmed.startsWith(INVITE_PREFIX)) return true;
  if (/^[A-Za-z0-9_-]{8,}$/.test(trimmed)) {
    try {
      const { serverUrl, inviteCode } = decodePortableLink(trimmed);
      return serverUrl.length > 0 && inviteCode.length > 0;
    } catch {
      return false;
    }
  }
  return false;
}

export function toPortableUri(serverUrl: string, inviteCode: string): string {
  return `${INVITE_PREFIX}${encodePortableLink(serverUrl, inviteCode)}`;
}
