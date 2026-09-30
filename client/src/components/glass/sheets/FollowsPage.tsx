import { useEffect, useMemo, useState } from 'react';
import { Share2 } from 'lucide-react';
import { channelApi } from '../../../api/channels';
import { extractApiError } from '../../../api/client';
import { useCurrentChannelStore } from '../../../hooks/useChannels';
import { GlassButton } from '../primitives';
import { SheetAlert, SheetEmpty, SheetStatus } from './SheetParts';

/**
 * Channel follows, for an announcement channel: which of this server's text
 * channels its posts are cross-posted into. Each channel is a row with a
 * Follow or Unfollow decision; a failed change says why, in words.
 */

interface Follower {
  id: string;
  target_channel_id: string;
  target_guild_id: string;
}

export function FollowsPage({ channelId }: { channelId: string | null }) {
  const channel = useCurrentChannelStore((s) => (channelId ? s.channelsById[channelId] : undefined));
  const channelsByGuild = useCurrentChannelStore((s) => s.channelsByGuild);
  // What the last read of the follows came to; null until it has answered.
  const [result, setResult] = useState<{ followers: Follower[]; error: string | null } | null>(null);
  const [changeError, setChangeError] = useState<string | null>(null);
  const [busyTarget, setBusyTarget] = useState<string | null>(null);
  // Bumped after a change, to read the follows again.
  const [reads, setReads] = useState(0);

  const targets = useMemo(() => {
    if (!channel?.guild_id) return [];
    return (channelsByGuild[channel.guild_id] || []).filter(
      (candidate) => candidate.id !== channel.id && (candidate.type === 0 || candidate.channel_type === 0),
    );
  }, [channelsByGuild, channel]);

  useEffect(() => {
    if (!channelId) return;
    let canceled = false;
    channelApi
      .getFollowers(channelId)
      .then(({ data }) => {
        if (canceled) return;
        setResult({
          followers: data.map((entry) => ({
            id: entry.id,
            target_channel_id: entry.target_channel_id,
            target_guild_id: entry.target_guild_id,
          })),
          error: null,
        });
      })
      .catch((err) => {
        if (!canceled) setResult({ followers: [], error: `Failed to load follows: ${extractApiError(err)}` });
      });
    return () => {
      canceled = true;
    };
  }, [channelId, reads]);

  const followers = result?.followers ?? [];
  const loading = result === null;
  const error = changeError ?? result?.error ?? null;

  const change = async (targetId: string, run: () => Promise<unknown>, failure: string) => {
    setBusyTarget(targetId);
    setChangeError(null);
    try {
      await run();
      setReads((count) => count + 1);
    } catch (err) {
      setChangeError(`${failure}: ${extractApiError(err)}`);
    } finally {
      setBusyTarget(null);
    }
  };

  if (!channelId) {
    return (
      <SheetEmpty icon={<Share2 size={20} />} title="No channel selected">
        Open an announcement channel to manage its follows.
      </SheetEmpty>
    );
  }

  return (
    <div className="glass-sheet-narrow">
      {error && <SheetAlert>{error}</SheetAlert>}
      {loading ? (
        <SheetStatus>Loading follows…</SheetStatus>
      ) : targets.length > 0 ? (
        <ul className="glass-sheet-list" aria-label="Channels to follow into">
          {targets.map((target) => {
            const existing = followers.find((entry) => entry.target_channel_id === target.id);
            const busy = busyTarget === target.id;
            return (
              <li key={target.id} className="glass-sheet-row">
                <span className="glass-sheet-row__text">
                  <span className="glass-sheet-row__name">{target.name}</span>
                  <span className="glass-sheet-row__detail">
                    {existing ? 'Posts from here appear in this channel.' : 'Not following.'}
                  </span>
                </span>
                {existing ? (
                  <GlassButton
                    variant="glass"
                    disabled={busy}
                    onClick={() => void change(target.id, () => channelApi.removeFollower(channelId, target.id), 'Failed to unfollow channel')}
                  >
                    {busy ? 'Removing…' : 'Unfollow'}
                  </GlassButton>
                ) : (
                  <GlassButton
                    variant="glass"
                    disabled={busy || !target.guild_id}
                    onClick={() =>
                      void change(
                        target.id,
                        () => channelApi.addFollower(channelId, target.id, target.guild_id || ''),
                        'Failed to follow channel',
                      )
                    }
                  >
                    {busy ? 'Adding…' : 'Follow'}
                  </GlassButton>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <SheetEmpty icon={<Share2 size={20} />} title="Nothing to follow into yet">
          Create another text channel in this server to cross-post announcements from here.
        </SheetEmpty>
      )}
    </div>
  );
}
