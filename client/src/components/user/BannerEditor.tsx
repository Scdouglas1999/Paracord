import { useRef, useState } from 'react';
import { Upload, X } from 'lucide-react';

import { Button, buttonVariants } from '../ui/Button';
import { cn } from '../../lib/utils';
import { ResourceImage } from '../ui/ResourceImage';
import { extractApiError } from '../../api/client';
import { resolveBannerUrl } from '../../lib/userAvatar';
import { useDownloadTicket } from '../../hooks/useDownloadTicket';
import {
  accentCssColor,
  clampPan,
  coverScale,
  MAX_BANNER_ZOOM,
  MIN_BANNER_ZOOM,
  sourceRect,
  type CropView,
} from './bannerCrop';

const MAX_BANNER_BYTES = 8 * 1024 * 1024;

interface BannerEditorProps {
  /** The quiet label above the preview. */
  label: string;
  bannerHash: string | null | undefined;
  /** Stored `0xRRGGBB`, shown when there is no banner. */
  accentColor?: number | null;
  outputWidth: number;
  outputHeight: number;
  /** Shown under the preview. */
  hint: string;
  onUpload: (file: File) => Promise<void>;
  onRemove: () => Promise<void>;
  /** Present only on a profile. Changing it does not upload by itself. */
  onAccentChange?: (color: number | null) => void;
}

interface LoadedImage {
  file: File;
  url: string;
  width: number;
  height: number;
}

