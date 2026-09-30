import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, RefObject } from 'react';
import {
  Download,
  Film,
  Link2,
} from 'lucide-react';

import { galleryApi, type GalleryAttachment, type GalleryLink, type GalleryPage } from '../../api/gallery';
import { extractApiError } from '../../api/client';
import { fileApi } from '../../api/files';
import { useCurrentChannelStore } from '../../hooks/useChannels';
import { useDownloadTicket } from '../../hooks/useDownloadTicket';
import { useAuthenticatedImage } from '../../lib/authenticatedImage';
import { resolveResourceUrl } from '../../lib/config/apiBaseUrl';
import { formatFileSize, relativeTime } from '../../lib/formatters';
import { safeClientResourceUrl, safeExternalUrl } from '../../lib/security';
import { ChannelType } from '../../types';
import { createDeferredLightboxImage, useLightboxStore } from '../../stores/lightboxStore';
import { useUIStore } from '../../stores/uiStore';
import { toast } from '../../stores/toastStore';
import { IconButton, Select } from '../ui';
import { ResourceImage } from '../ui/ResourceImage';
import { authorLabel, groupByMonth } from './groupMedia';
import { DeviceMediaGallery } from './DeviceMediaGallery';
import { fileIcon, PlainLine, shortWhen, useSeen } from './mediaParts';

type GalleryTab = 'media' | 'files' | 'links';

const PAGE = 50;

interface MediaGalleryPanelProps {
  guildId?: string | null;
  channelId?: string | null;
  /** Kept for the legacy panel host; the sheet's frame owns closing now. */
  onClose?: () => void;
  panelRef?: RefObject<HTMLElement | null>;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
}

/**
 * Media, files and links posted in a channel, or across a server when opened
 * from the server home. Direct messages are end-to-end encrypted, so the
 * server cannot list their attachments; for those the page shows what this
 * device has decrypted (see DeviceMediaGallery).
 *
 * The media page of the channel sheet: the frame supplies the title and the
 * close button, this is the body. Solid tiles at 16 radius, no outlines.
 */
