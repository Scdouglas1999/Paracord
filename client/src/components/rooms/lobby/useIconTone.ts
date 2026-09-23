import { useEffect, useState } from 'react';

import { useAuthenticatedImage } from '../../../lib/authenticatedImage';
import { identityTone, toneFromPixels, type CoverTone } from './serverCoverModel';

/** Pixels sampled per side; the colour of a logo survives being this small. */
const SAMPLE = 24;

/** One read per icon per session: the same icon is the same colour. */
const toneCache = new Map<string, CoverTone | null>();

function readTone(src: string): Promise<CoverTone | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = SAMPLE;
      canvas.height = SAMPLE;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) {
        resolve(null);
        return;
      }
      context.drawImage(image, 0, 0, SAMPLE, SAMPLE);
      try {
        resolve(toneFromPixels(context.getImageData(0, 0, SAMPLE, SAMPLE).data));
      } catch {
        // A tainted canvas (an icon served without CORS) cannot be read.
        resolve(null);
      }
    };
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

/**
 * The colour a server's cover is made of.
 *
 * With an icon: the icon's own colour, read from its pixels. With no icon, or
 * an icon that is grey all the way through: the server's identity colour —
 * which is exactly what its mark shows in that case, so the cover and the mark
 * always agree. `null` only while an icon is still being read, so the cover
 * never paints one colour and then changes to another.
 */
export function useIconTone(guildId: string, iconSrc: string | null): CoverTone | null {
  const resolved = useAuthenticatedImage(iconSrc);
  const cached = resolved != null ? toneCache.get(resolved) : undefined;
  const [tone, setTone] = useState<{ src: string; tone: CoverTone | null } | null>(null);

  useEffect(() => {
    if (!resolved || toneCache.has(resolved)) return;
    let cancelled = false;
    void readTone(resolved).then((read) => {
      toneCache.set(resolved, read);
      if (!cancelled) setTone({ src: resolved, tone: read });
    });
    return () => {
      cancelled = true;
    };
  }, [resolved]);

  if (!iconSrc) return identityTone(guildId);
  if (!resolved) return null;
  if (cached !== undefined) return cached ?? identityTone(guildId);
  if (tone && tone.src === resolved) return tone.tone ?? identityTone(guildId);
  return null;
}
