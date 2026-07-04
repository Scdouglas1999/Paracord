import { useCallback, useRef, useState } from 'react';
import { Download, FileText, FileWarning, X } from 'lucide-react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { isAllowedImageMimeType, safeClientResourceUrl } from '../../lib/security';
import { formatFileSize } from '../../lib/formatters';

interface FilePreviewProps {
  url: string;
  filename: string;
  mimeType: string;
  size: number;
}

export function FilePreview({ url, filename, mimeType, size }: FilePreviewProps) {
  const [lightbox, setLightbox] = useState(false);
  const lightboxRef = useRef<HTMLDivElement>(null);
  const closeLightbox = useCallback(() => setLightbox(false), []);
  useFocusTrap(lightboxRef, lightbox, closeLightbox);
  const safeUrl = safeClientResourceUrl(url);

  if (!safeUrl) {
    return (
      <div className="mt-1 flex max-w-sm items-center gap-2.5 rounded-md border border-border-subtle bg-bg-secondary px-3.5 py-3 text-meta text-text-muted">
        <FileWarning size={16} className="shrink-0 text-accent-warning" />
        Attachment link blocked.
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
              src={safeUrl}
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
            <img src={safeUrl} alt={filename} className="max-h-[90vh] max-w-[90vw] object-contain" />
          </div>
        )}
      </>
    );
  }

  // Video preview
  if (mimeType.startsWith('video/')) {
    return (
      <div className="mt-1 max-w-md">
        <video
          src={safeUrl}
          controls
          className="max-h-72 rounded-md border border-border-subtle"
        />
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
          <audio src={safeUrl} controls className="h-9 flex-1" />
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
        href={safeUrl}
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
