import { useMemo, type ReactNode } from 'react';
import { BarChart3, Megaphone, MessagesSquare, Paperclip, Pin, Rss } from 'lucide-react';

import { Face } from '../../glass/places/Lead';
import { ResourceImage } from '../../ui/ResourceImage';
import { fileApi } from '../../../api/files';
import type { FeedReason, FeedUser } from '../../../api/serverFeed';
import { useDownloadTicket } from '../../../hooks/useDownloadTicket';
import { resolveResourceUrl } from '../../../lib/config/apiBaseUrl';
import { displayName } from '../../../lib/displayName';
import { isAllowedImageMimeType, safeClientResourceUrl } from '../../../lib/security';
import { cn } from '../../../lib/utils';
import { createDeferredLightboxImage, useLightboxStore } from '../../../stores/lightboxStore';
import type { Attachment } from '../../../types';

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp)$/i;

/** The same test the timeline applies before it draws an image inline. */
export function isImageAttachment(attachment: Pick<Attachment, 'content_type' | 'filename'>): boolean {
  const type = (attachment.content_type || '').toLowerCase();
  if (type.startsWith('image/')) return isAllowedImageMimeType(type);
  return IMAGE_EXTENSION.test(attachment.filename || '');
}

/** A person on a feed card: their face, or a plain disc while nobody is known. */
export function FeedAvatar({ user, size = 36 }: { user: FeedUser | null; size?: number }) {
  if (!user) return <span className="shrink-0 rounded-full bg-[var(--glass-fill-quiet)]" style={{ width: size, height: size }} />;
  return (
    <Face
      face={{ userId: user.id, name: displayName(user), avatar: user.avatar_hash ?? null }}
      size={size}
      className="shrink-0"
    />
  );
}

const REASON: Record<FeedReason, { label: string; icon: ReactNode } | null> = {
  announcement: { label: 'Announcement', icon: <Megaphone size={12} aria-hidden /> },
  pinned: { label: 'Pinned', icon: <Pin size={12} aria-hidden /> },
  poll: { label: 'Poll', icon: <BarChart3 size={12} aria-hidden /> },
  thread_starter: { label: 'Thread', icon: <MessagesSquare size={12} aria-hidden /> },
  reactions: null,
  attachment: null,
  feed: { label: 'Feed', icon: <Rss size={12} aria-hidden /> },
};

/**
 * Why a message is on the page, when that is worth saying. Pictures and
 * reactions say it themselves.
 */
export function ReasonTag({ reason }: { reason: FeedReason }) {
  const entry = REASON[reason];
  if (!entry) return null;
  return (
    <span className="glass-post__tag inline-flex shrink-0 items-center gap-1">
      {entry.icon}
      {entry.label}
    </span>
  );
}

/**
 * The line at the top of a post: who, where it was posted and when. Where is the
 * way in: pressing it opens the channel at that message. No `#`, ever.
 */
export function FeedCardHeader({
  lead,
  name,
  channelName,
  forum = false,
  when,
  onOpen,
  aside,
}: {
  lead: ReactNode;
  name: string;
  channelName: string;
  forum?: boolean;
  when: string;
  onOpen: () => void;
  aside?: ReactNode;
}) {
  return (
    <div className="glass-post__head">
      {lead}
      <div className="glass-post__who">
        <span className="glass-post__name">{name}</span>
        <button
          type="button"
          onClick={onOpen}
          className="glass-post__where glass-focusable"
          aria-label={`Open in ${channelName}`}
        >
          {forum ? <MessagesSquare size={13} aria-hidden className="shrink-0" /> : null}
          <span>{channelName}</span>
          {when && (
            <>
              <span aria-hidden>·</span>
              <span className="glass-instrument shrink-0 text-[var(--ink-3)]">{when}</span>
            </>
          )}
        </button>
      </div>
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
      className={cn('glass-photo glass-focusable', className)}
      aria-label={caption ? `${attachment.filename || 'Image'}, ${caption}` : attachment.filename || 'Image'}
    >
      {src && <ResourceImage src={src} alt="" draggable={false} loading="lazy" />}
      {overlay}
      {caption && <span className="glass-photo__caption truncate">{caption}</span>}
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
    <div className="glass-photogrid">
      {shown.map((image, index) => (
        <Photo
          key={image.id}
          attachment={image}
          onOpen={() => openImagesInLightbox(images, index)}
          className={cn('aspect-[4/3] w-full', shown.length === 3 && index === 0 && 'col-span-2 aspect-[16/7]')}
          overlay={
            hidden > 0 && index === shown.length - 1 ? (
              <span className="glass-photo__more glass-instrument">+{hidden}</span>
            ) : null
          }
        />
      ))}
    </div>
  );
}

/** Files that are not pictures: named, and a way to the message. */
export function FileChips({ files, onOpen }: { files: readonly Attachment[]; onOpen: () => void }) {
  if (files.length === 0) return null;
  return (
    <div className="glass-files">
      {files.map((file) => (
        <button
          key={file.id}
          type="button"
          onClick={onOpen}
          aria-label={`${file.filename}. Open the message`}
          className="glass-file glass-focusable"
        >
          <Paperclip size={14} aria-hidden className="shrink-0" />
          <span className="truncate">{file.filename}</span>
        </button>
      ))}
    </div>
  );
}
