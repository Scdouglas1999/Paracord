import { CredentialError } from './errors';

/**
 * Wire encodings of the credential contracts (S0, `paracord-contracts`
 * `credential.rs`): b64url is RFC 4648 §5 **without padding**; hex is
 * lowercase. Decoders are strict and canonical: padding, foreign characters,
 * non-zero trailing bits or a wrong length are refused, never repaired.
 */

const B64URL = /^[A-Za-z0-9_-]*$/;
const HEX = /^(?:[0-9a-f]{2})*$/;

export function toB64url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(value: string, expectedLength?: number, what = 'value'): Uint8Array {
  if (typeof value !== 'string' || !B64URL.test(value) || value.length % 4 === 1) {
    throw new CredentialError('invalid', `The ${what} is not valid base64url.`);
  }
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  if (toB64url(bytes) !== value) throw new CredentialError('invalid', `The ${what} is not canonical base64url.`);
  if (expectedLength !== undefined && bytes.length !== expectedLength) {
    throw new CredentialError('invalid', `The ${what} must be ${expectedLength} bytes.`);
  }
  return bytes;
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

export function fromHex(value: string, expectedLength?: number, what = 'value'): Uint8Array {
  if (typeof value !== 'string' || !HEX.test(value)) {
    throw new CredentialError('invalid', `The ${what} is not lowercase hex.`);
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  if (expectedLength !== undefined && bytes.length !== expectedLength) {
    throw new CredentialError('invalid', `The ${what} must be ${expectedLength} bytes.`);
  }
  return bytes;
}

export const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** A standalone ArrayBuffer holding exactly `bytes` (Web Crypto and transfer lists need one). */
export function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer
    ? bytes.buffer
    : (bytes.slice().buffer as ArrayBuffer);
}
