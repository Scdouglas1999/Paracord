import { useMemo, type ReactNode } from 'react';
import { BarChart3, Hash, Megaphone, MessagesSquare, Paperclip, Pin } from 'lucide-react';

import { LitAvatar } from '../../light';
import { ResourceImage } from '../../ui/ResourceImage';
import { fileApi } from '../../../api/files';
import type { FeedReason, FeedUser } from '../../../api/serverFeed';
import { useCurrentAccountScope } from '../../../hooks/useCurrentUser';
import { useDownloadTicket } from '../../../hooks/useDownloadTicket';
import { personLight } from '../../../lib/attention/personLight';
import type { PersonLight } from '../../../lib/attention/light';
import { resolveResourceUrl } from '../../../lib/config/apiBaseUrl';
import { displayName } from '../../../lib/displayName';
import { isAllowedImageMimeType, safeClientResourceUrl } from '../../../lib/security';
import { cn } from '../../../lib/utils';
import { createDeferredLightboxImage, useLightboxStore } from '../../../stores/lightboxStore';
import { usePresenceStore } from '../../../stores/presenceStore';
import type { Attachment } from '../../../types';

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp)$/i;

/** The same test the timeline applies before it draws an image inline. */
export function isImageAttachment(attachment: Pick<Attachment, 'content_type' | 'filename'>): boolean {
  const type = (attachment.content_type || '').toLowerCase();
  if (type.startsWith('image/')) return isAllowedImageMimeType(type);
  return IMAGE_EXTENSION.test(attachment.filename || '');
}

/** A person on a feed card, lit the way they are lit everywhere else. */
export function useFeedPerson(user: FeedUser | { id: string; username?: string | null; display_name?: string | null; avatar_hash?: string | null } | null): PersonLight | null {
  const scope = useCurrentAccountScope();
  const status = usePresenceStore((state) =>
    user ? state.getPresence(user.id, scope?.serverId)?.status ?? null : null,
  );
  return useMemo(
    () =>
      user
        ? personLight({ userId: user.id, name: displayName(user), status, avatar: user.avatar_hash ?? null })
        : null,
    [user, status],
  );
}

export function FeedAvatar({ user, size = 36 }: { user: FeedUser | null; size?: number }) {
  const person = useFeedPerson(user);
  if (!person) return <span className="shrink-0 rounded-full bg-bg-mod-strong" style={{ width: size, height: size }} />;
  return <LitAvatar person={person} size={size} hideLabel className="shrink-0" />;
}

const REASON: Record<FeedReason, { label: string; icon: ReactNode } | null> = {
  announcement: { label: 'Announcement', icon: <Megaphone size={12} aria-hidden /> },
  pinned: { label: 'Pinned', icon: <Pin size={12} aria-hidden /> },
  poll: { label: 'Poll', icon: <BarChart3 size={12} aria-hidden /> },
  thread_starter: { label: 'Thread', icon: <MessagesSquare size={12} aria-hidden /> },
  reactions: null,
  attachment: null,
};

/**
 * Why a message is on the page, when that is worth saying. Pictures and
 * reactions say it themselves.
 */
export function ReasonTag({ reason }: { reason: FeedReason }) {
  const entry = REASON[reason];
  if (!entry) return null;
  return (
    <span className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-[var(--radius-chip)] bg-bg-mod-subtle px-1.5 py-0.5 text-meta text-text-muted">
      {entry.icon}
      {entry.label}
    </span>
  );
}

/**
 * The line at the top of a card: where it was posted and when. It is the way
 * in — clicking it opens the channel at that message.
 */
