/**
 * What can be played together, from what someone pasted.
 *
 * The server checks everything again; this is here so the sheet can say at
 * once what a link is (and expand a YouTube playlist on this device, which is
 * the only place that can ask YouTube for its videos).
 */

export const UNSUPPORTED_LINK = 'Paracord can play YouTube links and direct video or audio files';
export const HTTP_LINK = 'Direct links must start with https:// so every device can play them';

const MEDIA_EXTENSIONS = ['mp4', 'webm', 'mp3', 'ogg', 'm4a', 'flac', 'wav'] as const;
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_LIST = /^[A-Za-z0-9_-]{10,64}$/;
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

export type ParsedLink =
  | { kind: 'youtube'; videoId: string }
  | { kind: 'youtube-playlist'; listId: string }
  | { kind: 'url'; url: string; audio: boolean; host: string }
  | { kind: 'error'; message: string };

export function parseTogetherLink(raw: string): ParsedLink {
  const text = raw.trim();
  if (!text) return { kind: 'error', message: UNSUPPORTED_LINK };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { kind: 'error', message: UNSUPPORTED_LINK };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { kind: 'error', message: UNSUPPORTED_LINK };
  }
  const host = url.hostname.toLowerCase();

  if (host === 'youtu.be') {
    const id = url.pathname.split('/')[1] ?? '';
    return YOUTUBE_ID.test(id) ? { kind: 'youtube', videoId: id } : { kind: 'error', message: UNSUPPORTED_LINK };
  }
  if (YOUTUBE_HOSTS.has(host)) {
    const v = url.searchParams.get('v');
    if (url.pathname === '/watch' && v && YOUTUBE_ID.test(v)) return { kind: 'youtube', videoId: v };
    const [, section, id] = url.pathname.split('/');
    if (['shorts', 'embed', 'live'].includes(section ?? '') && id && YOUTUBE_ID.test(id)) {
      return { kind: 'youtube', videoId: id };
    }
    const list = url.searchParams.get('list');
    if ((url.pathname === '/playlist' || url.pathname === '/watch') && list && YOUTUBE_LIST.test(list)) {
      return { kind: 'youtube-playlist', listId: list };
    }
    return { kind: 'error', message: 'That YouTube link is not a video or a playlist' };
  }

  const fileName = url.pathname.split('/').pop() ?? '';
  const extension = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : '';
  if ((MEDIA_EXTENSIONS as readonly string[]).includes(extension)) {
    // Every device in the call fetches the file itself, and the desktop app
    // plays media over https only: the web app refuses plain http too.
    if (url.protocol !== 'https:') return { kind: 'error', message: HTTP_LINK };
    return { kind: 'url', url: url.toString(), audio: !['mp4', 'webm'].includes(extension), host: url.host };
  }
  return { kind: 'error', message: UNSUPPORTED_LINK };
}

export function isYouTubeLink(parsed: ParsedLink): boolean {
  return parsed.kind === 'youtube' || parsed.kind === 'youtube-playlist';
}

/** Where a link's media is fetched from, for "Plays from … on each person's device". */
export function mediaHost(ref: string): string | null {
  try {
    return new URL(ref).host || null;
  } catch {
    return null;
  }
}
