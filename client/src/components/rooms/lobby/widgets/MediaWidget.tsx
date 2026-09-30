import { useEffect, useState } from 'react';

import { extractApiError } from '../../../../api/client';
import { galleryApi, type GalleryAttachment } from '../../../../api/gallery';
import { displayName } from '../../../../lib/displayName';
import type { Attachment } from '../../../../types';
import { Photo } from '../feedParts';
import { WidgetCard, WidgetError, WidgetLink } from './WidgetCard';

export interface MediaWidgetProps {
  guildId: string;
  onOpenMedia: () => void;
}

/** Six pictures, in a row. */
const COUNT = 6;

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
    <WidgetCard title="Media" bare action={<WidgetLink onClick={onOpenMedia}>All media</WidgetLink>}>
      {/* One row of squares: the latest few, as wide as the column. */}
      <div className="glass-mosaic" style={{ '--n': Math.min(items.length, COUNT) } as React.CSSProperties}>
        {items.slice(0, COUNT).map((item) => (
          <Photo
            key={item.id}
            attachment={asAttachment(item)}
            caption={displayName(item.author)}
            onOpen={onOpenMedia}
            className="aspect-square w-full"
          />
        ))}
      </div>
    </WidgetCard>
  );
}
