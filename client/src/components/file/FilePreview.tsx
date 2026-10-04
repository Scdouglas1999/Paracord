import { useCallback, useEffect, useRef, useState } from 'react';
import { fileApi } from '../../api/files';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { isAllowedImageMimeType, safeClientResourceUrl } from '../../lib/security';
import { formatFileSize } from '../../lib/formatters';
import { DownloadMark, FileMark } from '../glass/cards/CardGlyphs';
import { IxGlyph } from '../ix/glyphs/IxGlyph';
import { Control } from '../ix/primitives/Control';
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

    let canceled = false;
    let blobUrl: string | null = null;

    const resolve = resolveObjectUrl ?? fileApi.resolveAttachmentObjectUrl;
    void resolve(safeRawUrl).then((src) => {
      if (canceled) {
        if (src.startsWith('blob:')) URL.revokeObjectURL(src);
        return;
      }
      if (src.startsWith('blob:')) blobUrl = src;
      setResolvedSrc(src);
      setError(null);
    }).catch((failure: unknown) => {
      if (canceled) return;
      setResolvedSrc(null);
      setError(failure instanceof Error ? failure.message : 'This attachment could not be opened.');
    });

    return () => {
      canceled = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [safeRawUrl, resolveObjectUrl]);

  if (!safeRawUrl) {
    return <div className="ix-media-note">Attachment link blocked.</div>;
  }

  if (error) {
    return (
      <div role="alert" className="ix-media-note" data-tone="error">
        <span className="min-w-0">{filename}: {error}</span>
      </div>
    );
  }

  if (!resolvedSrc) {
    return <div className="ix-media-note">Loading attachment…</div>;
  }

  // Image preview
  if (isAllowedImageMimeType(mimeType)) {
    return (
      <>
        <div className="ix-media-card">
          <button
            type="button"
            aria-label={`Open image preview: ${filename}`}
            className="ix-media-card__open"
            onClick={() => setLightbox(true)}
          >
            <img src={resolvedSrc} alt={filename} className="ix-media-card__img" />
          </button>
          <MediaCardFoot filename={filename} size={size} />
        </div>

        {/* Lightbox */}
        {lightbox && (
          <div
            ref={lightboxRef}
            className="ix-lightbox fixed inset-0"
            role="dialog"
            aria-modal="true"
            aria-label={`Image preview: ${filename}`}
            tabIndex={-1}
            onClick={closeLightbox}
          >
            <Control label="Close image preview" className="ix-lightbox__close" onClick={closeLightbox}>
              <IxGlyph name="x" size={16} />
            </Control>
            <img src={resolvedSrc} alt={filename} className="ix-lightbox__img" />
          </div>
        )}
      </>
    );
  }

  // Video preview
  if (mimeType.startsWith('video/')) {
    return (
      <div className="ix-media-card">
        <MediaPreview key={resolvedSrc} src={resolvedSrc} filename={filename} kind="video" />
        <MediaCardFoot filename={filename} size={size} />
      </div>
    );
  }

  // Audio preview
  if (mimeType.startsWith('audio/')) {
    return (
      <div className="ix-media-card">
        <div className="ix-media-card__audio">
          <MediaPreview key={resolvedSrc} src={resolvedSrc} filename={filename} kind="audio" />
        </div>
        <MediaCardFoot filename={filename} size={size} />
      </div>
    );
  }

  // Generic / unknown-type file: a card bubble (docs/index-spec.md §4.11), a glyph
  // tile in the place's hue, the name, the size and the way to download.
  return (
    <a href={resolvedSrc} download={filename} className="ix-file">
      <span className="ix-file__tile ix-hue-tile" aria-hidden>
        <FileMark />
      </span>
      <span className="ix-file__text">
        <span className="ix-file__name">{filename}</span>
        <span className="ix-file__size">{formatFileSize(size)}</span>
      </span>
      <span className="ix-file__dl" aria-hidden>
        <DownloadMark />
      </span>
    </a>
  );
}

/** The line under a picture, a video or a sound: its name, and its size at the end. */
function MediaCardFoot({ filename, size }: { filename: string; size: number }) {
  return (
    <div className="ix-media-card__foot">
      <span className="ix-media-card__name">{filename}</span>
      <span className="ix-media-card__size">{formatFileSize(size)}</span>
    </div>
  );
}
