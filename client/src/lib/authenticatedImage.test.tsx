import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ tauri: false }));
const bridge = vi.hoisted(() => ({ resolveResourceObjectUrl: vi.fn<(url: string) => Promise<string>>() }));

vi.mock('./tauriEnv', () => ({ isTauri: () => env.tauri }));
vi.mock('../api/files', () => ({ fileApi: bridge }));

import { clearAuthenticatedImageCache, useAuthenticatedImage } from './authenticatedImage';

/** A resolution the test settles by hand, so a render can be read while it is pending. */
function deferred() {
  let resolve!: (value: string) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Every value the hook returned, render by render, so a stale one cannot hide between effects. */
function renderImage(initial: string | null | undefined) {
  const seen: Array<string | null> = [];
  const view = renderHook(
    ({ src }: { src: string | null | undefined }) => {
      const value = useAuthenticatedImage(src);
      seen.push(value);
      return value;
    },
    { initialProps: { src: initial } },
  );
  return { ...view, seen };
}

beforeEach(() => {
  env.tauri = false;
  bridge.resolveResourceObjectUrl.mockReset();
  clearAuthenticatedImageCache();
});
afterEach(() => {
  cleanup();
});

describe('useAuthenticatedImage', () => {
  describe('where the browser loads the URL itself', () => {
    it('hands back the URL it was given', () => {
      const { result } = renderImage('https://server.example/banner-a.png');
      expect(result.current).toBe('https://server.example/banner-a.png');
    });

    it('never returns the previous URL for a render after its input changes', () => {
      const { seen, rerender, result } = renderImage('https://server.example/banner-a.png');
      const before = seen.length;

      rerender({ src: 'https://server.example/banner-b.png' });

      expect(seen.slice(before)).not.toContain('https://server.example/banner-a.png');
      expect(seen[before]).toBe('https://server.example/banner-b.png');
      expect(result.current).toBe('https://server.example/banner-b.png');
    });

    it('reads no image in the same render the input goes away', () => {
      const { seen, rerender } = renderImage('https://server.example/banner-a.png');
      const before = seen.length;

      rerender({ src: null });
      rerender({ src: undefined });

      expect(seen.slice(before)).toEqual([null, null]);
    });
  });

  describe('where the desktop shell fetches it over the bridge', () => {
    beforeEach(() => {
      env.tauri = true;
    });

    it('is empty while the bridge works, then the object URL', async () => {
      const job = deferred();
      bridge.resolveResourceObjectUrl.mockReturnValueOnce(job.promise);
      const { result } = renderImage('/api/v1/guilds/1/banner');
      expect(result.current).toBeNull();

      await act(async () => job.resolve('blob:banner-1'));

      expect(result.current).toBe('blob:banner-1');
      expect(bridge.resolveResourceObjectUrl).toHaveBeenCalledWith('/api/v1/guilds/1/banner');
    });

    it('never shows the old image while a new input resolves', async () => {
      const first = deferred();
      const second = deferred();
      bridge.resolveResourceObjectUrl.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      const { seen, rerender, result } = renderImage('/api/v1/guilds/1/banner');
      await act(async () => first.resolve('blob:banner-1'));
      expect(result.current).toBe('blob:banner-1');
      const before = seen.length;

      rerender({ src: '/api/v1/guilds/2/banner' });
      // Every render between the change and the new image: none is the old one.
      expect(seen.slice(before)).not.toContain('blob:banner-1');
      expect(result.current).toBeNull();

      await act(async () => second.resolve('blob:banner-2'));
      expect(result.current).toBe('blob:banner-2');
      expect(seen.slice(before)).not.toContain('blob:banner-1');
    });

    it('switches to a URL that needs no bridge in the same render', async () => {
      const job = deferred();
      bridge.resolveResourceObjectUrl.mockReturnValueOnce(job.promise);
      const { seen, rerender } = renderImage('/api/v1/guilds/1/banner');
      await act(async () => job.resolve('blob:banner-1'));
      const before = seen.length;

      rerender({ src: 'data:image/png;base64,AAAA' });

      expect(seen[before]).toBe('data:image/png;base64,AAAA');
      expect(seen.slice(before)).not.toContain('blob:banner-1');
    });

    it('drops the image the moment the input goes away', async () => {
      const job = deferred();
      bridge.resolveResourceObjectUrl.mockReturnValueOnce(job.promise);
      const { seen, rerender } = renderImage('/api/v1/guilds/1/banner');
      await act(async () => job.resolve('blob:banner-1'));
      const before = seen.length;

      rerender({ src: null });

      expect(seen[before]).toBeNull();
    });

    it('ignores an answer for an input that has been replaced', async () => {
      const slow = deferred();
      const quick = deferred();
      bridge.resolveResourceObjectUrl.mockReturnValueOnce(slow.promise).mockReturnValueOnce(quick.promise);
      const { rerender, result } = renderImage('/api/v1/guilds/1/banner');
      rerender({ src: '/api/v1/guilds/2/banner' });

      await act(async () => quick.resolve('blob:banner-2'));
      await act(async () => slow.resolve('blob:banner-1'));

      expect(result.current).toBe('blob:banner-2');
    });

    it('reads no image, and not the last one, when the bridge fails', async () => {
      const first = deferred();
      const second = deferred();
      bridge.resolveResourceObjectUrl.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      const { rerender, result } = renderImage('/api/v1/guilds/1/banner');
      await act(async () => first.resolve('blob:banner-1'));

      rerender({ src: '/api/v1/guilds/2/banner' });
      await act(async () => {
        second.reject(new Error('no route'));
        await second.promise.catch(() => undefined);
      });

      expect(result.current).toBeNull();
    });

    it('resolves again, and shows nothing meanwhile, once the cache is cleared', async () => {
      const first = deferred();
      const second = deferred();
      bridge.resolveResourceObjectUrl.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      const { seen, result } = renderImage('/api/v1/guilds/1/banner');
      await act(async () => first.resolve('blob:banner-1'));
      expect(result.current).toBe('blob:banner-1');
      const before = seen.length;

      act(() => clearAuthenticatedImageCache());
      expect(seen.slice(before)).not.toContain('blob:banner-1');
      expect(result.current).toBeNull();

      await act(async () => second.resolve('blob:banner-1b'));
      expect(result.current).toBe('blob:banner-1b');
      expect(bridge.resolveResourceObjectUrl).toHaveBeenCalledTimes(2);
    });
  });
});