export function BannerEditor({
  label,
  bannerHash,
  accentColor = null,
  outputWidth,
  outputHeight,
  hint,
  onUpload,
  onRemove,
  onAccentChange,
}: BannerEditorProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState<LoadedImage | null>(null);
  const [view, setView] = useState<CropView>({ zoom: 1, panX: 0, panY: 0 });
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);

  // Subscribing to the ticket re-renders, and so re-resolves the URL, once it is minted.
  useDownloadTicket();
  const currentSrc = resolveBannerUrl(bannerHash);
  const accent = accentCssColor(accentColor);

  const releaseLoaded = (next: LoadedImage | null) => {
    setLoaded((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return next;
    });
  };

  const pickFile = (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('Banner image must be PNG, JPEG, GIF, or WebP.');
      return;
    }
    if (file.size > MAX_BANNER_BYTES) {
      setError('Banner must be 8 MB or smaller.');
      return;
    }
    setError(null);
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      releaseLoaded({ file, url, width: image.naturalWidth, height: image.naturalHeight });
      setView({ zoom: 1, panX: 0, panY: 0 });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      setError('Could not read that image.');
    };
    image.src = url;
  };

  const frameSize = () => {
    const frame = frameRef.current;
    return {
      width: frame?.clientWidth ?? outputWidth,
      height: frame?.clientHeight ?? outputHeight,
    };
  };

  const move = (panX: number, panY: number, zoom = view.zoom) => {
    if (!loaded) return;
    const frame = frameSize();
    setView({
      zoom,
      ...clampPan(panX, panY, loaded.width, loaded.height, frame.width, frame.height, zoom),
    });
  };

  const confirmCrop = async () => {
    if (!loaded || busy) return;
    setBusy('upload');
    setError(null);
    try {
      const frame = frameSize();
      const file = await renderBanner(loaded, frame, view, outputWidth, outputHeight);
      await onUpload(file);
      releaseLoaded(null);
    } catch (err) {
      setError(err instanceof Error && err.message.startsWith('Could not prepare')
        ? err.message
        : `Could not upload the banner: ${extractApiError(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy('remove');
    setError(null);
    try {
      await onRemove();
    } catch (err) {
      setError(`Could not remove the banner: ${extractApiError(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const previewStyle = loaded
    ? positionedImage(loaded, frameSize(), view)
    : null;

  return (
    <section className="flex flex-col gap-3" aria-label={label}>
      <div className="text-section text-text-faint">{label}</div>
      <div
        ref={frameRef}
        className={cn(
          'relative aspect-[3/1] w-full overflow-hidden rounded-[var(--radius-card)] bg-bg-mod-subtle',
          loaded && 'cursor-grab touch-none active:cursor-grabbing',
        )}
        style={loaded || currentSrc ? undefined : { background: accent ?? 'var(--accent-tint-strong)' }}
        onPointerDown={(event) => {
          if (!loaded) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, y: event.clientY, panX: view.panX, panY: view.panY };
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (!start) return;
          move(start.panX + event.clientX - start.x, start.panY + event.clientY - start.y);
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        {loaded && previewStyle ? (
          <img
            src={loaded.url}
            alt=""
            draggable={false}
            className="absolute max-w-none select-none"
            style={{ ...previewStyle, touchAction: 'none' }}
          />
        ) : currentSrc ? (
          <ResourceImage src={currentSrc} alt="" className="h-full w-full object-cover" />
        ) : null}
      </div>

      {loaded ? (
        <div className="flex flex-col gap-3">
          <label className="flex items-center gap-3 text-meta text-text-secondary">
            <span className="shrink-0">Zoom</span>
            <input
              type="range"
              min={MIN_BANNER_ZOOM}
              max={MAX_BANNER_ZOOM}
              step={0.01}
              value={view.zoom}
              aria-label="Banner zoom"
              className="w-full accent-[var(--accent-primary)]"
              onChange={(event) => move(view.panX, view.panY, Number(event.target.value))}
            />
          </label>
          <p className="text-meta text-text-muted">Drag the picture to position it. The saved banner is a still image.</p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void confirmCrop()} loading={busy === 'upload'} disabled={busy !== null}>
              Use this crop
            </Button>
            <Button variant="ghost" onClick={() => releaseLoaded(null)} disabled={busy !== null}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex rounded-[var(--radius-control)] focus-within:shadow-[var(--focus-ring)]">
            <input
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              className="sr-only"
              aria-label="Upload banner"
              onChange={(event) => {
                pickFile(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
            <span className={cn(buttonVariants({ variant: 'primary' }), 'cursor-pointer')}>
              <Upload size={15} aria-hidden />
              Upload
            </span>
          </label>
          {bannerHash && (
            <Button variant="danger" onClick={() => void remove()} loading={busy === 'remove'} disabled={busy !== null}>
              <X size={15} aria-hidden />
              Remove
            </Button>
          )}
          {onAccentChange && (
            <label className="inline-flex items-center gap-2 text-meta text-text-secondary">
              Accent
              <input
                type="color"
                className="h-7 w-10 cursor-pointer rounded-[var(--radius-chip)] border-0 bg-transparent p-0"
                aria-label="Accent colour"
                value={accent ?? accentCssColor(0x5c6b7a) ?? ''}
                onChange={(event) => {
                  const next = Number.parseInt(event.target.value.slice(1), 16);
                  if (Number.isInteger(next)) onAccentChange(next);
                }}
              />
              {accent != null && (
                <button type="button" className="text-meta text-text-muted underline-offset-2 hover:underline" onClick={() => onAccentChange(null)}>
                  Clear
                </button>
              )}
            </label>
          )}
        </div>
      )}
      {!loaded && <p className="text-meta text-text-muted">{hint}</p>}
      {error && (
        <p role="alert" className="text-meta text-accent-danger">{error}</p>
      )}
    </section>
  );
}

function positionedImage(image: LoadedImage, frame: { width: number; height: number }, view: CropView) {
  const scale = coverScale(image.width, image.height, frame.width, frame.height) * view.zoom;
  const width = image.width * scale;
  const height = image.height * scale;
  return {
    width,
    height,
    left: frame.width / 2 - width / 2 + view.panX,
    top: frame.height / 2 - height / 2 + view.panY,
    touchAction: 'none' as const,
  };
}

async function renderBanner(
  image: LoadedImage,
  frame: { width: number; height: number },
  view: CropView,
  outputWidth: number,
  outputHeight: number,
): Promise<File> {
  const bitmap = await createImageBitmap(image.file);
  try {
    const rect = sourceRect(bitmap.width, bitmap.height, frame.width, frame.height, view);
    const canvas = document.createElement('canvas');
    canvas.width = outputWidth;
    canvas.height = outputHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not prepare the banner image.');
    context.drawImage(bitmap, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, outputWidth, outputHeight);
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', 0.92);
    });
    if (!blob) throw new Error('Could not prepare the banner image.');
    return new File([blob], 'banner.jpg', { type: 'image/jpeg' });
  } finally {
    bitmap.close();
  }
}
