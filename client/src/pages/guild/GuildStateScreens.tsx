import { useNavigate } from 'react-router';
import { Compass } from 'lucide-react';
import { TopBar } from '../../components/layout/TopBar';
import { Button } from '../../components/ui/Button';

// A skeleton row that mimics a grouped message (avatar + author line + body).
function SkeletonMessage({ lines = 2, wide = false }: { lines?: number; wide?: boolean }) {
  return (
    <div className="flex gap-4 px-4 py-2">
      <div className="h-10 w-10 shrink-0 animate-pulse rounded-full bg-bg-mod-subtle" />
      <div className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
        <div className="flex items-center gap-2">
          <div className="h-3.5 w-28 animate-pulse rounded-xs bg-bg-mod-subtle" />
          <div className="h-2.5 w-14 animate-pulse rounded-xs bg-bg-mod-subtle/70" />
        </div>
        {Array.from({ length: lines }, (_, i) => (
          <div
            key={i}
            className="h-3 animate-pulse rounded-xs bg-bg-mod-subtle/70"
            style={{ width: wide && i === 0 ? '82%' : `${68 - i * 16}%` }}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Loading state — a skeleton of the real channel layout (message stream +
 * composer), never a bare centered spinner (design-spec kill-list #4).
 */
export function GuildLoadingScreen() {
  return (
    <div className="flex h-full min-h-0 flex-col" role="status" aria-busy="true">
      <TopBar channelName="Loading..." />
      <div className="flex min-h-0 flex-1 flex-col bg-bg-primary">
        <div className="flex min-h-0 flex-1 flex-col justify-end gap-1 overflow-hidden py-3">
          <SkeletonMessage lines={1} />
          <SkeletonMessage lines={2} wide />
          <SkeletonMessage lines={1} />
          <SkeletonMessage lines={3} wide />
          <SkeletonMessage lines={1} />
          <SkeletonMessage lines={2} />
        </div>
        <div className="shrink-0 px-4 pb-6 pt-1">
          <div className="h-11 animate-pulse rounded-md border border-border-subtle bg-bg-secondary" />
        </div>
      </div>
      <span className="sr-only">Loading channels...</span>
    </div>
  );
}

/**
 * No-channel / no-access state — a real designed empty state per the spec
 * recipe: left-aligned line icon in a tinted well, a Subhead title, warm
 * specific copy, and a primary way back. Covers both "deleted" and
 * "you can't see this" without leaking which.
 */
export function ChannelNotFoundScreen({ guildId }: { guildId: string | undefined }) {
  const navigate = useNavigate();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <TopBar channelName="Channel not found" />
      <div className="flex flex-1 items-center bg-bg-primary px-6 sm:px-10">
        <div className="w-full max-w-md">
          <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-sm bg-accent-tint text-accent-primary">
            <Compass size={20} strokeWidth={2} />
          </div>
          <h2 className="font-display text-heading text-text-primary">Channel not found</h2>
          <p className="mt-2 max-w-prose text-body text-text-secondary">
            This channel may have been deleted, or you might not have permission to
            see it. Head back to the server to pick one you can open.
          </p>
          {guildId && (
            <div className="mt-6">
              <Button onClick={() => navigate(`/app/guilds/${guildId}`)}>
                Back to a channel you can see
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
