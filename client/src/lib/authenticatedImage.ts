import { useEffect, useState, useSyncExternalStore } from 'react';

import { fileApi } from '../api/files';
import { isTauri } from './tauriEnv';

/**
 * One in-flight/settled resolution per resource URL.
 *
 * A single room paints the same avatar dozens of times and the same custom
 * emoji in every reaction chip. Without sharing, each `<img>` would pull the
 * bytes across the bridge for itself.
 */
interface CacheEntry {
  promise: Promise<string>;
  /** The object URL once resolved, so eviction can revoke it. */
  objectUrl: string | null;
  storedAt: number;
}

/**
 * How long a resolved resource is reused.
 *
 * A replaced avatar or banner arrives under a new `?v=` URL, which is a cache
 * miss on its own; this bound is for everything still served at a stable path
 * (an older server's avatar, an attachment) so a changed body eventually
 * reaches the screen.
 */
const RESOURCE_TTL_MS = 5 * 60_000;
const MAX_CACHED_RESOURCES = 400;

const cache = new Map<string, CacheEntry>();

/**
 * Bumped whenever the cache is emptied, so mounted images re-resolve:
 * dropping the cached copy is not enough on its own — every `<img>` already
 * on screen holds the same `src` it held a moment ago and React has no reason
 * to ask again.
 */
let generation = 0;
const generationListeners = new Set<() => void>();

function subscribeGeneration(listener: () => void): () => void {
  generationListeners.add(listener);
  return () => {
    generationListeners.delete(listener);
  };
}

/**
 * Release an object URL — but not this instant.
 *
 * Revoking one an `<img>` is still pointing at paints a broken glyph until the
 * re-render lands. A few seconds is far longer than that takes and still bounds
 * the memory: a blob URL is never collected on its own.
 */
const REVOKE_GRACE_MS = 10_000;

function revoke(entry: CacheEntry): void {
  const objectUrl = entry.objectUrl;
  if (!objectUrl?.startsWith('blob:')) return;
  setTimeout(() => URL.revokeObjectURL(objectUrl), REVOKE_GRACE_MS);
}

function evictStaleAndOverflow(): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.storedAt > RESOURCE_TTL_MS) {
      cache.delete(key);
      revoke(entry);
    }
  }
  while (cache.size > MAX_CACHED_RESOURCES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    const entry = cache.get(oldest.value);
    cache.delete(oldest.value);
    if (entry) revoke(entry);
  }
}

/** Drop every cached resource — on sign-out, or when the active server changes. */
export function clearAuthenticatedImageCache(): void {
  for (const entry of cache.values()) revoke(entry);
  cache.clear();
  generation += 1;
  for (const listener of generationListeners) listener();
}

function resolveResource(url: string): Promise<string> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.storedAt <= RESOURCE_TTL_MS) {
    return hit.promise;
  }
  if (hit) {
    cache.delete(url);
    revoke(hit);
  }

  const entry: CacheEntry = { promise: null as unknown as Promise<string>, objectUrl: null, storedAt: Date.now() };
  entry.promise = fileApi
    .resolveResourceObjectUrl(url)
    .then((resolved) => {
      entry.objectUrl = resolved;
      return resolved;
    })
    .catch((err: unknown) => {
      // A failure must not be cached: the next render should try again, not
      // inherit a rejection from whenever the server was last unreachable.
      if (cache.get(url) === entry) cache.delete(url);
      throw err;
    });
  cache.set(url, entry);
  evictStaleAndOverflow();
  return entry.promise;
}

/**
 * Resolve an authenticated server resource for `<img src>`.
 *
 * Pass the URL the app would put in `src` — an avatar, a custom emoji, a
 * sticker. `data:` and `blob:` values are already loadable and come straight
 * back; anything else is resolved through {@link fileApi.resolveResourceObjectUrl},
 * which on the desktop shell fetches it over the native bridge (the only path
 * that can carry the credential and honor the server's pinned certificate).
 *
 * Returns null while a desktop resolution is in flight, or if it failed — the
 * caller should draw whatever it draws for "no image", not a broken glyph.
 */
export function useAuthenticatedImage(src: string | null | undefined): string | null {
  const immediate = !src || src.startsWith('data:') || src.startsWith('blob:') || !isTauri();
  const [resolved, setResolved] = useState<string | null>(immediate ? (src ?? null) : null);
  const cacheGeneration = useSyncExternalStore(
    subscribeGeneration,
    () => generation,
    () => 0,
  );

  useEffect(() => {
    if (immediate) {
      setResolved(src ?? null);
      return;
    }
    let canceled = false;
    setResolved(null);
    void resolveResource(src as string).then(
      (objectUrl) => {
        if (!canceled) setResolved(objectUrl);
      },
      () => {
        if (!canceled) setResolved(null);
      },
    );
    return () => {
      canceled = true;
    };
  }, [src, immediate, cacheGeneration]);

  return resolved;
}
