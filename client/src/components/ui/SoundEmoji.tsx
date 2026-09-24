import { AudioLines } from 'lucide-react';

import { parseCustomEmojiToken } from '../../lib/customEmoji';
import { CustomEmojiImage } from './ResourceImage';

/**
 * A soundboard sound's emoji: a unicode character, a `<a?:name:id>`
 * custom-emoji token rendered through the authenticated image path, or the
 * default sound mark when the sound has none.
 */
export function SoundEmoji({
  emoji,
  guildId,
  size = 20,
  className,
}: {
  emoji: string | null | undefined;
  guildId: string;
  size?: number;
  className?: string;
}) {
  const custom = emoji ? parseCustomEmojiToken(emoji) : null;
  if (custom) {
    return (
      <CustomEmojiImage
        guildId={guildId}
        emojiId={custom.id}
        alt={custom.name}
        className={className}
        style={{ width: size, height: size }}
      />
    );
  }
  if (emoji) {
    return (
      <span
        aria-hidden
        className={className}
        style={{ fontSize: size * 0.9, lineHeight: 1, width: size, height: size, textAlign: 'center' }}
      >
        {emoji}
      </span>
    );
  }
  return <AudioLines size={size * 0.8} className={className} aria-hidden />;
}
