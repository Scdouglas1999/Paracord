import * as React from 'react';
import { useEffect, useState } from 'react';

import { fileApi } from '../../../api/files';
import { safeClientResourceUrl } from '../../../lib/security';
import { Well } from '../../ui';
import { cn } from '../../../lib/utils';
import { photosThisWeekCaption, recentlyInCaption } from './lobbyCaptions';
import type { LobbyMediaItem } from './useRecentMedia';

export interface MediaStripProps {
  /** The building whose name the label carries — "Recently in Kestrel Robotics". */
  buildingName: string;
  items: readonly LobbyMediaItem[];
  weekCount: number;
  /** Open the room the image was shared in. */
  onOpen: (item: LobbyMediaItem) => void;
}

/**
 * MediaStrip — what has been passed around lately
 * (docs/lantern-stage-spec.md §7.3: "Recently in the shop").
 *
 * It shows images the reader can already see, from rooms this client has open —
 * see `useRecentMedia.ts` for exactly which, and which it refuses. The whole
 * section is omitted when there is nothing; there is no empty tile row and no
 * "no media yet" copy (§7.3, §6.9).
 */
export const MediaStrip = React.forwardRef<HTMLElement, MediaStripProps>(function MediaStrip(
  { buildingName, items, weekCount, onOpen },
  ref,
) {
  const week = photosThisWeekCaption(weekCount);
  return (
    <Well
      ref={ref}
      as="section"
      aria-label={recentlyInCaption(buildingName)}
      bare
      className="flex items-center gap-3.5 rounded-[var(--radius-card)] px-3.5 py-3"
    >
      <span className="shrink-0 truncate text-meta text-text-faint">
        {recentlyInCaption(buildingName)}
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        {items.map((item) => (
          <MediaTile key={item.key} item={item} onOpen={() => onOpen(item)} />
        ))}
      </span>
      {week && <span className="shrink-0 whitespace-nowrap text-meta text-text-faint">{week}</span>}
    </Well>
  );
});

/**
 * One tile. The bytes come back through the same authenticated blob path the
 * message timeline uses (`fileApi.resolveAttachmentObjectUrl`), and the object
 * URL is revoked when the tile goes away — a strip that re-renders on every
 * message must not leak one per frame.
 */
function MediaTile({ item, onOpen }: { item: LobbyMediaItem; onOpen: () => void }) {
  const safeUrl = safeClientResourceUrl(item.attachment.url);
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!safeUrl) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    void fileApi
      .resolveAttachmentObjectUrl(safeUrl)
      .then((resolved) => {
        if (cancelled) {
          if (resolved.startsWith('blob:')) URL.revokeObjectURL(resolved);
          return;
        }
        if (resolved.startsWith('blob:')) objectUrl = resolved;
        setSrc(resolved);
      })
      .catch(() => {
        if (!cancelled) setSrc(null);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [safeUrl]);

  const label = `${item.attachment.filename || 'Image'} — shared by ${item.authorName}`;

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={label}
      className={cn(
        'pc-focusable relative h-10 w-14 shrink-0 overflow-hidden',
        'rounded-[var(--radius-thumb)] bg-bg-raised shadow-[var(--shadow-tile)]',
      )}
    >
      {src && <img src={src} alt="" className="h-full w-full object-cover" draggable={false} />}
    </button>
  );
}
