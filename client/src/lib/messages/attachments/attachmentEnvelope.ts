/**
 * The versioned body that travels *inside* a Signal-encrypted message.
 *
 * Before this existed the encrypted plaintext was simply the message text. An
 * attachment therefore had nowhere confidential to keep its file key, its real
 * name or its real type, so those lived on the server. The body is now a
 * versioned envelope: the text plus one descriptor per attachment, carrying the
 * per-file key, nonce, original filename, MIME type, plaintext length and
 * plaintext SHA-256, and an optional inline encrypted thumbnail.
 *
 * Compatibility is deliberately one-directional. A body without the sentinel
 * prefix is an ordinary pre-envelope message and decodes as text with no
 * attachments. A body *with* the prefix and an unrecognized version is an error:
 * silently showing the text of a message whose attachments this build cannot
 * understand would be exactly the kind of quiet degradation this project
 * refuses. The prefix is NUL-delimited so no composed message can produce it.
 */
import { ATTACHMENT_TAG_BYTES, type AttachmentKeyMaterial } from './attachmentCrypto';

export const ENCRYPTED_BODY_PREFIX = '\u0000paracord:encrypted-body\u0000';
export const ENCRYPTED_BODY_VERSION = 1;

/**
 * Budget for one encrypted body, in UTF-8 bytes.
 *
 * The server caps a DM ciphertext at 16,384 base64 characters
 * (`MAX_DM_E2EE_CIPHERTEXT_LEN` in `crates/paracord-core/src/message.rs`), which
 * is 12,288 raw bytes including the 16-byte GCM tag. Staying a little under the
 * remaining 12,272 keeps room for the ratchet's own framing, and makes an
 * over-budget message fail here — with a sentence that says what to do — rather
 * than as a 400 from the server after the ratchet has already advanced.
 */
export const MAX_ENCRYPTED_BODY_BYTES = 12_288 - ATTACHMENT_TAG_BYTES - 256;

/** Server-side ceiling on attachments per message (`MAX_MESSAGE_ATTACHMENTS`). */
export const MAX_ENCRYPTED_ATTACHMENTS = 10;

export class EncryptedBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptedBodyError';
  }
}

export interface EncryptedAttachmentThumbnail extends AttachmentKeyMaterial {
  /** base64 ciphertext, carried inline: a thumbnail is never a server object. */
  readonly data: string;
  readonly contentType: string;
  readonly size: number;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
}

export interface EncryptedAttachmentDescriptor extends AttachmentKeyMaterial {
  /** The opaque stored object this descriptor unlocks. */
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
  /** Plaintext length in bytes. */
  readonly size: number;
  /** Lowercase hex SHA-256 of the plaintext. */
  readonly sha256: string;
  readonly width?: number;
  readonly height?: number;
  readonly thumbnail?: EncryptedAttachmentThumbnail;
}

export interface EncryptedMessageBody {
  readonly text: string;
  readonly attachments: readonly EncryptedAttachmentDescriptor[];
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const HEX_256_RE = /^[0-9a-f]{64}$/;
const SNOWFLAKE_RE = /^[1-9][0-9]{0,18}$/;

function requireBase64(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value || !BASE64_RE.test(value)) {
    throw new EncryptedBodyError(`This encrypted message has a malformed attachment ${field}.`);
  }
  return value;
}

function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value || value.length > max || value.includes('\u0000')) {
    throw new EncryptedBodyError(`This encrypted message has a malformed attachment ${field}.`);
  }
  return value;
}

function requireSize(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new EncryptedBodyError(`This encrypted message has a malformed attachment ${field}.`);
  }
  return value;
}

function optionalDimension(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > 65_535) {
    throw new EncryptedBodyError('This encrypted message has malformed attachment dimensions.');
  }
  return value;
}

function readThumbnail(value: unknown): EncryptedAttachmentThumbnail | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object') throw new EncryptedBodyError('This encrypted message has a malformed attachment thumbnail.');
  const raw = value as Record<string, unknown>;
  const width = optionalDimension(raw.width);
  const height = optionalDimension(raw.height);
  if (!width || !height) throw new EncryptedBodyError('This encrypted message has a malformed attachment thumbnail.');
  return {
    key: requireBase64(raw.key, 'thumbnail key'),
    nonce: requireBase64(raw.nonce, 'thumbnail nonce'),
    data: requireBase64(raw.data, 'thumbnail body'),
    contentType: requireText(raw.contentType, 'thumbnail type', 127),
    size: requireSize(raw.size, 'thumbnail size'),
    sha256: (() => {
      const sha = requireText(raw.sha256, 'thumbnail hash', 64).toLowerCase();
      if (!HEX_256_RE.test(sha)) throw new EncryptedBodyError('This encrypted message has a malformed attachment thumbnail hash.');
      return sha;
    })(),
    width,
    height,
  };
}

function readDescriptor(value: unknown): EncryptedAttachmentDescriptor {
  if (!value || typeof value !== 'object') {
    throw new EncryptedBodyError('This encrypted message has a malformed attachment descriptor.');
  }
  const raw = value as Record<string, unknown>;
  const id = requireText(raw.id, 'reference', 20);
  if (!SNOWFLAKE_RE.test(id)) throw new EncryptedBodyError('This encrypted message has a malformed attachment reference.');
  const sha256 = requireText(raw.sha256, 'hash', 64).toLowerCase();
  if (!HEX_256_RE.test(sha256)) throw new EncryptedBodyError('This encrypted message has a malformed attachment hash.');
  return {
    id,
    key: requireBase64(raw.key, 'key'),
    nonce: requireBase64(raw.nonce, 'nonce'),
    filename: requireText(raw.filename, 'name', 255),
    contentType: requireText(raw.contentType, 'type', 127),
    size: requireSize(raw.size, 'size'),
    sha256,
    width: optionalDimension(raw.width),
    height: optionalDimension(raw.height),
    thumbnail: readThumbnail(raw.thumbnail),
  };
}

