import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MoreHorizontal, Pause, Pencil, Play, Plus, Rss, Send, Trash2 } from 'lucide-react';
import { feedsApi, type CreatedFeed, type Feed, type FeedList, feedErrorMessage } from '../../api/feeds';
import { useGuildChannels } from '../../hooks/useChannels';
import { ChannelType, type Channel } from '../../types';
import { cn } from '../../lib/utils';
import { confirm } from '../../stores/confirmStore';
import { toast } from '../../stores/toastStore';
import { Button, Chip, EmptyState, ErrorBanner, IconButton, LoadingSpinner, Switch, Well } from '../ui';
import { MenuItem, Popover } from '../ui/Popover';
import { GroupLabel } from '../guild/SettingsPrimitives';
import { AddFeedSheet } from './AddFeedSheet';
import { EditFeedSheet } from './EditFeedSheet';
import { FeedSourceIcon } from './feedKinds';
import { feedStatusLine, shortKind } from './feedStatus';

/** Re-read the list this often while the page is open, so "Checked" stays true. */
const REFRESH_MS = 60_000;

function postableChannels(channels: readonly Channel[]): Channel[] {
  return channels
    .filter((channel) => {
      const type = channel.channel_type ?? channel.type;
      return type === ChannelType.Text || type === ChannelType.Announcement;
    })
    .slice()
    .sort((a, b) => a.position - b.position);
}

/**
 * Server settings → Add-ons → Feeds: the server's feeds, each with where it
 * posts and how its last check went, and "Add a feed".
 */
