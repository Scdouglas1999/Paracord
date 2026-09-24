import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { Download, FileWarning, Film, History, Link2 } from 'lucide-react';

import { extractApiError } from '../../api/client';
import { useCurrentMessageStoreApi } from '../../hooks/useMessageStore';
import { formatFileSize, relativeTime } from '../../lib/formatters';
import { decryptAttachmentBlob, decryptAttachmentThumbnail } from '../../lib/messages/attachments/attachmentDecryption';
import { safeExternalUrl } from '../../lib/security';
import { createDeferredLightboxImage, useLightboxStore } from '../../stores/lightboxStore';
import { toast } from '../../stores/toastStore';
import type { Message } from '../../types';
import { Button, IconButton, Tabs } from '../ui';
import { collectDeviceMedia, mergeDeviceHistory, oldestMessageId, type DeviceAttachment, type DeviceLink } from './deviceMedia';
import { authorLabel, groupByMonth } from './groupMedia';
import { fileIcon, shortWhen, useSeen } from './mediaParts';

type GalleryTab = 'media' | 'files' | 'links';

const EMPTY: Message[] = [];

/** Resolves a decrypted blob to an object URL once per panel. */
type DecryptedUrl = (key: string, decrypt: () => Promise<Blob | null>) => Promise<string | null>;

/**
 * Object URLs over decrypted bytes, shared by every tile in the panel and all
 * revoked when the panel closes, so no decrypted copy outlives the view.
 */
function useDecryptedUrls(): DecryptedUrl {
  const cache = useRef(new Map<string, Promise<string | null>>());
  const created = useRef(new Set<string>());
  const closed = useRef(false);
  useEffect(() => {
    closed.current = false;
    const urls = created.current;
    const entries = cache.current;
    return () => {
      closed.current = true;
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
      entries.clear();
    };
  }, []);
  return useCallback((key, decrypt) => {
    const cached = cache.current.get(key);
    if (cached) return cached;
    const pending = decrypt().then((blob) => {
      if (!blob) return null;
      const url = URL.createObjectURL(blob);
      if (closed.current) {
        URL.revokeObjectURL(url);
        return null;
      }
      created.current.add(url);
      return url;
    });
    cache.current.set(key, pending);
    // A failure is not remembered: the next time the tile is shown tries again.
    pending.catch(() => cache.current.delete(key));
    return pending;
  }, []);
}

/**
 * Media, files and links in a direct message, gathered from the messages this
 * device has decrypted. Nothing is asked of the instance beyond the history
 * pages and encrypted file bodies the conversation itself already fetches.
 */
