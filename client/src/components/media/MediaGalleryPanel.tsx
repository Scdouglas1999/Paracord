import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, RefObject } from 'react';
import {
  Download,
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileText,
  Film,
  Image as ImageIcon,
  Link2,
  X,
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
import { IconButton, Select, Tabs } from '../ui';
import { ResourceImage } from '../ui/ResourceImage';
import { authorLabel, groupByMonth } from './groupMedia';

type GalleryTab = 'media' | 'files' | 'links';

const PAGE = 50;

interface MediaGalleryPanelProps {
  guildId?: string | null;
  channelId?: string | null;
  onClose: () => void;
  panelRef?: RefObject<HTMLElement | null>;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
}

/**
 * Media, files and links posted in a channel, or across a server when opened
 * from the server home. Direct messages are end-to-end encrypted, so their
 * attachments are never listed by the server and the panel says so.
 */
export function MediaGalleryPanel({ guildId, channelId, onClose, panelRef, onKeyDown }: MediaGalleryPanelProps) {
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
  const subtitle = scope?.kind === 'channel'
    ? `#${channel?.name ?? 'channel'}`
    : scope?.kind === 'guild'
      ? 'Every channel you can read'
      : null;

  return (
    <aside
      ref={panelRef}
      aria-label="Media"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      data-testid="context-panel"
      data-mode="media"
      className="pc-plate flex h-full min-h-0 w-full flex-col overflow-hidden outline-none md:my-[var(--gutter)] md:mr-[var(--gutter)] md:h-[calc(100%-var(--gutter)*2)] md:w-[var(--w-context-panel)] md:shrink-0"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-4 py-3">
        <ImageIcon size={18} className="shrink-0 text-text-secondary" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-label font-semibold text-text-primary">Media</h2>
          {subtitle && <p className="truncate text-meta text-text-muted">{subtitle}</p>}
        </div>
        <IconButton label="Close media" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </header>
      {!scope ? (
        <p className="px-4 py-6 text-body text-text-secondary">
          Direct messages are end-to-end encrypted, so their files are not listed here.
        </p>
      ) : (
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
            {scope.kind === 'guild' && (
              <Select
                aria-label="Channel"
                className="w-full"
                value={channelFilter}
                onChange={(event) => setChannelFilter(event.target.value)}
              >
                <option value="">{tab === 'links' ? 'Pick a channel' : 'All channels'}</option>
                {textChannels.map((item) => (
                  <option key={item.id} value={item.id}>#{item.name || 'channel'}</option>
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
    </aside>
  );
}

function PlainLine({ children, tone = 'plain' }: { children: React.ReactNode; tone?: 'plain' | 'error' }) {
  return (
    <p
      role={tone === 'error' ? 'alert' : undefined}
      className={tone === 'error'
        ? 'px-4 py-6 text-body text-accent-danger'
        : 'px-4 py-6 text-body text-text-secondary'}
    >
      {children}
    </p>
  );
}

/** "Sep 22": fits under a thumbnail where "less than a minute ago" does not. */
function shortWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric' });
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

/** True once the element has come within a screen of the scroll viewport. */
function useSeen<T extends Element>(): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || seen) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
    }, { rootMargin: '300px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [seen]);
  return [ref, seen];
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
    <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-2">
      {tab === 'media' ? <MediaGrid items={items} /> : <FileRows items={items} />}
      {error && <p role="alert" className="px-1 py-2 text-meta text-accent-danger">Could not load more: {error}</p>}
      {hasMore && <div ref={sentinel} className="h-6" />}
      {loading && <p className="px-1 py-2 text-meta text-text-muted">Loading…</p>}
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
    <div className="flex flex-col gap-5">
      {groups.map((group) => (
        <section key={group.label} aria-label={group.label}>
          <h3 className="mb-2 px-1 text-label font-semibold text-text-secondary">{group.label}</h3>
          <ul className="grid grid-cols-3 gap-1.5">
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
      className="group relative block aspect-square w-full overflow-hidden rounded-[var(--radius-control)] bg-bg-mod-subtle outline-none focus-visible:shadow-[var(--focus-ring)]"
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
          className="h-full w-full object-cover transition-transform duration-[var(--duration-fast)] ease-[var(--ease-out)] motion-safe:group-hover:scale-[1.02]"
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
      className="h-full w-full object-cover transition-transform duration-[var(--duration-fast)] ease-[var(--ease-out)] motion-safe:group-hover:scale-[1.02]"
    />
  );
}

function fileIcon(item: GalleryAttachment) {
  const type = (item.content_type ?? '').toLowerCase();
  const name = item.filename.toLowerCase();
  if (type.startsWith('audio/')) return FileAudio;
  if (type.includes('zip') || type.includes('compressed') || /\.(zip|tar|gz|7z|rar)$/.test(name)) return FileArchive;
  if (type.startsWith('text/') || type === 'application/pdf' || /\.(pdf|txt|md|docx?|rtf)$/.test(name)) return FileText;
  return FileIcon;
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
    <ul className="flex flex-col divide-y divide-border-subtle">
      {items.map((item) => {
        const Icon = fileIcon(item);
        return (
          <li key={item.id} className="flex items-center gap-3 px-1 py-2.5">
            <span className="pc-well inline-flex h-9 w-9 shrink-0 items-center justify-center p-0 text-text-secondary">
              <Icon size={16} aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-label text-text-primary">{item.filename}</p>
              <p className="truncate text-meta text-text-muted">
                {formatFileSize(item.size)} · {authorLabel(item.author)} · {relativeTime(item.created_at)}
              </p>
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
    <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-2">
      <ul className="flex flex-col divide-y divide-border-subtle">
        {items.map((item, index) => (
          <LinkRow key={`${item.message_id}-${index}`} item={item} showImage={!lowBandwidthMode} />
        ))}
      </ul>
      {error && <p role="alert" className="px-1 py-2 text-meta text-accent-danger">Could not load more: {error}</p>}
      {hasMore && <div ref={sentinel} className="h-6" />}
      {loading && <p className="px-1 py-2 text-meta text-text-muted">Loading…</p>}
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
    <li className="flex items-center gap-3 px-1 py-2.5">
      <span className="pc-well inline-flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden p-0 text-text-secondary">
        {image ? (
          <img src={image} alt="" loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <Link2 size={16} aria-hidden />
        )}
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
}