export function FeedsSection({ guildId }: { guildId: string }) {
  const [data, setData] = useState<FeedList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Feed | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const guildChannels = useGuildChannels(guildId);
  const channels = useMemo(() => postableChannels(guildChannels), [guildChannels]);
  const channelName = useCallback(
    (id: string) => guildChannels.find((channel) => channel.id === id)?.name ?? 'a deleted channel',
    [guildChannels],
  );

  const load = useCallback(async () => {
    try {
      const res = await feedsApi.list(guildId);
      setData(res.data);
      setError(null);
      setNow(Date.now());
    } catch (err) {
      setError(feedErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [guildId]);

  useEffect(() => {
    setLoading(true);
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const setEnabled = async (enabled: boolean) => {
    if (!enabled) {
      const ok = await confirm({
        title: 'Turn off Feeds?',
        description: 'Feeds stop checking their sources. They stay saved, and what they posted stays in the channels.',
        confirmLabel: 'Turn off',
        cancelLabel: 'Cancel',
        variant: 'danger',
      });
      if (!ok) return;
    }
    setToggling(true);
    try {
      await feedsApi.setEnabled(guildId, enabled);
      setData((current) => (current ? { ...current, enabled } : current));
    } catch (err) {
      toast.error(feedErrorMessage(err));
    } finally {
      setToggling(false);
    }
  };

  const replace = (feed: Feed) =>
    setData((current) =>
      current ? { ...current, feeds: current.feeds.map((item) => (item.id === feed.id ? feed : item)) } : current,
    );

  const onAdded = (created: CreatedFeed) =>
    setData((current) => (current ? { ...current, feeds: [...current.feeds, created.feed] } : current));

  const togglePause = async (feed: Feed) => {
    try {
      const res = await feedsApi.update(guildId, feed.id, { paused: !feed.paused });
      replace(res.data);
      toast.success(res.data.paused ? `${feed.name} is paused.` : `${feed.name} is running again.`);
    } catch (err) {
      toast.error(feedErrorMessage(err));
    }
  };

  const postLatest = async (feed: Feed) => {
    try {
      await feedsApi.postLatest(guildId, feed.id);
      toast.success(`Posted the latest from ${feed.name} in #${channelName(feed.channel_id)}.`);
      void load();
    } catch (err) {
      toast.error(feedErrorMessage(err));
    }
  };

  const remove = async (feed: Feed) => {
    const ok = await confirm({
      title: `Remove ${feed.name}?`,
      description: 'It stops posting. What it already posted stays in the channel.',
      confirmLabel: 'Remove',
      cancelLabel: 'Cancel',
      variant: 'danger',
    });
    if (!ok) return;
    try {
      await feedsApi.remove(guildId, feed.id);
      setData((current) =>
        current ? { ...current, feeds: current.feeds.filter((item) => item.id !== feed.id) } : current,
      );
      toast.success(`${feed.name} removed.`);
    } catch (err) {
      toast.error(feedErrorMessage(err));
    }
  };

  const enabled = data?.enabled ?? false;
  const feeds = data?.feeds ?? [];
  const limit = data?.limit ?? 20;
  const full = feeds.length >= limit;

  return (
    <div className="flex h-full min-h-0 flex-col gap-8 overflow-y-auto pb-6">
      <Well bare className="flex items-start gap-3 px-4 py-4 sm:items-center">
        <span className="pc-addon-mark" aria-hidden>
          <Rss size={22} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-display text-name font-semibold text-text-primary">Feeds</h3>
            {enabled && <Chip size="sm" tone="accent">On</Chip>}
          </div>
          <p className="mt-0.5 text-body leading-relaxed text-text-secondary">
            New posts, videos, releases and streams from outside Paracord, posted into a channel as cards.
          </p>
        </div>
        <Switch
          checked={enabled}
          onChange={(next) => void setEnabled(next)}
          disabled={!data || toggling}
          label="Feeds on this server"
          className="mt-1 sm:mt-0"
        />
      </Well>

      {error && <ErrorBanner message={error} multiline onRetry={() => void load()} />}

      {loading && !data ? (
        <LoadingSpinner label="Loading feeds…" className="py-10" />
      ) : !enabled ? (
        <p className="max-w-prose text-body text-text-secondary">
          Turn Feeds on to add feeds to this server. A feed checks its source every few minutes and posts only what is new.
        </p>
      ) : (
        <section className="flex flex-col gap-3" aria-label="Feeds on this server">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-baseline gap-2">
              <GroupLabel>Feeds on this server</GroupLabel>
              <span className="text-meta tabular-nums text-text-faint">
                {feeds.length} of {limit}
              </span>
            </div>
            {feeds.length > 0 && (
              <Button size="sm" variant="primary" onClick={() => setAdding(true)} disabled={full}>
                <Plus size={14} aria-hidden />
                Add a feed
              </Button>
            )}
          </div>
          {full && (
            <p className="text-meta text-text-muted">
              This server has {limit} feeds, the most it can have. Remove one to add another.
            </p>
          )}
          {feeds.length === 0 ? (
            <EmptyState
              icon={<Rss size={18} />}
              title="No feeds yet"
              description="Add a blog, a YouTube channel, a GitHub repository, a Twitch channel or your Jellyfin library. New items land in the channel you pick."
              action={
                <Button variant="primary" onClick={() => setAdding(true)}>
                  <Plus size={16} aria-hidden />
                  Add a feed
                </Button>
              }
            />
          ) : (
            <ul className="flex flex-col divide-y divide-border-subtle">
              {feeds.map((feed) => (
                <FeedRow
                  key={feed.id}
                  feed={feed}
                  channel={channelName(feed.channel_id)}
                  now={now}
                  onEdit={() => setEditing(feed)}
                  onPostLatest={() => void postLatest(feed)}
                  onTogglePause={() => void togglePause(feed)}
                  onRemove={() => void remove(feed)}
                />
              ))}
            </ul>
          )}
        </section>
      )}

      <AddFeedSheet
        guildId={guildId}
        open={adding}
        onClose={() => setAdding(false)}
        twitchAvailable={data?.twitch_available ?? false}
        channels={channels}
        onAdded={onAdded}
      />
      <EditFeedSheet
        guildId={guildId}
        feed={editing}
        onClose={() => setEditing(null)}
        channels={channels}
        onSaved={replace}
      />
    </div>
  );
}

function FeedRow({
  feed,
  channel,
  now,
  onEdit,
  onPostLatest,
  onTogglePause,
  onRemove,
}: {
  feed: Feed;
  channel: string;
  now: number;
  onEdit: () => void;
  onPostLatest: () => void;
  onTogglePause: () => void;
  onRemove: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const status = feedStatusLine(feed, now);
  const close = () => setMenuOpen(false);
  const act = (action: () => void) => () => {
    close();
    action();
  };

  return (
    <li className={cn('pc-feed-row flex items-start gap-3 py-3', feed.paused && 'opacity-80')}>
      <FeedSourceIcon kind={feed.kind} iconUrl={feed.icon_url} size={36} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-label font-semibold text-text-primary">{feed.name}</span>
          {!feed.show_on_front_page && (
            <span className="hidden shrink-0 text-meta text-text-faint sm:inline">Not on the front page</span>
          )}
        </div>
        <p className="mt-0.5 truncate text-meta text-text-muted">
          #{channel} · {shortKind(feed.kind)}
          {feed.source ? ` · ${feed.source.replace(/^https?:\/\//, '')}` : ''}
        </p>
        <p
          className={cn(
            'mt-1 text-meta leading-relaxed',
            status.tone === 'error' ? 'text-accent-danger' : 'text-text-secondary',
          )}
        >
          {status.text}
        </p>
      </div>
      <IconButton
        ref={anchor}
        label={`Options for ${feed.name}`}
        size="sm"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}
      >
        <MoreHorizontal size={16} />
      </IconButton>
      <Popover anchor={anchor} open={menuOpen} onClose={close} role="menu" label={`${feed.name} options`} side="bottom" align="end" className="w-56 p-1">
        <MenuItem icon={<Pencil size={14} />} onClick={act(onEdit)}>
          Edit
        </MenuItem>
        <MenuItem icon={<Send size={14} />} onClick={act(onPostLatest)}>
          Post the latest now
        </MenuItem>
        <MenuItem icon={feed.paused ? <Play size={14} /> : <Pause size={14} />} onClick={act(onTogglePause)}>
          {feed.paused ? 'Resume' : 'Pause'}
        </MenuItem>
        <MenuItem icon={<Trash2 size={14} />} danger onClick={act(onRemove)}>
          Remove
        </MenuItem>
      </Popover>
    </li>
  );
}
