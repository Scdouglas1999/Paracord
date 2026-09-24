import { useEffect, useState } from 'react';

import { extractApiError } from '../../../../api/client';
import { galleryApi, type GalleryAttachment } from '../../../../api/gallery';
import { displayName } from '../../../../lib/displayName';
import { cn } from '../../../../lib/utils';
import type { Attachment } from '../../../../types';
import { Photo } from '../feedParts';
import { WidgetCard, WidgetError, WidgetLink } from './WidgetCard';

export interface MediaWidgetProps {
  guildId: string;
  onOpenMedia: () => void;
}

/** Six pictures, as a 3×2 mosaic. */
const COUNT = 6;

/**
 * Where one picture sits in a six-column grid, so that fewer than six still
 * fill their rows: one is wide, two are halves, four are a 2×2, five are two
 * halves over three thirds.
 */
function tile(count: number, index: number): string {
  if (count === 1) return 'col-span-6 aspect-[16/9]';
  if (count === 2 || count === 4) return 'col-span-3 aspect-[4/3]';
  if (count === 5 && index < 2) return 'col-span-3 aspect-[4/3]';
  return 'col-span-2 aspect-square';
}

function asAttachment(item: GalleryAttachment): Attachment {
  return {
    id: item.id,
    filename: item.filename,
    content_type: item.content_type ?? undefined,
    size: item.size,
    url: item.url,
    width: item.width ?? undefined,
    height: item.height ?? undefined,
  } as Attachment;
}

/**
 * "Media": the server's six newest pictures, from the same gallery endpoint
 * the Media view pages through. Left out when the server has none.
 */
export function MediaWidget({ guildId, onOpenMedia }: MediaWidgetProps) {
  const [items, setItems] = useState<GalleryAttachment[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let canceled = false;
    setItems(null);
    setError(null);
    galleryApi
      .guildAttachments(guildId, { kind: 'image', limit: COUNT })
      .then(({ data }) => {
        if (!canceled) setItems(data.items);
      })
      .catch((err) => {
        if (!canceled) setError(extractApiError(err));
      });
    return () => {
      canceled = true;
    };
  }, [guildId]);

  if (error) {
    return (
      <WidgetCard title="Media">
        <WidgetError>Could not load pictures: {error}</WidgetError>
      </WidgetCard>
    );
  }
  if (!items || items.length === 0) return null;

  return (
    <WidgetCard title="Media" action={<WidgetLink onClick={onOpenMedia}>All media</WidgetLink>}>
      <div className="grid grid-cols-6 gap-1.5">
        {items.slice(0, COUNT).map((item, index, shown) => (
          <Photo
            key={item.id}
            attachment={asAttachment(item)}
            caption={displayName(item.author)}
            onOpen={onOpenMedia}
            className={cn('w-full rounded-[var(--radius-chip)]', tile(shown.length, index))}
          />
        ))}
      </div>
    </WidgetCard>
  );
}
