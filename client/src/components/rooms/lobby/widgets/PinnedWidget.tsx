import { useEffect, useMemo, useState } from 'react';

import { channelApi } from '../../../../api/channels';
import { extractApiError } from '../../../../api/client';
import { displayName } from '../../../../lib/displayName';
import { parseMarkdown } from '../../../../lib/markdown';
import type { Message } from '../../../../types';
import { FeedAvatar } from '../feedParts';
import { WidgetCard, WidgetError, WidgetLink } from './WidgetCard';

export interface PinnedWidgetProps {
  guildId: string;
  /** The server's announcement channels, in sidebar order. */
  announcementChannels: readonly { id: string; name: string }[];
  mentionNames: Map<string, string>;
  onOpenMessage: (channelId: string, messageId: string) => void;
}

/** Only this many announcement channels are asked for their pins. */
const CHANNELS = 3;

function newest(a: Message, b: Message): number {
  // Snowflakes: a longer id is a later one, then compare as text.
  return b.id.length - a.id.length || (b.id > a.id ? 1 : b.id < a.id ? -1 : 0);
}

/**
 * "Pinned": the most recent pinned message across the announcement channels.
 * Left out when none of them has a pin.
 */
export function PinnedWidget({ guildId, announcementChannels, mentionNames, onOpenMessage }: PinnedWidgetProps) {
  const channels = announcementChannels.slice(0, CHANNELS);
  const key = channels.map((channel) => channel.id).join(',');
  const [pin, setPin] = useState<{ message: Message; channelName: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let canceled = false;
    setPin(null);
    setError(null);
    if (!key) return;
    const wanted = key.split(',');
    Promise.all(wanted.map((id) => channelApi.getPins(id).then(({ data }) => ({ id, pins: data }))))
      .then((results) => {
        if (canceled) return;
        const all = results.flatMap((result) =>
          result.pins.filter((message) => !message.e2ee).map((message) => ({ message, channelId: result.id })),
        );
        all.sort((a, b) => newest(a.message, b.message));
        const top = all[0];
        const name = top ? announcementChannels.find((channel) => channel.id === top.channelId)?.name ?? '' : '';
        setPin(top ? { message: top.message, channelName: name } : null);
      })
      .catch((err) => {
        if (!canceled) setError(extractApiError(err));
      });
    return () => {
      canceled = true;
    };
    // `key` is the identity of the channel list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const nodes = useMemo(
    () => (pin?.message.content ? parseMarkdown(pin.message.content, guildId, mentionNames) : []),
    [pin, guildId, mentionNames],
  );

  if (error) {
    return (
      <WidgetCard title="Pinned">
        <WidgetError>Could not load pins: {error}</WidgetError>
      </WidgetCard>
    );
  }
  if (!pin) return null;
  const { message } = pin;

  return (
    <WidgetCard
      title="Pinned"
      action={<WidgetLink onClick={() => onOpenMessage(message.channel_id, message.id)}>Open</WidgetLink>}
    >
      <div className="ix-row">
        <FeedAvatar
          user={{
            id: message.author.id,
            username: message.author.username,
            display_name: message.author.display_name ?? null,
            avatar_hash: message.author.avatar_hash ?? null,
          }}
          size={28}
        />
        <span className="ix-row__body">
          <span className="ix-row__name">{displayName(message.author)}</span>
          <span className="ix-row__line">Pinned in {pin.channelName}</span>
        </span>
      </div>
      {nodes.length > 0 && (
        <div className="ix-wtext ix-clamp" style={{ '--clamp-lines': 5 } as React.CSSProperties}>
          {nodes}
        </div>
      )}
    </WidgetCard>
  );
}