export function FeedCardHeader({
  channelName,
  forum = false,
  when,
  onOpen,
  aside,
}: {
  channelName: string;
  forum?: boolean;
  when: string;
  onOpen: () => void;
  aside?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          'pc-focusable pc-home-card-hit -mx-1 inline-flex min-w-0 items-center gap-1 rounded-[var(--radius-chip)] px-1 py-0.5',
          'text-meta text-text-muted transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:text-text-primary',
        )}
        aria-label={`Open in ${channelName}`}
      >
        {forum ? <MessagesSquare size={13} aria-hidden className="shrink-0" /> : <Hash size={13} aria-hidden className="shrink-0" />}
        <span className="truncate font-medium">{channelName}</span>
        {when && (
          <>
            <span aria-hidden className="text-text-faint">·</span>
            <span className="shrink-0 tabular-nums">{when}</span>
          </>
        )}
      </button>
      {aside}
    </div>
  );
}

/** A server path made loadable by `<img>`: API origin plus the download ticket. */
function useResource(url: string | null | undefined): string | null {
  const ticket = useDownloadTicket();
  return useMemo(() => {
    const safe = url ? safeClientResourceUrl(url) : null;
    return safe ? safeClientResourceUrl(resolveResourceUrl(safe, ticket)) : null;
  }, [url, ticket]);
}

export function openImagesInLightbox(images: readonly Attachment[], index: number) {
  const entries = images.map((image) =>
    createDeferredLightboxImage(() => fileApi.resolveResourceObjectUrl(image.url), image.filename || 'Image'),
  );
  useLightboxStore.getState().open(entries, Math.max(0, Math.min(index, entries.length - 1)));
}

export function Photo({
  attachment,
  caption,
  className,
  onOpen,
  overlay,
}: {
  attachment: Attachment;
  caption?: string | null;
  className?: string;
  onOpen: () => void;
  overlay?: ReactNode;
}) {
  const src = useResource(attachment.url);
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn('pc-home-photo pc-focusable-composed rounded-[var(--radius-thumb)]', className)}
      aria-label={caption ? `${attachment.filename || 'Image'}, ${caption}` : attachment.filename || 'Image'}
    >
      {src && <ResourceImage src={src} alt="" draggable={false} loading="lazy" />}
      {overlay}
      {caption && <span className="pc-home-photo-caption truncate text-left text-meta">{caption}</span>}
    </button>
  );
}

/**
 * A message's pictures, in a two-column grid. One picture takes the full
 * width; past four, the last tile says how many more there are. Every tile
 * opens the lightbox on the whole set.
 */
export function PhotoGrid({ images }: { images: readonly Attachment[] }) {
  if (images.length === 0) return null;
  const shown = images.slice(0, 4);
  const hidden = images.length - shown.length;
  if (shown.length === 1) {
    return (
      <Photo
        attachment={shown[0]}
        onOpen={() => openImagesInLightbox(images, 0)}
        className="aspect-[16/9] max-h-[360px] w-full"
      />
    );
  }
  return (
    <div className="grid grid-cols-2 gap-1.5">
      {shown.map((image, index) => (
        <Photo
          key={image.id}
          attachment={image}
          onOpen={() => openImagesInLightbox(images, index)}
          className={cn('aspect-[4/3] w-full', shown.length === 3 && index === 0 && 'col-span-2 aspect-[16/7]')}
          overlay={
            hidden > 0 && index === shown.length - 1 ? (
              <span className="absolute inset-0 flex items-center justify-center bg-[var(--tag-fill)] text-heading text-text-primary">
                +{hidden}
              </span>
            ) : null
          }
        />
      ))}
    </div>
  );
}

/** Files that are not pictures: named, sized, and a way to the message. */
export function FileChips({ files, onOpen }: { files: readonly Attachment[]; onOpen: () => void }) {
  if (files.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {files.map((file) => (
        <button
          key={file.id}
          type="button"
          onClick={onOpen}
          className={cn(
            'pc-focusable inline-flex max-w-full items-center gap-2 rounded-[var(--radius-control)] bg-bg-well px-2.5 py-1.5',
            'text-label text-text-body shadow-[var(--shadow-well)] transition-colors duration-[var(--duration-fast)] hover:text-text-primary',
          )}
        >
          <Paperclip size={14} aria-hidden className="shrink-0 text-text-muted" />
          <span className="truncate">{file.filename}</span>
        </button>
      ))}
    </div>
  );
}
