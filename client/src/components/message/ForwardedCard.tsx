import type { ReactNode } from 'react';
import { Forward } from 'lucide-react';
import { useNavigate } from 'react-router';
import { forwardAttribution } from '../../lib/forwardedMessage';
import { entityScopeKey, type AccountScope } from '../../lib/serverScope';
import { useChannelStore } from '../../stores/channelStore';
import type { ForwardedFrom } from '../../types';
import { cn } from '../../lib/utils';

/**
 * The quoted original inside a forwarded message: where it came from, who
 * wrote it and when, its text, and its pictures as thumbnails. It opens the
 * original only when this account can see that conversation; otherwise it is
 * plain text, not a link.
 */
export function ForwardedCard({
  forward,
  quote,
  thumbnails,
  scope,
}: {
  forward: ForwardedFrom;
  quote: string;
  thumbnails?: ReactNode;
  scope: AccountScope | null;
}) {
  const navigate = useNavigate();
  const canJump = useChannelStore((state) =>
    Boolean(scope && !forward.error && state.channelsById[entityScopeKey(scope, forward.channel_id)]),
  );
  const attribution = forward.error ?? forwardAttribution(forward);

  const body = (
    <>
      <span className="flex min-w-0 items-start gap-1.5 text-meta leading-snug text-text-muted">
        <Forward size={12} className="mt-[0.2em] shrink-0" aria-hidden />
        <span className="min-w-0 break-words">{attribution}</span>
      </span>
      {quote && !forward.error && (
        <span className="block whitespace-pre-wrap break-words text-body text-text-body">{quote}</span>
      )}
      {thumbnails && <span className="mt-1 flex flex-wrap gap-1.5">{thumbnails}</span>}
    </>
  );

  const className = cn(
    'mt-1 flex w-full max-w-lg flex-col gap-1 rounded-[var(--radius-well)] border-l-2 border-border-strong bg-bg-well px-3 py-2 text-left',
    canJump && 'pc-focusable transition-colors duration-150 ease-out hover:bg-bg-mod-subtle',
  );

  if (!canJump) return <div className={className}>{body}</div>;
  const path = forward.guild_id
    ? `/app/guilds/${forward.guild_id}/channels/${forward.channel_id}?message=${encodeURIComponent(forward.message_id)}`
    : `/app/dms/${forward.channel_id}?message=${encodeURIComponent(forward.message_id)}`;
  return (
    <button
      type="button"
      className={className}
      title="Open the original message"
      onClick={() => navigate(path)}
    >
      {body}
    </button>
  );
}
