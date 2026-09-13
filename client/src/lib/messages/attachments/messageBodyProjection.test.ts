import { describe, expect, it } from 'vitest';
import type { Attachment, Message } from '../../../types';
import { ENCRYPTED_BODY_PREFIX, encodeEncryptedBody, type EncryptedAttachmentDescriptor } from './attachmentEnvelope';
import { applyDecryptedBody, hasEncryptedAttachments } from './messageBodyProjection';

const descriptor: EncryptedAttachmentDescriptor = {
  id: '1234567890123456789',
  key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  nonce: 'AAAAAAAAAAAAAAAA',
  filename: 'holiday.png',
  contentType: 'image/png',
  size: 24_576,
  sha256: 'c'.repeat(64),
  width: 1200,
  height: 800,
};

/** What the server actually hands back for an encrypted conversation. */
const opaque: Attachment = {
  id: '1234567890123456789',
  filename: '0123456789abcdef0123456789abcdef.bin',
  size: 24_592,
  content_type: 'application/octet-stream',
  url: '/api/v1/attachments/1234567890123456789',
};

const message = (attachments: Attachment[]): Message => ({
  id: '5555', channel_id: '42', content: '', attachments,
  e2ee: { version: 2, nonce: 'n', ciphertext: 'c', header: '{}' },
} as unknown as Message);

describe('projecting a decrypted body onto a message', () => {
  it('replaces the server’s opaque row with what the sender described', () => {
    const body = encodeEncryptedBody({ text: 'from the trip', attachments: [descriptor] });
    const projected = applyDecryptedBody(message([opaque]), body);

    expect(projected.content).toBe('from the trip');
    expect(projected.attachments).toHaveLength(1);
    const [attachment] = projected.attachments!;
    expect(attachment.filename).toBe('holiday.png');
    expect(attachment.content_type).toBe('image/png');
    expect(attachment.size).toBe(24_576);
    expect(attachment.width).toBe(1200);
    expect(attachment.encryption).toEqual(descriptor);
    // The server's own URL is preserved so the ciphertext can still be fetched.
    expect(attachment.url).toBe('/api/v1/attachments/1234567890123456789');
  });

  it('leaves a plain text message untouched', () => {
    const projected = applyDecryptedBody(message([]), 'just words');
    expect(projected.content).toBe('just words');
    expect(projected.attachments).toEqual([]);
  });

  it('keeps an attachment the encrypted body never described, without a key', () => {
    const plaintextUpload: Attachment = { ...opaque, id: '999', filename: 'leaked.png', content_type: 'image/png' };
    const body = encodeEncryptedBody({ text: 'mixed', attachments: [descriptor] });
    const projected = applyDecryptedBody(message([opaque, plaintextUpload]), body);

    expect(projected.attachments).toHaveLength(2);
    expect(projected.attachments![0].encryption).toEqual(descriptor);
    // The renderer labels this one as not end-to-end encrypted.
    expect(projected.attachments![1].encryption).toBeUndefined();
    expect(projected.attachments![1].filename).toBe('leaked.png');
  });

  it('describes an attachment the server no longer lists rather than dropping it', () => {
    const body = encodeEncryptedBody({ text: 'gone', attachments: [descriptor] });
    const projected = applyDecryptedBody(message([]), body);
    expect(projected.attachments).toHaveLength(1);
    expect(projected.attachments![0].url).toBe('/api/v1/attachments/1234567890123456789');
  });

  it('reports a body it cannot read instead of showing text without attachments', () => {
    expect(() => applyDecryptedBody(message([opaque]), `${ENCRYPTED_BODY_PREFIX}{"v":7}`))
      .toThrow(/cannot read/);
  });

  it('knows which messages cannot be edited without losing attachment keys', () => {
    expect(hasEncryptedAttachments(message([opaque]))).toBe(true);
    expect(hasEncryptedAttachments(message([]))).toBe(false);
    expect(hasEncryptedAttachments({ id: '1', attachments: [opaque] } as unknown as Message)).toBe(false);
  });
});
