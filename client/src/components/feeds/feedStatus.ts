import type { Feed, FeedKind } from '../../api/feeds';

/** "Checked 4 min ago", from when the source was last checked. */
export function checkedLabel(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return 'Waiting for the first check';
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return 'Waiting for the first check';
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return 'Checked just now';
  if (minutes < 60) return `Checked ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Checked ${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'Checked yesterday' : `Checked ${days} days ago`;
}

export type FeedStatusTone = 'ok' | 'error' | 'paused';

/** What a feed's row says about it, and in which tone. */
export function feedStatusLine(feed: Pick<Feed, 'paused' | 'status'>, now: number = Date.now()): {
  text: string;
  tone: FeedStatusTone;
} {
  if (feed.paused) return { text: 'Paused', tone: 'paused' };
  if (feed.status.error) return { text: feed.status.error, tone: 'error' };
  return { text: checkedLabel(feed.status.last_checked_at, now), tone: 'ok' };
}

const SHORT_KIND: Record<FeedKind, string> = {
  rss: 'RSS',
  youtube: 'YouTube',
  github: 'GitHub',
  twitch: 'Twitch',
  jellyfin: 'Jellyfin',
};

export function shortKind(kind: string): string {
  return SHORT_KIND[kind as FeedKind] ?? kind;
}

/**
 * A quick check before asking the server, so an obviously wrong entry is
 * named right away. Returns a sentence, or null when it looks right.
 */
export function inputProblem(kind: FeedKind, raw: string, branch?: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  switch (kind) {
    case 'rss':
    case 'jellyfin': {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !/^https?:\/\//i.test(value)) {
        return 'Only http and https addresses can be used.';
      }
      if (/\s/.test(value)) return "That isn't a web address.";
      return null;
    }
    case 'youtube': {
      if (/^UC[0-9A-Za-z_-]{22}$/.test(value) || /^@[^\s/]+$/.test(value)) return null;
      if (!/(^|\.|\/\/)(youtube\.com|youtu\.be)(\/|$)/i.test(value)) {
        return 'Paste a youtube.com or youtu.be address, or an @handle.';
      }
      return null;
    }
    case 'github': {
      const path = value.replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/^github\.com\//i, '');
      if (!/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}(\/.*)?$/.test(path)) {
        return 'Type the repository as owner/repo.';
      }
      if (branch !== undefined && !branch.trim()) return 'Name the branch to follow.';
      return null;
    }
    case 'twitch': {
      const login = value.replace(/^https?:\/\/(www\.)?twitch\.tv\//i, '').replace(/^twitch\.tv\//i, '').replace(/^@/, '').split('/')[0];
      if (!/^[A-Za-z0-9_]{3,25}$/.test(login)) return 'A Twitch channel name is 3 to 25 letters, digits or underscores.';
      return null;
    }
  }
}
