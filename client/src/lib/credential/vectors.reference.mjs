#!/usr/bin/env node
// Independent reference for the one-password credential (spec §3.2, §3.3,
// §3.6, §3.14, §7.1). It uses only node:crypto (scrypt, HKDF, AES-256-GCM,
// Ed25519) and none of the client code, so the vectors it writes check the
// Web Crypto / worker implementation instead of restating it.
//
//   node client/src/lib/credential/vectors.reference.mjs          # write both copies
//   node client/src/lib/credential/vectors.reference.mjs --check  # fail if either differs
//
// Writes client/src/lib/credential/vectors.json and the server copy
// crates/paracord-api/tests/fixtures/credential_vectors.json (identical bytes).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const clientCopy = path.join(here, 'vectors.json');
const serverCopy = path.join(repo, 'crates/paracord-api/tests/fixtures/credential_vectors.json');

// The canonical BIP39 English list (bitcoin/bips bip-0039/english.txt) has this
// SHA-256 over its words joined by "\n" plus a final "\n". The client's copy
// must match it word for word: phrases and trust words are a wire format.
const BIP39_ENGLISH_SHA256 = '2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda';

const sha256 = (...parts) => {
  const h = crypto.createHash('sha256');
  for (const part of parts) h.update(part);
  return h.digest();
};
const hex = (buf) => Buffer.from(buf).toString('hex');
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const range = (start, length) => Buffer.from(Array.from({ length }, (_, i) => (start + i) & 0xff));

function loadWordlist() {
  const source = fs.readFileSync(path.join(repo, 'client/src/lib/bip39-wordlist.ts'), 'utf8');
  const words = [...source.matchAll(/^  '([a-z]+)',$/gm)].map((m) => m[1]);
  const digest = hex(sha256(words.join('\n') + '\n'));
  if (words.length !== 2048 || digest !== BIP39_ENGLISH_SHA256) {
    throw new Error(`client/src/lib/bip39-wordlist.ts is not the canonical BIP39 English list (sha256 ${digest})`);
  }
  return words;
}

// ── §3.2 derivation ────────────────────────────────────────────────────────
const SALT_LABEL = 'paracord/credential/v2/salt';
const AUTH_INFO = 'paracord/credential/v2/auth';
const WRAP_INFO = 'paracord/credential/v2/wrap';

function derive(password, salt, kdf) {
  const pw = Buffer.from(password.normalize('NFKC'), 'utf8');
  const scryptSalt = sha256(Buffer.from(SALT_LABEL, 'utf8'), salt);
  const N = 2 ** kdf.log_n;
  const master = crypto.scryptSync(pw, scryptSalt, 32, {
    N, r: kdf.r, p: kdf.p, maxmem: 128 * N * kdf.r * (kdf.p + 1) + 1024 * 1024,
  });
  const hkdf = (info) => Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), Buffer.from(info, 'utf8'), 32));
  return { pw, scryptSalt, master, authKey: hkdf(AUTH_INFO), wrapKey: hkdf(WRAP_INFO) };
}

// ── §3.3 wrap ──────────────────────────────────────────────────────────────
const AAD_PREFIX = 'paracord/identity/v2|';
function wrap(wrapKey, iv, secretKey, publicKeyHex) {
  const aad = Buffer.from(AAD_PREFIX + publicKeyHex, 'utf8');
  const cipher = crypto.createCipheriv('aes-256-gcm', wrapKey, iv);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(secretKey), cipher.final(), cipher.getAuthTag()]);
  return { aad: aad.toString('utf8'), wrapped: Buffer.concat([iv, body]) };
}

// ── Ed25519 identity ───────────────────────────────────────────────────────
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
function ed25519(seed) {
  const key = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const spki = crypto.createPublicKey(key).export({ format: 'der', type: 'spki' });
  return { key, publicKey: spki.subarray(spki.length - 32) };
}

