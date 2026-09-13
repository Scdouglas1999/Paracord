/**
 * The encrypted attachment producer.
 *
 * This is the only path by which a file may reach an end-to-end encrypted
 * conversation. It encrypts each staged file under its own key, hands the
 * server nothing but opaque ciphertext under a random name, and keeps every
 * plaintext fact about the file — its name, its type, its length, its hash and
 * its key — inside the Signal-encrypted message body.
 *
 * There is deliberately no unencrypted branch here. Guild channels keep their
 * existing plaintext upload path in `api/files.ts`; encrypted conversations use
 * this producer or refuse the attachment.
 */
import {
  OPAQUE_CONTENT_TYPE, encryptAttachmentBytes, opaqueObjectName, sha256Hex, bytesToBase64,
  ATTACHMENT_TAG_BYTES, AttachmentCryptoError,
} from './attachmentCrypto';
import {
  MAX_ENCRYPTED_ATTACHMENTS, EncryptedBodyError,
  type EncryptedAttachmentThumbnail,
} from './attachmentEnvelope';
import type { StageInput, StagedDescriptor } from './attachmentStaging';

/** Longest edge of a generated preview, and the ceiling on its encoded size. */
const THUMBNAIL_EDGE = 160;
const THUMBNAIL_MAX_BYTES = 6 * 1024;
const THUMBNAIL_TYPE = 'image/jpeg';

export interface AttachmentSizeLimits {
  /** The server's ceiling, applied to the ciphertext that is actually sent. */
  readonly maxCiphertextBytes: number;
}

export interface PreparedAttachment extends StageInput {
  readonly filename: string;
}

interface RenderedThumbnail {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/**
 * Render a small preview of an image.
 *
 * Best effort by design: a build without `createImageBitmap`/canvas, an image
 * the decoder rejects, or a preview that will not fit the message body simply
 * produces no thumbnail, and the recipient decrypts the full file to show it.
 * That changes how fast a preview appears, never who can read it.
 */
async function renderThumbnail(file: Blob): Promise<RenderedThumbnail | null> {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return null;
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file);
    const scale = Math.min(1, THUMBNAIL_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await canvas.convertToBlob({ type: THUMBNAIL_TYPE, quality: 0.6 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > THUMBNAIL_MAX_BYTES) return null;
    return { bytes, width, height };
  } catch {
    return null;
  } finally { bitmap?.close(); }
}

/** Natural dimensions of an image, when this build can decode it. */
async function imageDimensions(file: Blob): Promise<{ width: number; height: number } | null> {
  if (typeof createImageBitmap !== 'function') return null;
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file);
    return { width: bitmap.width, height: bitmap.height };
  } catch {
    return null;
  } finally { bitmap?.close(); }
}

async function encryptThumbnail(rendered: RenderedThumbnail): Promise<EncryptedAttachmentThumbnail> {
  const sealed = await encryptAttachmentBytes(rendered.bytes);
  return {
    key: sealed.material.key,
    nonce: sealed.material.nonce,
    data: bytesToBase64(sealed.ciphertext),
    contentType: THUMBNAIL_TYPE,
    size: rendered.bytes.byteLength,
    sha256: await sha256Hex(rendered.bytes),
    width: rendered.width,
    height: rendered.height,
  };
}

/**
 * Encrypt files for one queued message.
 *
 * Size is enforced against the ciphertext, because the ciphertext is what the
 * server stores and what its `max_upload_size` measures. The GCM tag is part of
 * that, so the usable plaintext ceiling is 16 bytes lower than the advertised
 * limit and the message says so rather than failing at the server.
 */
export async function prepareEncryptedAttachments(
  files: readonly File[], limits: AttachmentSizeLimits,
): Promise<PreparedAttachment[]> {
  if (files.length === 0) return [];
  if (files.length > MAX_ENCRYPTED_ATTACHMENTS) {
    throw new EncryptedBodyError(`An encrypted message may carry at most ${MAX_ENCRYPTED_ATTACHMENTS} attachments.`);
  }
  const maxPlaintext = limits.maxCiphertextBytes - ATTACHMENT_TAG_BYTES;
  if (maxPlaintext <= 0) throw new AttachmentCryptoError('This server does not allow uploads large enough to carry an encrypted file.');
  const prepared: PreparedAttachment[] = [];
  for (const file of files) {
    if (file.size === 0) throw new AttachmentCryptoError(`“${file.name}” is empty and cannot be attached.`);
    if (file.size > maxPlaintext) {
      throw new AttachmentCryptoError(
        `“${file.name}” is ${file.size} bytes. An encrypted attachment may be at most ${maxPlaintext} bytes on this server, because its authentication tag counts against the upload limit.`,
      );
    }
    const plaintext = new Uint8Array(await file.arrayBuffer());
    let sealed;
    try { sealed = await encryptAttachmentBytes(plaintext); }
    finally { plaintext.fill(0); }
    if (sealed.ciphertext.byteLength > limits.maxCiphertextBytes) {
      throw new AttachmentCryptoError(`“${file.name}” exceeds this server's upload limit once encrypted.`);
    }
    const contentType = file.type || OPAQUE_CONTENT_TYPE;
    const isImage = contentType.startsWith('image/');
    const dimensions = isImage ? await imageDimensions(file) : null;
    const rendered = isImage ? await renderThumbnail(file) : null;
    const descriptor: StagedDescriptor = {
      key: sealed.material.key,
      nonce: sealed.material.nonce,
      filename: file.name.slice(0, 255) || 'attachment',
      contentType: contentType.slice(0, 127),
      size: sealed.size,
      sha256: sealed.sha256,
      ...(dimensions ? { width: dimensions.width, height: dimensions.height } : {}),
      ...(rendered ? { thumbnail: await encryptThumbnail(rendered) } : {}),
    };
    prepared.push({ descriptor, ciphertext: sealed.ciphertext, objectName: opaqueObjectName(), filename: file.name });
  }
  return prepared;
}

/** Upload one opaque ciphertext body. Implemented by the account's runtime. */
export type EncryptedAttachmentUploader = (input: {
  channelId: string;
  objectName: string;
  ciphertext: Uint8Array;
}) => Promise<string>;