/** True when `plaintext` is an envelope rather than a pre-envelope text body. */
export function isEncryptedBodyEnvelope(plaintext: string): boolean {
  return plaintext.startsWith(ENCRYPTED_BODY_PREFIX);
}

export function encodeEncryptedBody(body: EncryptedMessageBody): string {
  if (body.attachments.length > MAX_ENCRYPTED_ATTACHMENTS) {
    throw new EncryptedBodyError(`An encrypted message may carry at most ${MAX_ENCRYPTED_ATTACHMENTS} attachments.`);
  }
  const seen = new Set<string>();
  for (const attachment of body.attachments) {
    if (seen.has(attachment.id)) throw new EncryptedBodyError('An encrypted message cannot reference one attachment twice.');
    seen.add(attachment.id);
    readDescriptor(attachment);
  }
  return ENCRYPTED_BODY_PREFIX + JSON.stringify({
    v: ENCRYPTED_BODY_VERSION,
    text: body.text,
    attachments: body.attachments.map(attachment => ({
      id: attachment.id,
      key: attachment.key,
      nonce: attachment.nonce,
      filename: attachment.filename,
      contentType: attachment.contentType,
      size: attachment.size,
      sha256: attachment.sha256,
      ...(attachment.width ? { width: attachment.width } : {}),
      ...(attachment.height ? { height: attachment.height } : {}),
      ...(attachment.thumbnail ? { thumbnail: attachment.thumbnail } : {}),
    })),
  });
}

/** UTF-8 length of an encoded body, which is what the server's cap measures. */
export function encryptedBodyByteLength(encoded: string): number {
  return new TextEncoder().encode(encoded).byteLength;
}

export function assertEncryptedBodyFits(encoded: string): void {
  const length = encryptedBodyByteLength(encoded);
  if (length > MAX_ENCRYPTED_BODY_BYTES) {
    throw new EncryptedBodyError(
      `This encrypted message is ${length} bytes and the limit is ${MAX_ENCRYPTED_BODY_BYTES}. Shorten the text or send fewer attachments in one message.`,
    );
  }
}

/**
 * Decode a decrypted message body.
 *
 * A body with no sentinel is an ordinary text message from before this format —
 * or from any conversation that sent no attachments — and is returned verbatim.
 */
export function decodeEncryptedBody(plaintext: string): EncryptedMessageBody {
  if (!isEncryptedBodyEnvelope(plaintext)) return { text: plaintext, attachments: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.slice(ENCRYPTED_BODY_PREFIX.length));
  } catch {
    throw new EncryptedBodyError('This encrypted message body could not be read.');
  }
  if (!parsed || typeof parsed !== 'object') throw new EncryptedBodyError('This encrypted message body could not be read.');
  const body = parsed as Record<string, unknown>;
  if (body.v !== ENCRYPTED_BODY_VERSION) {
    throw new EncryptedBodyError(
      `This message uses encrypted body format ${String(body.v)}, which this version of Paracord cannot read. Update Paracord to open it.`,
    );
  }
  if (typeof body.text !== 'string') throw new EncryptedBodyError('This encrypted message body could not be read.');
  if (!Array.isArray(body.attachments)) throw new EncryptedBodyError('This encrypted message body could not be read.');
  if (body.attachments.length > MAX_ENCRYPTED_ATTACHMENTS) {
    throw new EncryptedBodyError('This encrypted message references more attachments than a message may carry.');
  }
  const attachments = body.attachments.map(readDescriptor);
  const seen = new Set<string>();
  for (const attachment of attachments) {
    if (seen.has(attachment.id)) throw new EncryptedBodyError('This encrypted message references one attachment twice.');
    seen.add(attachment.id);
  }
  return { text: body.text, attachments };
}

/**
 * Encode a body that fits the server's ciphertext ceiling.
 *
 * Thumbnails are the only optional part of a body, so they are what gives way
 * when the budget is tight: the largest is dropped first and the recipient
 * decrypts the full attachment to preview it instead. When the descriptors and
 * the text alone do not fit, that is a real failure and it is reported.
 */
export function encodeEncryptedBodyWithinBudget(body: EncryptedMessageBody): string {
  let attachments = body.attachments.map(attachment => ({ ...attachment }));
  for (;;) {
    const encoded = encodeEncryptedBody({ text: body.text, attachments });
    if (encryptedBodyByteLength(encoded) <= MAX_ENCRYPTED_BODY_BYTES) return encoded;
    let largest = -1;
    let largestSize = 0;
    attachments.forEach((attachment, index) => {
      const size = attachment.thumbnail?.data.length ?? 0;
      if (size > largestSize) { largest = index; largestSize = size; }
    });
    if (largest < 0) {
      assertEncryptedBodyFits(encoded);
      return encoded;
    }
    attachments = attachments.map((attachment, index) =>
      index === largest ? { ...attachment, thumbnail: undefined } : attachment);
  }
}
