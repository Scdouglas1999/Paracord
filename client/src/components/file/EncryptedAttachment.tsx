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

/**
 * An attachment of an end-to-end encrypted conversation.
 *
 * The server holds an opaque blob under a random name. Everything shown here —
 * the name, the type, the size, the preview — comes from the descriptor that
 * travelled inside the encrypted message, and the bytes are decrypted on this
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
      className="inline-flex max-w-fit flex-wrap items-center gap-2 rounded-md border border-accent-warning/40 bg-bg-mod-subtle px-3 py-2 text-sm"
    >
      <ShieldAlert size={16} className="shrink-0 text-accent-warning" />
      <span className="max-w-[20rem] truncate text-text-secondary">{attachment.filename}</span>
      <span className="text-meta text-text-muted">
        No key for this file arrived in the encrypted message. If it was sent without
        end-to-end encryption, the server can read it.
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
        <div className="inline-flex max-w-fit flex-wrap items-center gap-2 rounded-md border border-border-subtle bg-bg-mod-subtle px-3 py-2 text-sm">
          <EncryptedThumbnail attachment={attachment} />
          <Lock size={14} className="shrink-0 text-text-muted" />
          <span className="max-w-[20rem] truncate text-text-primary">{descriptor.filename}</span>
          <span className="tabular-nums text-meta text-text-muted">{formatFileSize(descriptor.size)}</span>
          <span className="text-meta">
            <button
              type="button"
              className="rounded-sm border border-border-subtle px-2 py-1 font-semibold text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
              onClick={() => setRequested(true)}
            >
              Decrypt and open
            </button>
          </span>
        </div>
      )}
      {/* The project's unlayered `button { font: inherit }` base rule outranks any
          Tailwind text-size utility on a button, so the size is set on the row
          the buttons inherit from. */}
      <div className="flex flex-wrap items-center gap-2 text-meta">
        <span className="inline-flex items-center gap-1 rounded-xs border border-border-subtle px-1.5 py-[1px] text-[10px] font-semibold uppercase tracking-wide text-text-muted">
          <Lock size={10} /> End-to-end encrypted
        </span>
        <button
          type="button"
          className="rounded-sm border border-border-subtle bg-bg-mod-subtle px-2.5 py-1 text-meta font-semibold text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
          onClick={() => void save()}
          disabled={saving}
        >
          {saving ? 'Decrypting…' : 'Download'}
          <Download size={12} className="ml-1 inline align-[-1px]" aria-hidden="true" />
        </button>
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
    let cancelled = false;
    if (!thumbnail) return;
    void decryptAttachmentThumbnail(attachment).then(blob => {
      if (!blob) return;
      const objectUrl = URL.createObjectURL(blob);
      if (cancelled) { URL.revokeObjectURL(objectUrl); return; }
      url.current = objectUrl;
      setSource(objectUrl);
    }).catch(() => { /* The full attachment remains available on demand. */ });
    return () => {
      cancelled = true;
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
      className="max-h-16 w-auto rounded-sm border border-border-subtle"
    />
  );
}
