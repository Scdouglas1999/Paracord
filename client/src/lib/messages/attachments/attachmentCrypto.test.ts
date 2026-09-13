import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_KEY_BYTES, ATTACHMENT_NONCE_BYTES, AttachmentCryptoError, OPAQUE_CONTENT_TYPE,
  base64ToBytes, decryptAttachmentBytes, encryptAttachmentBytes, opaqueObjectName, sha256Hex,
} from './attachmentCrypto';

const body = new TextEncoder().encode('Paracord attachment confidentiality marker');

describe('per-file attachment encryption', () => {
  it('round-trips a file under a fresh key and verifies its plaintext hash', async () => {
    const sealed = await encryptAttachmentBytes(body);
    expect(base64ToBytes(sealed.material.key)).toHaveLength(ATTACHMENT_KEY_BYTES);
    expect(base64ToBytes(sealed.material.nonce)).toHaveLength(ATTACHMENT_NONCE_BYTES);
    expect(sealed.size).toBe(body.byteLength);
    expect(sealed.sha256).toBe(await sha256Hex(body));
    expect(Array.from(sealed.ciphertext)).not.toEqual(Array.from(body));

    const opened = await decryptAttachmentBytes(sealed.ciphertext, sealed.material,
      { size: sealed.size, sha256: sealed.sha256 });
    expect(new TextDecoder().decode(opened)).toBe('Paracord attachment confidentiality marker');
  });

  it('gives every file its own key and nonce', async () => {
    const first = await encryptAttachmentBytes(body);
    const second = await encryptAttachmentBytes(body);
    expect(first.material.key).not.toBe(second.material.key);
    expect(first.material.nonce).not.toBe(second.material.nonce);
  });

  it('refuses ciphertext that was altered in storage', async () => {
    const sealed = await encryptAttachmentBytes(body);
    const tampered = sealed.ciphertext.slice();
    tampered[4] ^= 0xff;
    await expect(decryptAttachmentBytes(tampered, sealed.material,
      { size: sealed.size, sha256: sealed.sha256 }))
      .rejects.toThrow(/authentication check/);
  });

  it('refuses a body that is not the file the sender described', async () => {
    const sealed = await encryptAttachmentBytes(body);
    const other = await encryptAttachmentBytes(new TextEncoder().encode('a different file entirely'));
    // The server swapping one of this conversation's own objects for another:
    // both decrypt under their own key, so only the committed hash catches it.
    await expect(decryptAttachmentBytes(other.ciphertext, other.material,
      { size: other.size, sha256: sealed.sha256 }))
      .rejects.toThrow(/do not match the hash/);
    await expect(decryptAttachmentBytes(other.ciphertext, other.material,
      { size: sealed.size, sha256: other.sha256 }))
      .rejects.toThrow(/length does not match/);
  });

  it('rejects malformed key material instead of guessing', async () => {
    const sealed = await encryptAttachmentBytes(body);
    await expect(decryptAttachmentBytes(sealed.ciphertext, { key: sealed.material.key, nonce: 'AAAA' },
      { size: sealed.size, sha256: sealed.sha256 }))
      .rejects.toBeInstanceOf(AttachmentCryptoError);
    await expect(decryptAttachmentBytes(sealed.ciphertext, { key: 'AAAA', nonce: sealed.material.nonce },
      { size: sealed.size, sha256: sealed.sha256 }))
      .rejects.toBeInstanceOf(AttachmentCryptoError);
  });

  it('refuses to encrypt an empty file', async () => {
    await expect(encryptAttachmentBytes(new Uint8Array(0))).rejects.toThrow(/empty file/);
  });

  it('generates opaque stored-object names that carry nothing', () => {
    const first = opaqueObjectName();
    expect(first).toMatch(/^[0-9a-f]{32}\.bin$/);
    expect(first).not.toBe(opaqueObjectName());
    expect(OPAQUE_CONTENT_TYPE).toBe('application/octet-stream');
  });
});
