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
      <div className="mt-1 flex max-w-sm items-center gap-2.5 rounded-md border border-border-subtle bg-bg-secondary px-3.5 py-3 text-meta text-text-muted">
        <FileWarning size={16} className="shrink-0 text-accent-warning" />
        Attachment link blocked.
      </div>
    );
  }

  if (error) {
    return (
      <div role="alert" className="mt-1 flex max-w-sm items-center gap-2.5 rounded-md border border-accent-danger/40 bg-bg-secondary px-3.5 py-3 text-meta text-accent-danger">
        <FileWarning size={16} className="shrink-0" />
        <span className="min-w-0">{filename}: {error}</span>
      </div>
    );
  }

  if (!resolvedSrc) {
    return (
      <div className="mt-1 max-w-sm rounded-md border border-border-subtle bg-bg-secondary px-3.5 py-3 text-meta text-text-muted">
        Loading attachment…
      </div>
    );
  }

  // Image preview
  if (isAllowedImageMimeType(mimeType)) {
    return (
      <>
        <div className="mt-1 max-w-md">
          <button
            type="button"
            aria-label={`Open image preview: ${filename}`}
            className="block max-w-full overflow-hidden rounded-md border border-border-subtle p-0 text-left outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:border-border-strong focus-visible:shadow-[var(--focus-ring)]"
            onClick={() => setLightbox(true)}
          >
            <img
              src={resolvedSrc}
              alt={filename}
              className="max-h-72 object-contain"
            />
          </button>
          <div className="mt-1.5 flex items-center gap-2 text-meta text-text-muted">
            <span className="truncate">{filename}</span>
            <span className="tabular-nums">{formatFileSize(size)}</span>
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
              className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-sm border border-border-subtle bg-bg-accent text-text-primary outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-strong focus-visible:shadow-[var(--focus-ring)]"
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
      <div className="mt-1 max-w-md">
        <MediaPreview key={resolvedSrc} src={resolvedSrc} filename={filename} kind="video" />
        <div className="mt-1.5 flex items-center gap-2 text-meta text-text-muted">
          <span className="truncate">{filename}</span>
          <span className="tabular-nums">{formatFileSize(size)}</span>
        </div>
      </div>
    );
  }

  // Audio preview
  if (mimeType.startsWith('audio/')) {
    return (
      <div className="mt-1 max-w-md">
        <div className="flex items-center gap-3 rounded-md border border-border-subtle bg-bg-secondary p-3.5">
          <MediaPreview key={resolvedSrc} src={resolvedSrc} filename={filename} kind="audio" />
        </div>
        <div className="mt-1.5 flex items-center gap-2 text-meta text-text-muted">
          <span className="truncate">{filename}</span>
          <span className="tabular-nums">{formatFileSize(size)}</span>
        </div>
      </div>
    );
  }

  // Generic / unknown-type file card — framed, with a lucide file icon and a
  // download affordance (no emoji chrome, kill-list #3).
  return (
    <div className="mt-1 max-w-sm">
      <a
        href={resolvedSrc}
        download={filename}
        className="group flex items-center gap-3 rounded-md border border-border-subtle bg-bg-secondary p-3 no-underline outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:border-border-strong hover:bg-bg-accent focus-visible:shadow-[var(--focus-ring)]"
      >
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-sm bg-bg-tertiary text-text-secondary">
          <FileText size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-label text-text-primary">{filename}</div>
          <div className="text-meta tabular-nums text-text-muted">{formatFileSize(size)}</div>
        </div>
        <Download
          size={18}
          className="shrink-0 text-text-muted transition-colors duration-[140ms] ease-[var(--ease-out)] group-hover:text-accent-primary"
        />
      </a>
    </div>
  );
}
