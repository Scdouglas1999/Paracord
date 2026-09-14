import type { ImgHTMLAttributes } from 'react';

import { useAuthenticatedImage } from '../../lib/authenticatedImage';
import { buildGuildEmojiImageUrl } from '../../lib/customEmoji';

export interface ResourceImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  /** The URL the app would otherwise put straight into `src`. */
  src: string | null | undefined;
  /** Rendered while the image is being resolved, or if it cannot be. */
  fallback?: React.ReactNode;
}

/**
 * An `<img>` for a resource the server will not hand out to an anonymous
 * request: an avatar, a custom emoji, a sticker.
 *
 * On the desktop shell the webview cannot fetch these itself — no Authorization
 * header, no cookie (the page origin is `tauri://localhost`), and no trust in a
 * self-hosted server's self-signed certificate. This resolves the bytes through
 * the native bridge and renders the resulting `blob:`. In a browser the URL is
 * used directly, exactly as before.
 *
 * Use this anywhere a hook cannot go — inside a `.map`, inside a render
 * callback — and {@link useAuthenticatedImage} where one can.
 */
export function ResourceImage({ src, fallback = null, alt = '', ...props }: ResourceImageProps) {
  const resolved = useAuthenticatedImage(src);
  if (!resolved) return <>{fallback}</>;
  return <img {...props} src={resolved} alt={alt} />;
}

export interface CustomEmojiImageProps
  extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  guildId: string;
  emojiId: string;
  fallback?: React.ReactNode;
}

/** A guild's custom emoji, fetched the way every authenticated image is. */
export function CustomEmojiImage({ guildId, emojiId, ...props }: CustomEmojiImageProps) {
  return <ResourceImage {...props} src={buildGuildEmojiImageUrl(guildId, emojiId)} />;
}
