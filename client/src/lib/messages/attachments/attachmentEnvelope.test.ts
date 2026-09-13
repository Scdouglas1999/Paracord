import { describe, expect, it } from 'vitest';
import {
  ENCRYPTED_BODY_PREFIX, ENCRYPTED_BODY_VERSION, EncryptedBodyError, MAX_ENCRYPTED_BODY_BYTES,
  decodeEncryptedBody, encodeEncryptedBody, encodeEncryptedBodyWithinBudget,
  encryptedBodyByteLength, isEncryptedBodyEnvelope,
  type EncryptedAttachmentDescriptor,
} from './attachmentEnvelope';

const descriptor = (overrides: Partial<EncryptedAttachmentDescriptor> = {}): EncryptedAttachmentDescriptor => ({
  id: '1234567890123456789',
  key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  nonce: 'AAAAAAAAAAAAAAAA',
  filename: 'contract.pdf',
  contentType: 'application/pdf',
  size: 4096,
  sha256: 'a'.repeat(64),
  ...overrides,
});

const thumbnail = (bytes: number) => ({
  key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  nonce: 'AAAAAAAAAAAAAAAA',
  data: 'A'.repeat(bytes),
  contentType: 'image/jpeg',
  size: 512,
  sha256: 'b'.repeat(64),
  width: 160,
  height: 90,
});

describe('encrypted message body envelope', () => {
  it('round-trips text and attachment descriptors', () => {
    const encoded = encodeEncryptedBody({ text: 'here is the contract', attachments: [descriptor()] });
    expect(isEncryptedBodyEnvelope(encoded)).toBe(true);
    const decoded = decodeEncryptedBody(encoded);
    expect(decoded.text).toBe('here is the contract');
    expect(decoded.attachments).toEqual([descriptor()]);
  });

  it('keeps the sender’s real filename and type out of anything but the body', () => {
    const encoded = encodeEncryptedBody({ text: '', attachments: [descriptor({ filename: 'payslip.pdf' })] });
    // Everything identifying lives inside the string that gets Signal-encrypted.
    expect(encoded.startsWith(ENCRYPTED_BODY_PREFIX)).toBe(true);
    expect(encoded).toContain('payslip.pdf');
    expect(JSON.parse(encoded.slice(ENCRYPTED_BODY_PREFIX.length)).v).toBe(ENCRYPTED_BODY_VERSION);
  });

  it('treats a body with no sentinel as an ordinary text message', () => {
    expect(decodeEncryptedBody('just a message')).toEqual({ text: 'just a message', attachments: [] });
    expect(isEncryptedBodyEnvelope('just a message')).toBe(false);
  });

  it('refuses a body version it does not understand', () => {
    const future = `${ENCRYPTED_BODY_PREFIX}${JSON.stringify({ v: 99, text: 'hi', attachments: [] })}`;
    expect(() => decodeEncryptedBody(future)).toThrow(/cannot read/);
    expect(() => decodeEncryptedBody(future)).toThrow(EncryptedBodyError);
  });

  it('refuses malformed descriptors rather than rendering a partial message', () => {
    const malformed = (attachment: unknown) =>
      `${ENCRYPTED_BODY_PREFIX}${JSON.stringify({ v: 1, text: '', attachments: [attachment] })}`;
    expect(() => decodeEncryptedBody(malformed({ ...descriptor(), key: 'not base64!!' }))).toThrow(EncryptedBodyError);
    expect(() => decodeEncryptedBody(malformed({ ...descriptor(), sha256: 'short' }))).toThrow(EncryptedBodyError);
    expect(() => decodeEncryptedBody(malformed({ ...descriptor(), size: -1 }))).toThrow(EncryptedBodyError);
    expect(() => decodeEncryptedBody(malformed({ ...descriptor(), id: 'not-a-snowflake' }))).toThrow(EncryptedBodyError);
    expect(() => decodeEncryptedBody(`${ENCRYPTED_BODY_PREFIX}not json`)).toThrow(EncryptedBodyError);
  });

  it('refuses a body that references one attachment twice or too many at once', () => {
    expect(() => encodeEncryptedBody({ text: '', attachments: [descriptor(), descriptor()] }))
      .toThrow(/twice/);
    const many = Array.from({ length: 11 }, (_, index) => descriptor({ id: `${1000 + index}` }));
    expect(() => encodeEncryptedBody({ text: '', attachments: many })).toThrow(/at most 10/);
  });

  it('reports a body that cannot fit the server’s ciphertext ceiling', () => {
    const text = 'x'.repeat(MAX_ENCRYPTED_BODY_BYTES + 10);
    expect(() => encodeEncryptedBodyWithinBudget({ text, attachments: [] }))
      .toThrow(/Shorten the text or send fewer attachments/);
  });

  it('drops the largest thumbnail first rather than failing a sendable message', () => {
    const attachments = [
      descriptor({ id: '111', thumbnail: thumbnail(10000) }),
      descriptor({ id: '222', thumbnail: thumbnail(2000) }),
    ];
    const encoded = encodeEncryptedBodyWithinBudget({ text: 'two photos', attachments });
    expect(encryptedBodyByteLength(encoded)).toBeLessThanOrEqual(MAX_ENCRYPTED_BODY_BYTES);
    const decoded = decodeEncryptedBody(encoded);
    expect(decoded.attachments.map(attachment => Boolean(attachment.thumbnail))).toEqual([false, true]);
    // Dropping a preview never drops the attachment or its key.
    expect(decoded.attachments.map(attachment => attachment.id)).toEqual(['111', '222']);
  });

  it('keeps both thumbnails when they fit', () => {
    const attachments = [
      descriptor({ id: '111', thumbnail: thumbnail(1000) }),
      descriptor({ id: '222', thumbnail: thumbnail(1000) }),
    ];
    const decoded = decodeEncryptedBody(encodeEncryptedBodyWithinBudget({ text: '', attachments }));
    expect(decoded.attachments.every(attachment => Boolean(attachment.thumbnail))).toBe(true);
  });
});
