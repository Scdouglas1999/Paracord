import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, FileWarning, Lock, ShieldAlert } from 'lucide-react';
import type { Attachment } from '../../types';
import { formatFileSize } from '../../lib/formatters';
import { isAllowedImageMimeType } from '../../lib/security';
import {
  decryptAttachmentBlob, decryptAttachmentThumbnail, isEncryptedAttachment,
  type EncryptedAttachment as EncryptedAttachmentModel,
} from '../../lib/messages/attachments/attachmentDecryption';
import { FilePreview } from './FilePreview';
import { Button, Chip } from '../ui';

/**
 * An attachment of an end-to-end encrypted conversation.
 *
 * The server holds an opaque blob under a random name. Everything shown here —
 * the name, the type, the size, the preview — comes from the descriptor that
 * traveled inside the encrypted message, and the bytes are decrypted on this
 * device when they are actually needed. Object URLs are revoked when the view
 * goes away, so a decrypted copy never outlives the thing showing it.
 *
 * Images resolve on sight, exactly as an unencrypted image does. Anything
 * larger-by-nature waits for an explicit action rather than silently pulling a
 * whole file down to build a link.
 */
export function EncryptedAttachment({ attachment }: { attachment: Attachment }) {
  if (!isEncryptedAttachment(attachment)) {
    return <UnencryptedAttachmentNotice attachment={attachment} />;
  }
  return <DecryptingAttachment attachment={attachment} />;
}

/**
 * An attachment this device holds no key for.
 *
 * Either the encrypted body never described it — it was uploaded in the clear,
 * by an older client or any path other than the encrypted producer, and the
 * server can read it — or the body itself could not be decrypted here. Both
 * cases are stated rather than guessed at, because presenting the file beside
 * genuinely encrypted ones would misrepresent the boundary.
 */
function UnencryptedAttachmentNotice({ attachment }: { attachment: Attachment }) {
  return (
    <div
      role="note"
      className="mt-2 inline-flex max-w-full flex-wrap items-center gap-2 rounded-[var(--radius-well)] bg-bg-well px-3 py-2 text-meta shadow-[var(--shadow-well)]"
    >
      <ShieldAlert size={16} className="shrink-0 text-accent-warning" />
      <span className="max-w-[20rem] truncate font-medium text-text-body">{attachment.filename}</span>
      <span className="text-meta text-text-faint">
        No key for this file arrived in the encrypted message. If it was sent without
        end-to-end encryption, the instance can read it.
      </span>
    </div>
  );
}

function DecryptingAttachment({ attachment }: { attachment: EncryptedAttachmentModel }) {
  const descriptor = attachment.encryption;
  const isImage = isAllowedImageMimeType(descriptor.contentType);
  const [requested, setRequested] = useState(isImage);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resolveObjectUrl = useCallback(async () => {
    const blob = await decryptAttachmentBlob(attachment);
    return URL.createObjectURL(blob);
  }, [attachment]);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    let url: string | null = null;
    try {
      const blob = await decryptAttachmentBlob(attachment);
      url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = descriptor.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'This attachment could not be decrypted.');
    } finally {
      // Give the navigation a tick to claim the blob before it is released.
      if (url) setTimeout((released: string) => URL.revokeObjectURL(released), 10_000, url);
      setSaving(false);
    }
  };

  return (
    <div className="flex max-w-fit flex-col gap-1.5">
      {requested ? (
        <FilePreview
          url={attachment.url}
          filename={descriptor.filename}
          mimeType={descriptor.contentType}
          size={descriptor.size}
          resolveObjectUrl={resolveObjectUrl}
        />
      ) : (
        <div className="mt-2 inline-flex max-w-full flex-wrap items-center gap-2 rounded-[var(--radius-well)] bg-bg-well px-3 py-2 text-meta shadow-[var(--shadow-well)]">
          <EncryptedThumbnail attachment={attachment} />
          <Lock size={14} className="shrink-0 text-text-muted" aria-hidden />
          <span className="max-w-[20rem] truncate font-medium text-text-body">{descriptor.filename}</span>
          <span className="pc-mono text-meta text-text-faint">{formatFileSize(descriptor.size)}</span>
          <Button variant="ghost" size="sm" onClick={() => setRequested(true)}>
            Decrypt and open
          </Button>
        </div>
      )}
      {/* The project's unlayered `button { font: inherit }` base rule outranks any
          Tailwind text-size utility on a button, so the size is set on the row
          the buttons inherit from. */}
      <div className="flex flex-wrap items-center gap-2 text-meta">
        <Chip size="sm" className="text-text-faint">
          <Lock size={10} aria-hidden /> End-to-end encrypted
        </Chip>
        <Button variant="ghost" size="sm" onClick={() => void save()} disabled={saving}>
          {saving ? 'Decrypting…' : 'Download'}
          <Download size={12} aria-hidden />
        </Button>
      </div>
      {error && (
        <p role="alert" className="inline-flex items-center gap-1.5 text-meta text-accent-danger">
          <FileWarning size={14} className="shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}

/** The sender's inline preview, decrypted without touching the full attachment. */
function EncryptedThumbnail({ attachment }: { attachment: EncryptedAttachmentModel }) {
  const [source, setSource] = useState<string | null>(null);
  const url = useRef<string | null>(null);
  const thumbnail = attachment.encryption.thumbnail;

  useEffect(() => {
    let canceled = false;
    if (!thumbnail) return;
    void decryptAttachmentThumbnail(attachment).then(blob => {
      if (!blob) return;
      const objectUrl = URL.createObjectURL(blob);
      if (canceled) { URL.revokeObjectURL(objectUrl); return; }
      url.current = objectUrl;
      setSource(objectUrl);
    }).catch(() => { /* The full attachment remains available on demand. */ });
    return () => {
      canceled = true;
      if (url.current) { URL.revokeObjectURL(url.current); url.current = null; }
    };
  }, [attachment, thumbnail]);

  if (!thumbnail || !source) return null;
  return (
    <img
      src={source}
      alt={`Preview of ${attachment.encryption.filename}`}
      width={thumbnail.width}
      height={thumbnail.height}
      className="max-h-16 w-auto rounded-[var(--radius-chip)]"
    />
  );
}
