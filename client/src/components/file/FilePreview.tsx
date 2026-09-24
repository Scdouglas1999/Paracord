import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, FileText, FileWarning, X } from 'lucide-react';
import { fileApi } from '../../api/files';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { isAllowedImageMimeType, safeClientResourceUrl } from '../../lib/security';
import { formatFileSize } from '../../lib/formatters';
import { MediaPreview } from './MediaPreview';

interface FilePreviewProps {
  url: string;
  filename: string;
  mimeType: string;
  size: number;
  /**
   * How to turn `url` into something the browser can render.
   *
   * Defaults to the ordinary authenticated attachment fetch. An end-to-end
   * encrypted attachment passes a resolver that downloads the ciphertext and
   * decrypts it on this device, so the same previews work without the server
   * ever holding a readable copy.
   */
  resolveObjectUrl?: (url: string) => Promise<string>;
}

export function FilePreview({ url, filename, mimeType, size, resolveObjectUrl }: FilePreviewProps) {
  const [lightbox, setLightbox] = useState(false);
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(null);
  // A preview that cannot be fetched — or, for an encrypted attachment, cannot
  // be decrypted or fails its integrity check — says so instead of sitting on
  // "Loading attachment…" forever.
  const [error, setError] = useState<string | null>(null);
  const lightboxRef = useRef<HTMLDivElement>(null);
  const closeLightbox = useCallback(() => setLightbox(false), []);
  useFocusTrap(lightboxRef, lightbox, closeLightbox);
  const safeRawUrl = safeClientResourceUrl(url);

  useEffect(() => {
    if (!safeRawUrl) return;

    let cancelled = false;
    let blobUrl: string | null = null;

    const resolve = resolveObjectUrl ?? fileApi.resolveAttachmentObjectUrl;
    void resolve(safeRawUrl).then((src) => {
      if (cancelled) {
        if (src.startsWith('blob:')) URL.revokeObjectURL(src);
        return;
      }
      if (src.startsWith('blob:')) blobUrl = src;
      setResolvedSrc(src);
      setError(null);
    }).catch((failure: unknown) => {
      if (cancelled) return;
      setResolvedSrc(null);
      setError(failure instanceof Error ? failure.message : 'This attachment could not be opened.');
    });

    return () => {
      cancelled = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [safeRawUrl, resolveObjectUrl]);

  if (!safeRawUrl) {
    return (
      <div className="mt-2 flex max-w-sm items-center gap-2.5 rounded-[var(--radius-well)] bg-bg-well px-3.5 py-3 text-meta text-text-muted shadow-[var(--shadow-well)]">
        <FileWarning size={16} className="shrink-0 text-accent-warning" />
        Attachment link blocked.
      </div>
    );
  }

  if (error) {
    return (
      <div role="alert" className="mt-2 flex max-w-sm items-center gap-2.5 rounded-[var(--radius-well)] bg-danger-well px-3.5 py-3 text-meta text-accent-danger">
        <FileWarning size={16} className="shrink-0" />
        <span className="min-w-0">{filename}: {error}</span>
      </div>
    );
  }

  if (!resolvedSrc) {
    return (
      <div className="mt-2 max-w-sm rounded-[var(--radius-well)] bg-bg-well px-3.5 py-3 text-meta text-text-faint shadow-[var(--shadow-well)]">
        Loading attachment…
      </div>
    );
  }

  // Image preview
  if (isAllowedImageMimeType(mimeType)) {
    return (
      <>
        <div className="mt-2 max-w-md overflow-hidden rounded-[var(--radius-well)] bg-bg-well shadow-[var(--shadow-chip)]">
          <button
            type="button"
            aria-label={`Open image preview: ${filename}`}
            className="pc-focusable block w-full p-0 text-left outline-none"
            onClick={() => setLightbox(true)}
          >
            <img
              src={resolvedSrc}
              alt={filename}
              className="max-h-72 w-full object-contain"
            />
          </button>
          <div className="flex items-center gap-2 px-3 py-2 text-meta text-text-muted">
            <span className="min-w-0 truncate font-medium text-text-body">{filename}</span>
            <span className="pc-mono ml-auto shrink-0">{formatFileSize(size)}</span>
          </div>
        </div>

        {/* Lightbox */}
        {lightbox && (
          <div
            ref={lightboxRef}
            className="fixed inset-0 z-50 flex cursor-pointer items-center justify-center"
            role="dialog"
            aria-modal="true"
            aria-label={`Image preview: ${filename}`}
            tabIndex={-1}
            style={{ backgroundColor: 'var(--overlay-backdrop)' }}
            onClick={closeLightbox}
          >
            <button
              type="button"
              aria-label="Close image preview"
              className="pc-focusable absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-[var(--radius-control)] bg-bg-raised text-text-primary shadow-[var(--shadow-lifted)] outline-none transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:bg-bg-mod-strong"
              onClick={closeLightbox}
            >
              <X size={18} />
            </button>
            <img src={resolvedSrc} alt={filename} className="max-h-[90vh] max-w-[90vw] object-contain" />
          </div>
        )}
      </>
    );
  }

  // Video preview
  if (mimeType.startsWith('video/')) {
    return (
      <div className="mt-2 max-w-md overflow-hidden rounded-[var(--radius-well)] bg-bg-well shadow-[var(--shadow-chip)]">
        <MediaPreview key={resolvedSrc} src={resolvedSrc} filename={filename} kind="video" />
        <div className="flex items-center gap-2 px-3 py-2 text-meta text-text-muted">
          <span className="min-w-0 truncate font-medium text-text-body">{filename}</span>
          <span className="pc-mono ml-auto shrink-0">{formatFileSize(size)}</span>
        </div>
      </div>
    );
  }

  // Audio preview
  if (mimeType.startsWith('audio/')) {
    return (
      <div className="mt-2 max-w-md overflow-hidden rounded-[var(--radius-well)] bg-bg-well shadow-[var(--shadow-chip)]">
        <div className="flex items-center gap-3 p-3.5">
          <MediaPreview key={resolvedSrc} src={resolvedSrc} filename={filename} kind="audio" />
        </div>
        <div className="flex items-center gap-2 px-3 pb-2 text-meta text-text-muted">
          <span className="min-w-0 truncate font-medium text-text-body">{filename}</span>
          <span className="pc-mono ml-auto shrink-0">{formatFileSize(size)}</span>
        </div>
      </div>
    );
  }

  // Generic / unknown-type file card — framed, with a lucide file icon and a
  // download affordance (no emoji chrome, kill-list #3).
  return (
    <div className="mt-2 max-w-sm">
      <a
        href={resolvedSrc}
        download={filename}
        className="pc-focusable group flex items-center gap-3 rounded-[var(--radius-well)] bg-bg-well p-3 no-underline shadow-[var(--shadow-well)] outline-none transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:bg-bg-mod-subtle"
      >
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-chip)] bg-bg-mod-strong text-text-secondary">
          <FileText size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-label font-medium text-text-primary">{filename}</div>
          <div className="pc-mono text-meta text-text-faint">{formatFileSize(size)}</div>
        </div>
        <Download
          size={18}
          className="shrink-0 text-text-muted transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] group-hover:text-accent-primary"
        />
      </a>
    </div>
  );
}
