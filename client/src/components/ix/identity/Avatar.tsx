import type { CSSProperties } from 'react';

import { useDownloadTicket } from '../../../hooks/useDownloadTicket';
import { isHue, paletteHue } from '../../../lib/identityHue';
import type { PresenceStatus } from '../../../lib/presence';
import { resolveUserAvatarUrl } from '../../../lib/userAvatar';
import { cn } from '../../../lib/utils';
import { monogramFontSize, monogramOf } from './monogram';
import { PresenceDot, presenceKind } from './PresenceDot';
import { useMarkImage } from './useMarkImage';

export interface AvatarProps {
  /** The person's snowflake. It picks the hue (`paletteHue`), so a person keeps one hue everywhere. */
  userId: string;
  /** The display name. Its first letter is the monogram when there is no picture. */
  name: string;
  /**
   * The stored avatar value (`avatar_hash`: a data URL or `/api/v1/users/{id}/avatar`).
   * An uploaded picture always wins over the monogram.
   */
  avatar?: string | null;
  /** Diameter in px. Default 32. Sizes in use: 24, 30, 32, 34, 38, 40, 76, 88. */
  size?: number;
  /** Override the hue (0-359), for a place that is not a person's own (a call tile on People's hue). */
  hue?: number;
  /** Draws the presence dot (online, idle, dnd; offline and invisible draw none). */
  presence?: PresenceStatus | null;
  /**
   * The surface behind the avatar as a CSS value (`var(--ix-main)`), used for the
   * presence dot's 2.5px ring. Defaults to an ancestor's `--ix-ring`, else the sidebar's foot.
   */
  ring?: string;
  /**
   * An accessible name. Without one the avatar is decorative (`aria-hidden`),
   * the right default beside the person's name.
   */
  label?: string;
  className?: string;
  style?: CSSProperties;
}

/**
 * A person: a flat tonal circle (docs/index-spec.md §2.3). The person's hue
 * muted into a vertical gradient, a lighter same-hue letter, a hairline; no
 * glow, no radial highlight. An uploaded picture is clipped to the same circle,
 * with the same hairline, and always wins.
 *
 * Styles are `.ix-av` in styles/ix-base.css; the component sets the hue
 * (`--ix-h`), the size and the letter's font size.
 */
export function Avatar({ userId, name, avatar, size = 32, hue, presence, ring, label, className, style }: AvatarProps) {
  // The avatar URL carries the server's download ticket, minted after first paint.
  useDownloadTicket();
  const { src, onError } = useMarkImage(resolveUserAvatarUrl(avatar ?? null));
  const dot = presenceKind(presence) !== null;
  return (
    <span
      className={cn('ix-av', src && 'ix-has-img', dot && 'ix-has-dot', className)}
      style={
        {
          '--ix-h': isHue(hue) ? hue : paletteHue(userId),
          width: size,
          height: size,
          fontSize: monogramFontSize(size, 'person'),
          ...style,
        } as CSSProperties
      }
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-avatar=""
    >
      {src ? <img src={src} alt="" draggable={false} onError={onError} /> : monogramOf(name)}
      {dot && <PresenceDot status={presence} ring={ring} size={size < 30 ? 8 : undefined} />}
    </span>
  );
}