// ── §3.6 phrase: 256-bit key + first 8 bits of SHA-256(key), 24 × 11 bits ──
function phrase(words, secretKey) {
  let value = (BigInt('0x' + hex(secretKey)) << 8n) | BigInt(sha256(secretKey)[0]);
  const out = [];
  for (let i = 0; i < 24; i += 1) {
    out.unshift(words[Number(value & 0x7ffn)]);
    value >>= 11n;
  }
  return out.join(' ');
}

// ── §7.1 trust words ───────────────────────────────────────────────────────
function trustWords(words, fingerprint) {
  const h = sha256(Buffer.from('paracord/trust-words/v1', 'utf8'), fingerprint);
  const top44 = BigInt('0x' + hex(h.subarray(0, 6))) >> 4n;
  return [33n, 22n, 11n, 0n].map((shift) => words[Number((top44 >> shift) & 0x7ffn)]);
}

function build() {
  const words = loadWordlist();
  const kdf = { alg: 'scrypt', log_n: 17, r: 8, p: 1 };

  const cases = [
    { name: 'ascii', password: 'correct horse battery staple', salt: range(0x00, 32) },
    // Fullwidth letters, the "fi" ligature, a circled digit and a precomposed é:
    // NFKC folds all of them, so the server-visible result never depends on
    // how a keyboard or IME spelled the same password.
    { name: 'unicode-nfkc', password: 'Ｐａｒａｃｏｒｄ ﬁre ① café', salt: range(0xa0, 32) },
    // The same password typed with a combining acute accent instead.
    { name: 'unicode-nfkc-decomposed', password: 'Ｐａｒａｃｏｒｄ ﬁre ① café', salt: range(0xa0, 32), same_as: 'unicode-nfkc' },
  ];
  const derivation = cases.map(({ name, password, salt, same_as }) => {
    const d = derive(password, salt, kdf);
    return {
      name,
      ...(same_as ? { same_as } : {}),
      password,
      password_nfkc: password.normalize('NFKC'),
      password_utf8_hex: hex(d.pw),
      salt: b64url(salt),
      salt_hex: hex(salt),
      kdf,
      kdf_text: `${kdf.alg}:${kdf.log_n}:${kdf.r}:${kdf.p}`,
      scrypt_salt_hex: hex(d.scryptSalt),
      master_hex: hex(d.master),
      auth_key: b64url(d.authKey),
      auth_key_hex: hex(d.authKey),
      wrap_key_hex: hex(d.wrapKey),
    };
  });
  for (const v of derivation) {
    if (v.same_as) {
      const twin = derivation.find((other) => other.name === v.same_as);
      if (twin.master_hex !== v.master_hex) throw new Error(`${v.name} should derive the same master as ${v.same_as}`);
    }
  }

  const seed = sha256(Buffer.from('paracord/vectors/identity', 'utf8'));
  const identity = ed25519(seed);
  const publicKeyHex = hex(identity.publicKey);
  const iv = range(0xc0, 12);
  const wrapKey = Buffer.from(derivation[0].wrap_key_hex, 'hex');
  const sealed = wrap(wrapKey, iv, seed, publicKeyHex);

  const origin = 'https://paracord.example:8443';
  const nonce = hex(sha256(Buffer.from('paracord/vectors/nonce', 'utf8')));
  const timestamp = 1792000000;
  const proofs = ['paracord/credential/v2/register', 'paracord/credential/v2/reset'].map((purpose) => {
    const message = `${purpose}:${nonce}:${timestamp}:${origin}`;
    return {
      purpose, nonce, timestamp, origin, message,
      public_key: publicKeyHex,
      signature: hex(crypto.sign(null, Buffer.from(message, 'utf8'), identity.key)),
    };
  });

  const phraseKeys = [
    { name: 'identity', secret: seed },
    { name: 'zeros', secret: Buffer.alloc(32, 0) },
    { name: 'ones', secret: Buffer.alloc(32, 0xff) },
    // Word 103 of BIP39 English is "artefact" (British spelling, standard).
    { name: 'word-103', secret: Buffer.concat([Buffer.from([0x0c, 0xe0]), Buffer.alloc(30, 0)]) },
  ].map(({ name, secret }) => ({ name, private_key_hex: hex(secret), public_key: hex(ed25519(secret).publicKey), phrase: phrase(words, secret) }));
  if (!phraseKeys.find((v) => v.name === 'word-103').phrase.split(' ').includes('artefact')) {
    throw new Error('word-103 vector must contain "artefact"');
  }

  const fingerprints = [
    { name: 'zeros', fp: Buffer.alloc(32, 0) },
    { name: 'ones', fp: Buffer.alloc(32, 0xff) },
    { name: 'certificate', fp: sha256(Buffer.from('paracord/vectors/certificate', 'utf8')) },
  ];
  const trust_words = fingerprints.map(({ name, fp }) => {
    const w = trustWords(words, fp);
    return { name, fingerprint_hex: hex(fp), words: w, shown: w.join(' · ') };
  });

  return {
    about: 'Paracord one-password credential test vectors (docs/setup-spec.md §3.14). Generated by client/src/lib/credential/vectors.reference.mjs from node:crypto alone; do not edit by hand. Shared byte for byte with crates/paracord-api/tests/fixtures/credential_vectors.json.',
    format: 1,
    encodings: { b64url: 'RFC 4648 §5 without padding', hex: 'lowercase' },
    labels: {
      salt: SALT_LABEL, auth_info: AUTH_INFO, wrap_info: WRAP_INFO, aad_prefix: AAD_PREFIX,
      wrap_alg: 'aes256gcm-v2', trust_words: 'paracord/trust-words/v1',
    },
    derivation,
    wrap: [{
      name: 'identity',
      wrap_key_from: derivation[0].name,
      wrap_key_hex: derivation[0].wrap_key_hex,
      private_key_hex: hex(seed),
      public_key: publicKeyHex,
      iv_hex: hex(iv),
      aad: sealed.aad,
      wrapped_key: b64url(sealed.wrapped),
      wrapped_key_bytes: sealed.wrapped.length,
    }],
    // A complete v2 sign-up body for the server tests: derivation[0]'s
    // credential plus the wrapped identity and the register proof.
    register: {
      credential: { salt: derivation[0].salt, kdf, auth_key: derivation[0].auth_key },
      identity: {
        public_key: publicKeyHex,
        wrapped_key: b64url(sealed.wrapped),
        wrap_alg: 'aes256gcm-v2',
        proof: { nonce, timestamp, signature: proofs[0].signature },
      },
      origin,
    },
    proofs,
    phrase: phraseKeys,
    trust_words,
    kdf_policy: {
      accept: [
        { alg: 'scrypt', log_n: 17, r: 8, p: 1 },
        { alg: 'scrypt', log_n: 20, r: 8, p: 1 },
      ],
      refuse_weaker: [
        { alg: 'scrypt', log_n: 16, r: 8, p: 1 },
        { alg: 'scrypt', log_n: 17, r: 4, p: 1 },
        { alg: 'scrypt', log_n: 17, r: 8, p: 0 },
        { alg: 'argon2id', log_n: 17, r: 8, p: 1 },
      ],
      refuse_heavier: [
        { alg: 'scrypt', log_n: 21, r: 8, p: 1 },
        { alg: 'scrypt', log_n: 20, r: 16, p: 1 },
      ],
    },
  };
}

const json = JSON.stringify(build(), null, 2) + '\n';
if (process.argv.includes('--check')) {
  for (const file of [clientCopy, serverCopy]) {
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== json) {
      console.error(`stale: ${path.relative(repo, file)} (run without --check)`);
      process.exit(1);
    }
  }
  console.log('credential vectors: both copies match the reference');
} else {
  fs.mkdirSync(path.dirname(serverCopy), { recursive: true });
  fs.writeFileSync(clientCopy, json);
  fs.writeFileSync(serverCopy, json);
  console.log(`wrote ${path.relative(repo, clientCopy)} and ${path.relative(repo, serverCopy)}`);
}