export function DeviceMediaGallery({ channelId }: { channelId: string }) {
  const storeApi = useCurrentMessageStoreApi();
  const loaded = useStore(storeApi, (state) => state.messages[channelId] ?? EMPTY);
  const storeHasMore = useStore(storeApi, (state) => state.hasMore[channelId]);
  const deleted = useStore(storeApi, (state) => state.deletedMessageIds);
  const decrypting = useStore(storeApi, (state) => state.decryptingIds);
  const [tab, setTab] = useState<GalleryTab>('media');
  const [older, setOlder] = useState<Message[]>([]);
  const [olderHasMore, setOlderHasMore] = useState<boolean | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const decryptedUrl = useDecryptedUrls();

  const collected = useMemo(
    () => collectDeviceMedia(mergeDeviceHistory(loaded, older, { deleted, decrypting })),
    [loaded, older, deleted, decrypting],
  );
  const hasMore = olderHasMore ?? storeHasMore ?? true;

  const loadOlder = async () => {
    const before = oldestMessageId(loaded, older);
    if (!before || loadingOlder) return;
    setLoadingOlder(true);
    setError(null);
    try {
      const page = await storeApi.getState().readHistoryPage(channelId, before);
      if (!mounted.current) return;
      setOlder((current) => [...page.messages, ...current]);
      setOlderHasMore(page.hasMore);
    } catch (err) {
      if (mounted.current) setError(extractApiError(err));
    } finally {
      if (mounted.current) setLoadingOlder(false);
    }
  };

  const count = tab === 'media' ? collected.media.length : tab === 'files' ? collected.files.length : collected.links.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-3 px-3 pt-3">
        <Tabs
          label="Media views"
          variant="underline"
          fill
          value={tab}
          onChange={setTab}
          items={[
            { value: 'media', label: 'Media' },
            { value: 'files', label: 'Files' },
            { value: 'links', label: 'Links' },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-2">
        {count === 0 ? (
          <p className="px-1 py-4 text-body text-text-secondary">{emptyCopy(tab, hasMore)}</p>
        ) : tab === 'media' ? (
          <DeviceMediaGrid items={collected.media} decryptedUrl={decryptedUrl} />
        ) : tab === 'files' ? (
          <DeviceFileRows items={collected.files} />
        ) : (
          <DeviceLinkRows items={collected.links} />
        )}
        <div className="mt-3 flex flex-col items-start gap-2 border-t border-border-subtle px-1 pt-3">
          <p className="text-meta text-text-muted">Showing what’s on this device.</p>
          {error && <p role="alert" className="text-meta text-accent-danger">Could not load older messages: {error}</p>}
          {hasMore && (
            <Button variant="ghost" size="sm" className="-ml-2.5" loading={loadingOlder} onClick={() => void loadOlder()}>
              {!loadingOlder && <History size={14} aria-hidden />}
              Load older
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function emptyCopy(tab: GalleryTab, olderToLoad: boolean): string {
  const what = tab === 'media' ? 'images or videos' : tab === 'files' ? 'files' : 'links';
  return olderToLoad ? `No ${what} in recent messages.` : `No ${what} yet.`;
}

function DeviceMediaGrid({ items, decryptedUrl }: { items: DeviceAttachment[]; decryptedUrl: DecryptedUrl }) {
  const groups = useMemo(() => groupByMonth(items), [items]);
  const open = useLightboxStore((state) => state.open);

  // Each file is decrypted when the viewer reaches it, and the viewer releases
  // it when it moves on, the same as the server channel gallery.
  const openAt = (id: string) => {
    const images = items.map((item) => createDeferredLightboxImage(
      async () => URL.createObjectURL(await decryptAttachmentBlob(item.attachment)),
      item.attachment.encryption.filename,
      item.kind === 'video' ? 'video' : 'image',
    ));
    const index = items.findIndex((item) => item.id === id);
    open(images, index < 0 ? 0 : index);
  };

  return (
    <div className="flex flex-col gap-5">
      {groups.map((group) => (
        <section key={group.label} aria-label={group.label}>
          <h3 className="mb-2 px-1 text-label font-semibold text-text-secondary">{group.label}</h3>
          <ul className="grid grid-cols-3 gap-1.5">
            {group.items.map((item) => (
              <li key={item.id}>
                <DeviceMediaTile item={item} decryptedUrl={decryptedUrl} onOpen={() => openAt(item.id)} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function DeviceMediaTile({ item, decryptedUrl, onOpen }: {
  item: DeviceAttachment;
  decryptedUrl: DecryptedUrl;
  onOpen: () => void;
}) {
  const [ref, seen] = useSeen<HTMLButtonElement>();
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const attachment = item.attachment;
  const descriptor = attachment.encryption;
  // The sender's inline preview needs no download. An image without one is
  // decrypted whole, as it is in the conversation; a video without one is not
  // fetched until it is opened.
  const hasPreview = Boolean(descriptor.thumbnail) || item.kind === 'image';

  useEffect(() => {
    if (!seen || !hasPreview) return;
    let active = true;
    const decrypt = descriptor.thumbnail
      ? () => decryptAttachmentThumbnail(attachment)
      : () => decryptAttachmentBlob(attachment);
    decryptedUrl(`tile:${attachment.id}`, decrypt).then(
      (url) => { if (active) setSrc(url); },
      () => { if (active) setFailed(true); },
    );
    return () => { active = false; };
  }, [seen, hasPreview, attachment, descriptor.thumbnail, decryptedUrl]);

  const author = authorLabel(item.author);
  return (
    <button
      ref={ref}
      type="button"
      className="group relative block aspect-square w-full overflow-hidden rounded-[var(--radius-control)] bg-bg-mod-subtle outline-none focus-visible:shadow-[var(--focus-ring)]"
      onClick={onOpen}
      aria-label={`${descriptor.filename}, from ${author}, ${relativeTime(item.created_at)}${failed ? ', preview could not be decrypted' : ''}`}
    >
      {src ? (
        <img
          src={src}
          alt=""
          draggable={false}
          className="h-full w-full object-cover transition-transform duration-[var(--duration-fast)] ease-[var(--ease-out)] motion-safe:group-hover:scale-[1.02]"
        />
      ) : failed ? (
        <FileWarning className="absolute inset-0 m-auto h-5 w-5 text-text-muted" aria-hidden />
      ) : item.kind === 'video' && !hasPreview ? (
        <Film className="absolute inset-0 m-auto h-5 w-5 text-text-muted" aria-hidden />
      ) : null}
      {item.kind === 'video' && hasPreview && (
        <span className="pc-tag pointer-events-none absolute right-1 top-1 inline-flex items-center px-1 py-0.5">
          <Film size={12} aria-hidden />
        </span>
      )}
      <span className="pc-tag pointer-events-none absolute inset-x-1 bottom-1 flex min-w-0 flex-col px-1.5 py-0.5 text-left text-meta leading-tight opacity-0 transition-opacity duration-[var(--duration-fast)] ease-[var(--ease-out)] group-hover:opacity-100 group-focus-visible:opacity-100">
        <span className="truncate font-medium">{author}</span>
        <span className="truncate text-text-secondary">{shortWhen(item.created_at)}</span>
      </span>
    </button>
  );
}

function DeviceFileRows({ items }: { items: DeviceAttachment[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const download = async (item: DeviceAttachment) => {
    const descriptor = item.attachment.encryption;
    setBusy(item.id);
    let url: string | null = null;
    try {
      url = URL.createObjectURL(await decryptAttachmentBlob(item.attachment));
      const link = document.createElement('a');
      link.href = url;
      link.download = descriptor.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (err) {
      toast.error(`Could not download ${descriptor.filename}: ${extractApiError(err)}`);
    } finally {
      // Give the navigation a tick to claim the blob before it is released.
      if (url) setTimeout((released: string) => URL.revokeObjectURL(released), 10_000, url);
      setBusy(null);
    }
  };
  return (
    <ul className="flex flex-col divide-y divide-border-subtle">
      {items.map((item) => {
        const descriptor = item.attachment.encryption;
        const Icon = fileIcon({ content_type: descriptor.contentType, filename: descriptor.filename });
        return (
          <li key={item.id} className="flex items-center gap-3 px-1 py-2.5">
            <span className="pc-well inline-flex h-9 w-9 shrink-0 items-center justify-center p-0 text-text-secondary">
              <Icon size={16} aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-label text-text-primary">{descriptor.filename}</p>
              <p className="truncate text-meta text-text-muted">
                {formatFileSize(descriptor.size)} · {authorLabel(item.author)} · {relativeTime(item.created_at)}
              </p>
            </div>
            <IconButton
              label={busy === item.id ? `Decrypting ${descriptor.filename}` : `Download ${descriptor.filename}`}
              onClick={() => void download(item)}
              disabled={busy === item.id}
            >
              <Download size={15} />
            </IconButton>
          </li>
        );
      })}
    </ul>
  );
}

function DeviceLinkRows({ items }: { items: DeviceLink[] }) {
  return (
    <ul className="flex flex-col divide-y divide-border-subtle">
      {items.map((item) => {
        const href = safeExternalUrl(item.url);
        let site = item.url;
        try {
          site = new URL(item.url).host;
        } catch {
          // Keep the address as written.
        }
        const title = item.url.replace(/^https?:\/\//, '');
        return (
          <li key={item.key} className="flex items-center gap-3 px-1 py-2.5">
            <span className="pc-well inline-flex h-9 w-9 shrink-0 items-center justify-center p-0 text-text-secondary">
              <Link2 size={16} aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              {href ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="block truncate rounded-chip text-label text-text-primary outline-none hover:underline focus-visible:shadow-[var(--focus-ring)]"
                >
                  {title}
                </a>
              ) : (
                <p className="truncate text-label text-text-primary">{title}</p>
              )}
              <p className="truncate text-meta text-text-muted">
                {site} · {authorLabel(item.author)} · {relativeTime(item.created_at)}
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
