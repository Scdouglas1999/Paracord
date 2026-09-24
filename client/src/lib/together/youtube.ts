/**
 * The YouTube IFrame Player API, loaded on demand.
 *
 * Videos play from `youtube-nocookie.com` on each person's own device. We make
 * the iframe ourselves (so it can carry a referrer policy: this app sends
 * `Referrer-Policy: no-referrer`, and YouTube refuses to play embeds that
 * arrive with no referrer at all) and hand it to `YT.Player`.
 */

export interface YouTubePlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  setVolume(volume: number): void;
  mute(): void;
  unMute(): void;
  destroy(): void;
  cuePlaylist(args: { list: string; listType: 'playlist' }): void;
  getPlaylist(): string[] | null;
  getVideoData?(): { title?: string };
}

interface YouTubeNamespace {
  Player: new (
    element: HTMLElement | string,
    options: {
      host?: string;
      height?: string;
      width?: string;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: (event: { target: YouTubePlayer }) => void;
        onStateChange?: (event: { data: number; target: YouTubePlayer }) => void;
        onError?: (event: { data: number }) => void;
      };
    },
  ) => YouTubePlayer;
}

declare global {
  interface Window {
    YT?: YouTubeNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

export const YT_STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } as const;

const API_URL = 'https://www.youtube.com/iframe_api';
const EMBED_ORIGIN = 'https://www.youtube-nocookie.com';
const LOAD_TIMEOUT_MS = 15_000;

let loading: Promise<YouTubeNamespace> | null = null;

/** Load the IFrame Player API once. Rejects with words a person can act on. */
export function loadYouTubeApi(): Promise<YouTubeNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (loading) return loading;
  loading = new Promise<YouTubeNamespace>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      loading = null;
      reject(new Error('YouTube did not load on this device. Check your connection and try again.'));
    }, LOAD_TIMEOUT_MS);
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      window.clearTimeout(timer);
      if (window.YT?.Player) resolve(window.YT);
      else reject(new Error('YouTube loaded without its player.'));
    };
    const script = document.createElement('script');
    script.src = API_URL;
    script.async = true;
    script.onerror = () => {
      window.clearTimeout(timer);
      loading = null;
      script.remove();
      reject(new Error('YouTube could not be reached from this device.'));
    };
    document.head.appendChild(script);
  });
  return loading;
}

/** The embed URL for one video, driven entirely by our own controls. */
export function youtubeEmbedUrl(videoId: string, startSeconds = 0): string {
  const params = new URLSearchParams({
    enablejsapi: '1',
    origin: window.location.origin,
    playsinline: '1',
    controls: '0',
    disablekb: '1',
    rel: '0',
    iv_load_policy: '3',
    modestbranding: '1',
    start: String(Math.max(0, Math.floor(startSeconds))),
  });
  return `${EMBED_ORIGIN}/embed/${encodeURIComponent(videoId)}?${params.toString()}`;
}

/** The iframe a `YT.Player` takes over. */
export function createYouTubeFrame(videoId: string, startSeconds: number, title: string): HTMLIFrameElement {
  const frame = document.createElement('iframe');
  frame.src = youtubeEmbedUrl(videoId, startSeconds);
  frame.title = title;
  frame.allow = 'autoplay; encrypted-media; picture-in-picture';
  frame.referrerPolicy = 'strict-origin-when-cross-origin';
  frame.setAttribute('frameborder', '0');
  frame.style.width = '100%';
  frame.style.height = '100%';
  frame.style.border = '0';
  return frame;
}

/** Messages for the IFrame API's error codes. */
export function youtubeErrorMessage(code: number): string {
  switch (code) {
    case 2:
      return 'YouTube did not recognize that video.';
    case 5:
      return 'This video cannot play in this app.';
    case 100:
      return 'This video was removed or made private.';
    case 101:
    case 150:
    case 153:
      return 'The owner of this video does not allow it to play outside YouTube.';
    default:
      return `YouTube could not play this video (error ${code}).`;
  }
}

/** Most videos one playlist link adds. */
export const PLAYLIST_LIMIT = 25;

/**
 * Ask YouTube, on this device, which videos a playlist holds. The server has no
 * API key and does not talk to YouTube for this; the IFrame API can answer.
 */
export async function expandYouTubePlaylist(listId: string): Promise<string[]> {
  const YT = await loadYouTubeApi();
  return new Promise<string[]>((resolve, reject) => {
    const host = document.createElement('div');
    host.style.position = 'fixed';
    host.style.left = '-10000px';
    host.style.top = '0';
    host.style.width = '200px';
    host.style.height = '200px';
    document.body.appendChild(host);
    const target = document.createElement('div');
    host.appendChild(target);
    let player: YouTubePlayer | null = null;
    const finish = (result: string[] | Error) => {
      window.clearTimeout(timer);
      try {
        player?.destroy();
      } catch {
        // already gone
      }
      host.remove();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const timer = window.setTimeout(
      () => finish(new Error('YouTube did not answer with that playlist. Try again, or paste single videos.')),
      15_000,
    );
    const read = () => {
      const ids = player?.getPlaylist() ?? null;
      if (ids && ids.length > 0) finish(ids.slice(0, PLAYLIST_LIMIT));
    };
    player = new YT.Player(target, {
      host: EMBED_ORIGIN,
      height: '200',
      width: '200',
      playerVars: { listType: 'playlist', list: listId, autoplay: 0, origin: window.location.origin },
      events: {
        onReady: () => read(),
        onStateChange: (event) => {
          if (event.data === YT_STATE.CUED || event.data === YT_STATE.UNSTARTED) read();
        },
        // The first video refusing to embed does not stop us reading the list.
        onError: (event) => {
          const ids = player?.getPlaylist() ?? null;
          if (ids && ids.length > 0) finish(ids.slice(0, PLAYLIST_LIMIT));
          else finish(new Error(youtubeErrorMessage(event.data)));
        },
      },
    });
  });
}
