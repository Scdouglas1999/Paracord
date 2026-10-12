/* global Buffer */
// The one-password credential (docs/setup-spec.md §3.2, §3.3) in node:crypto,
// for scripts that make accounts by API: live-drive, live-probe, the
// real-server e2e harnesses. Same definitions as client/src/lib/credential
// (checked against the shared vectors by `selfCheck()`), no browser needed.

import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_KDF = Object.freeze({ alg: 'scrypt', log_n: 17, r: 8, p: 1 });
const SALT_LABEL = 'paracord/credential/v2/salt';
const AUTH_INFO = 'paracord/credential/v2/auth';
const WRAP_INFO = 'paracord/credential/v2/wrap';
const AAD_PREFIX = 'paracord/identity/v2|';
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

const sha256 = (...parts) => {
  const hash = crypto.createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest();
};
export const b64url = (bytes) => Buffer.from(bytes).toString('base64url');

/** password + salt (32 bytes) + kdf → { authKey (b64url), wrapKey (Buffer) }. */
export function deriveKeys(password, salt, kdf = DEFAULT_KDF) {
  const pw = Buffer.from(password.normalize('NFKC'), 'utf8');
  const N = 2 ** kdf.log_n;
  const master = crypto.scryptSync(pw, sha256(Buffer.from(SALT_LABEL, 'utf8'), salt), 32, {
    N, r: kdf.r, p: kdf.p, maxmem: 128 * N * kdf.r * (kdf.p + 1) + 1024 * 1024,
  });
  const hkdf = (info) => Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), Buffer.from(info, 'utf8'), 32));
  return { authKey: b64url(hkdf(AUTH_INFO)), wrapKey: hkdf(WRAP_INFO) };
}

/** A new Ed25519 identity: { secretKey (32-byte Buffer), publicKey (hex), sign(message) → hex }. */
export function identity(secretKey = crypto.randomBytes(32)) {
  const key = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, secretKey]), format: 'der', type: 'pkcs8' });
  const spki = crypto.createPublicKey(key).export({ format: 'der', type: 'spki' });
  return {
    secretKey,
    publicKey: spki.subarray(spki.length - 32).toString('hex'),
    sign: (message) => crypto.sign(null, Buffer.from(message, 'utf8'), key).toString('hex'),
  };
}

export function wrapIdentity(wrapKey, id, iv = crypto.randomBytes(12)) {
  const cipher = crypto.createCipheriv('aes-256-gcm', wrapKey, iv);
  cipher.setAAD(Buffer.from(AAD_PREFIX + id.publicKey, 'utf8'));
  return b64url(Buffer.concat([iv, cipher.update(id.secretKey), cipher.final(), cipher.getAuthTag()]));
}

/** A credential for `password` with a fresh salt: `{ credential, wrapKey }`. */
export function newCredential(password, kdf = DEFAULT_KDF) {
  const salt = crypto.randomBytes(32);
  const { authKey, wrapKey } = deriveKeys(password, salt, kdf);
  return { credential: { salt: b64url(salt), kdf: { ...kdf }, auth_key: authKey }, wrapKey };
}

/** Sign a `/auth/challenge` answer for a credential purpose (`register` or `reset`). */
export function proof(id, purpose, challenge) {
  const message = `paracord/credential/v2/${purpose}:${challenge.nonce}:${challenge.timestamp}:${challenge.server_origin}`;
  return { nonce: challenge.nonce, timestamp: challenge.timestamp, signature: id.sign(message) };
}

/** The 24-word phrase for an identity (§3.6). */
export function phraseOf(id) {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../src/lib/bip39-wordlist.ts'), 'utf8');
  const words = [...source.matchAll(/^ {2}'([a-z]+)',$/gm)].map((match) => match[1]);
  let value = (BigInt('0x' + id.secretKey.toString('hex')) << 8n) | BigInt(sha256(id.secretKey)[0]);
  const out = [];
  for (let i = 0; i < 24; i += 1) {
    out.unshift(words[Number(value & 0x7ffn)]);
    value >>= 11n;
  }
  return out.join(' ');
}

async function postJson(base, path, body, headers = {}) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!response.ok) throw new Error(`POST ${path}: ${response.status} ${text}`);
  return parsed;
}

/**
 * Register a one-password account through `POST /auth/credential/register`
 * (the route the client uses). Returns `{ username, email, id, token, publicKey, phrase }`.
 */
export async function registerOnePassword(base, { username, email, password, displayName, inviteCode }) {
  const id = identity();
  const { credential, wrapKey } = newCredential(password);
  const challenge = await postJson(base, '/auth/challenge');
  const body = await postJson(base, '/auth/credential/register', {
    username,
    email,
    display_name: displayName ?? null,
    invite_code: inviteCode ?? null,
    credential,
    identity: { public_key: id.publicKey, wrapped_key: wrapIdentity(wrapKey, id), wrap_alg: 'aes256gcm-v2', proof: proof(id, 'register', challenge) },
  });
  return { username, email, id: body.user.id, token: body.token, refreshToken: body.refresh_token ?? null, publicKey: id.publicKey, phrase: phraseOf(id) };
}

/** Sign in by API: params → derive → `/auth/credential/login`. Returns the login response. */
export async function signInOnePassword(base, identifier, password) {
  const params = await postJson(base, '/auth/credential/params', { identifier });
  if (params.version !== 2) throw new Error(`${identifier}: the server answered version ${params.version}`);
  const { authKey } = deriveKeys(password, Buffer.from(params.salt, 'base64url'), params.kdf);
  return postJson(base, '/auth/credential/login', { identifier, auth_key: authKey });
}

/** Checks this port against the client's shared vectors; throws on any difference. */
export function selfCheck() {
  const vectors = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../src/lib/credential/vectors.json'), 'utf8'));
  for (const v of vectors.derivation) {
    const { authKey, wrapKey } = deriveKeys(v.password, Buffer.from(v.salt_hex, 'hex'), v.kdf);
    if (authKey !== v.auth_key || wrapKey.toString('hex') !== v.wrap_key_hex) throw new Error(`credential-node: vector ${v.name} differs`);
  }
  for (const v of vectors.phrase) {
    const id = identity(Buffer.from(v.private_key_hex, 'hex'));
    if (id.publicKey !== v.public_key || phraseOf(id) !== v.phrase) throw new Error(`credential-node: phrase vector ${v.name} differs`);
  }
}