export function MediaGalleryPanel({ guildId, channelId, panelRef, onKeyDown }: MediaGalleryPanelProps) {
  const channelsById = useCurrentChannelStore((state) => state.channelsById);
  const channelsByGuild = useCurrentChannelStore((state) => state.channelsByGuild);
  const channel = channelId ? channelsById[channelId] : undefined;
  const channelType = channel?.type ?? channel?.channel_type;
  const isDm = channelType === ChannelType.DM || channelType === ChannelType.GroupDM;
  const [tab, setTab] = useState<GalleryTab>('media');
  const [channelFilter, setChannelFilter] = useState('');
  const scope = channelId && !isDm
    ? { kind: 'channel' as const, id: channelId }
    : guildId && !channelId
      ? { kind: 'guild' as const, id: guildId }
      : null;
  const textChannels = useMemo(() => {
    if (!guildId) return [];
    return (channelsByGuild[guildId] ?? []).filter((item) => {
      const type = item.type ?? item.channel_type;
      return type === ChannelType.Text || type === ChannelType.Announcement;
    });
  }, [channelsByGuild, guildId]);

  return (
    <div
      ref={panelRef as RefObject<HTMLDivElement | null> | undefined}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      data-testid="media-page"
      data-mode="media"
      className="glass-media flex w-full min-w-0 flex-col outline-none"
    >
      {isDm && channelId ? (
        // End-to-end encrypted: the instance cannot list these files, so the
        // page is built from what this device has decrypted.
        <DeviceMediaGallery key={channelId} channelId={channelId} />
      ) : !scope ? (
        <PlainLine>Choose a channel to see its media.</PlainLine>
      ) : (
        <div className="flex min-w-0 flex-col">
          <div className="glass-media__bar">
            <div className="glass-sheet-tabs" role="tablist" aria-label="Media views">
              {([
                ['media', 'Media'],
                ['files', 'Files'],
                ['links', 'Links'],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={tab === value}
                  className="glass-sheet-tab glass-focusable"
                  onClick={() => setTab(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            {scope.kind === 'guild' && (
              <Select
                aria-label="Channel"
                className="glass-media__select"
                value={channelFilter}
                onChange={(event) => setChannelFilter(event.target.value)}
              >
                <option value="">{tab === 'links' ? 'Pick a channel' : 'All channels'}</option>
                {textChannels.map((item) => (
                  <option key={item.id} value={item.id}>{item.name || 'channel'}</option>
                ))}
              </Select>
            )}
          </div>
          {tab === 'links' ? (
            scope.kind === 'guild' && !channelFilter ? (
              <PlainLine>Links are listed one channel at a time. Pick a channel above.</PlainLine>
            ) : (
              <LinkList key={scope.kind === "channel" ? scope.id : channelFilter} channelId={scope.kind === "channel" ? scope.id : channelFilter} />
            )
          ) : (
            <AttachmentList
              key={`${scope.kind}:${scope.id}:${tab}:${channelFilter}`}
              scope={scope}
              tab={tab}
              channelFilter={scope.kind === 'guild' ? channelFilter : ''}
            />
          )}
        </div>
      )}
    </div>
  );
}

function emptyCopy(tab: GalleryTab, guild: boolean): string {
  const where = guild ? 'this server' : 'this channel';
  if (tab === 'media') return `No images or videos in ${where} yet.`;
  if (tab === 'files') return `No files in ${where} yet.`;
  return `No links in ${where} yet.`;
}

/**
 * Cursor paging for one gallery list: the first page on mount, the next page
 * when the sentinel at the bottom scrolls into view.
 */
function useGalleryPages<T>(fetchPage: (before: string | null) => Promise<GalleryPage<T>>) {
  const [items, setItems] = useState<T[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const sentinel = useRef<HTMLDivElement>(null);

  const load = useCallback(async (before: string | null) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setError(null);
    try {
      const page = await fetchPage(before);
      setItems((prev) => (before ? [...prev, ...page.items] : page.items));
      setNextBefore(page.next_before);
    } catch (err) {
      setError(extractApiError(err));
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [fetchPage]);

  useEffect(() => {
    void load(null);
  }, [load]);

  useEffect(() => {
    const node = sentinel.current;
    if (!node || !nextBefore || loading) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void load(nextBefore);
    }, { rootMargin: '200px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [load, loading, nextBefore]);

  return { items, loading, error, sentinel, hasMore: Boolean(nextBefore) };
}

/** A server path made loadable by `<img>`/`<video>` here: API origin plus the download ticket. */
function useGalleryResource(url: string): string | null {
  const ticket = useDownloadTicket();
  return useMemo(() => {
    const safe = safeClientResourceUrl(url);
    return safe ? safeClientResourceUrl(resolveResourceUrl(safe, ticket)) : null;
  }, [url, ticket]);
}

function AttachmentList({
  scope,
  tab,
  channelFilter,
}: {
  scope: { kind: 'channel' | 'guild'; id: string };
  tab: 'media' | 'files';
  channelFilter: string;
}) {
  const kind = tab === 'media' ? 'image,video' : 'file';
  const fetchPage = useCallback(async (before: string | null) => {
    const query = { kind, before, limit: PAGE, channel_id: channelFilter || null };
    const { data } = scope.kind === 'guild'
      ? await galleryApi.guildAttachments(scope.id, query)
      : await galleryApi.channelAttachments(scope.id, query);
    return data;
  }, [channelFilter, kind, scope.id, scope.kind]);
  const { items, loading, error, sentinel, hasMore } = useGalleryPages(fetchPage);

  if (error && items.length === 0) {
    return <PlainLine tone="error">Could not load {tab === 'media' ? 'media' : 'files'}: {error}</PlainLine>;
  }
  if (!loading && items.length === 0) return <PlainLine>{emptyCopy(tab, scope.kind === 'guild')}</PlainLine>;
  return (
    <div className="min-w-0 pt-2">
      {tab === 'media' ? <MediaGrid items={items} /> : <FileRows items={items} />}
      {error && <p role="alert" className="glass-sheet-alert">Could not load more: {error}</p>}
      {hasMore && <div ref={sentinel} className="h-6" />}
      {loading && <p role="status" className="glass-sheet-line">Loading…</p>}
    </div>
  );
}

function MediaGrid({ items }: { items: GalleryAttachment[] }) {
  const groups = useMemo(() => groupByMonth(items), [items]);
  const open = useLightboxStore((state) => state.open);

  // The whole loaded set steps left and right in the lightbox. Each file is
  // fetched only when the viewer reaches it, not all at once on click.
  const openAt = (id: string) => {
    const images = items.map((item) => createDeferredLightboxImage(
      () => fileApi.resolveResourceObjectUrl(item.url),
      item.filename,
      item.kind === 'video' ? 'video' : 'image',
    ));
    const index = items.findIndex((item) => item.id === id);
    open(images, index < 0 ? 0 : index);
  };

  return (
    <div className="flex flex-col">
      {groups.map((group) => (
        <section key={group.label} aria-label={group.label}>
          <h3 className="glass-kicker glass-sheet-kicker">{group.label}</h3>
          <ul className="glass-media__grid">
            {group.items.map((item) => (
              <li key={item.id}>
                <MediaTile item={item} onOpen={() => openAt(item.id)} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function MediaTile({ item, onOpen }: { item: GalleryAttachment; onOpen: () => void }) {
  const [ref, seen] = useSeen<HTMLButtonElement>();
  const src = useGalleryResource(item.url);
  const author = authorLabel(item.author);
  return (
    <button
      ref={ref}
      type="button"
      className="group relative block aspect-square w-full overflow-hidden rounded-[var(--r-tile)] bg-[var(--bub)] outline-none focus-visible:shadow-[var(--focus-ring)]"
      onClick={onOpen}
      aria-label={`${item.filename}, from ${author}, ${relativeTime(item.created_at)}`}
    >
      {seen && src && (item.kind === 'video' ? (
        <VideoThumb src={src} />
      ) : (
        <ResourceImage
          src={src}
          alt=""
          draggable={false}
          className="h-full w-full object-cover transition-transform duration-[var(--duration-fast)] ease-[var(--ease-out)] group-hover:scale-[1.02]"
        />
      ))}
      {item.kind === 'video' && (
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

/** A muted first-frame preview; on the desktop shell the bytes come over the native bridge. */
function VideoThumb({ src }: { src: string }) {
  const resolved = useAuthenticatedImage(src);
  if (!resolved) return <Film className="m-auto h-5 w-5 text-text-muted" aria-hidden />;
  return (
    <video
      src={resolved}
      muted
      playsInline
      preload="metadata"
      className="h-full w-full object-cover transition-transform duration-[var(--duration-fast)] ease-[var(--ease-out)] group-hover:scale-[1.02]"
    />
  );
}

function FileRows({ items }: { items: GalleryAttachment[] }) {
  const download = async (item: GalleryAttachment) => {
    try {
      const { data } = await fileApi.download(item.id);
      const objectUrl = URL.createObjectURL(data);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = item.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (err) {
      toast.error(`Could not download ${item.filename}: ${extractApiError(err)}`);
    }
  };
  return (
    <ul className="glass-sheet-list">
      {items.map((item) => {
        const Icon = fileIcon(item);
        return (
          <li key={item.id} className="glass-sheet-row">
            <span className="glass-sheet-row__lead" aria-hidden>
              <Icon size={17} />
            </span>
            <div className="glass-sheet-row__text">
              <span className="glass-sheet-row__name">{item.filename}</span>
              <span className="glass-sheet-row__detail">
                <span className="glass-instrument">{formatFileSize(item.size)}</span> · {authorLabel(item.author)} · {relativeTime(item.created_at)}
              </span>
            </div>
            <IconButton label={`Download ${item.filename}`} onClick={() => void download(item)}>
              <Download size={15} />
            </IconButton>
          </li>
        );
      })}
    </ul>
  );
}

function LinkList({ channelId }: { channelId: string }) {
  const fetchPage = useCallback(async (before: string | null) => {
    const { data } = await galleryApi.channelLinks(channelId, { before, limit: PAGE });
    return data;
  }, [channelId]);
  const { items, loading, error, sentinel, hasMore } = useGalleryPages(fetchPage);
  const lowBandwidthMode = useUIStore((state) => state.lowBandwidthMode);

  if (error && items.length === 0) return <PlainLine tone="error">Could not load links: {error}</PlainLine>;
  if (!loading && items.length === 0) return <PlainLine>No links in this channel yet.</PlainLine>;

  return (
    <div className="min-w-0 pt-2">
      <ul className="glass-sheet-list">
        {items.map((item, index) => (
          <LinkRow key={`${item.message_id}-${index}`} item={item} showImage={!lowBandwidthMode} />
        ))}
      </ul>
      {error && <p role="alert" className="glass-sheet-alert">Could not load more: {error}</p>}
      {hasMore && <div ref={sentinel} className="h-6" />}
      {loading && <p role="status" className="glass-sheet-line">Loading…</p>}
    </div>
  );
}

function LinkRow({ item, showImage }: { item: GalleryLink; showImage: boolean }) {
  const href = safeExternalUrl(item.url);
  const image = showImage && item.image ? safeClientResourceUrl(item.image) : null;
  let site = item.site;
  if (!site) {
    try {
      site = new URL(item.url).host;
    } catch {
      site = item.url;
    }
  }
  const title = item.title || item.url.replace(/^https?:\/\//, '');
  return (
    <li className="glass-sheet-row">
      <span className="glass-sheet-row__lead overflow-hidden" aria-hidden={image ? undefined : true}>
        {image ? (
          <img src={image} alt="" loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <Link2 size={17} aria-hidden />
        )}
      </span>
      <div className="glass-sheet-row__text">
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className="glass-sheet-row__name glass-focusable rounded-[6px] hover:underline"
          >
            {title}
          </a>
        ) : (
          <span className="glass-sheet-row__name">{title}</span>
        )}
        <span className="glass-sheet-row__detail">
          {site} · {authorLabel(item.author)} · {relativeTime(item.created_at)}
        </span>
      </div>
    </li>
  );
}
