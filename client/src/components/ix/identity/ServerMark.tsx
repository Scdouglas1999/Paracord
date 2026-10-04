import type { CSSProperties } from 'react';

import { serverHue } from '../../../lib/identityHue';
import { resolveGuildIconUrl } from '../../../lib/guildIcon';
import { cn } from '../../../lib/utils';
import { monogramFontSize, monogramOf } from './monogram';
import { useMarkImage } from './useMarkImage';

export interface ServerMarkProps {
  /** The server's snowflake: its default hue comes from it. */
  guildId: string;
  /** The server name. Its first letter is the monogram when there is no icon. */
  name: string;
  /** The stored icon value (`icon_hash`, or `icon` on an older payload). An uploaded icon always wins. */
  icon?: string | null;
  /** The server's own hue (`guild.hue`, 0-359) when an admin set one; null or absent uses the id's. */
  hue?: number | null;
  /** Side in px. Default 34 (the dock). Sizes in use: 24, 32, 34, 38, 40, 76, 88. */
  size?: number;
  /** Corner radius when it must not be 28% of the side (the welcome mark is 22px at 76). */
  radius?: number | string;
  /** Font size in px when it must not be 44% of the side (the welcome mark is 34 at 76). */
  fontSize?: number;
  /** An accessible name. Without one the mark is decorative, the right default beside the server's name. */
  label?: string;
  className?: string;
  style?: CSSProperties;
}

/**
 * A server: a flat tonal rounded square (docs/index-spec.md §2.3), 28% radius.
 * The server's hue on a quiet diagonal, a lighter same-hue condensed letter, a
 * hairline; no glow, never floating. An uploaded icon is clipped to the same
 * square with the same hairline and always wins.
 *
 * Styles are `.ix-sq` in styles/ix-base.css.
 */
export function ServerMark({ guildId, name, icon, hue, size = 34, radius, fontSize, label, className, style }: ServerMarkProps) {
  const { src, onError } = useMarkImage(resolveGuildIconUrl({ icon: icon ?? null }));
  return (
    <span
      className={cn('ix-sq', src && 'ix-has-img', className)}
      style={
        {
          '--ix-h': serverHue({ id: guildId, hue }),
          width: size,
          height: size,
          fontSize: fontSize ?? monogramFontSize(size, 'server'),
          ...(radius !== undefined ? { borderRadius: radius } : null),
          ...style,
        } as CSSProperties
      }
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-server-mark=""
    >
      {src ? <img src={src} alt="" draggable={false} onError={onError} /> : monogramOf(name)}
    </span>
  );
}
