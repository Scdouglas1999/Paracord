import { useNavigate } from 'react-router';
import { Compass } from 'lucide-react';
import { GlassPage, PageBar, PageScroll } from '../../components/home/GlassPage';
import { Button } from '../../components/ui/Button';
import { useGlassLayout } from '../../components/glass/shell/useGlassLayout';
import { EmptyState } from '../../components/ui/Feedback';
import { cn } from '../../lib/utils';

/**
 * The three states of a channel route that has no conversation to draw yet
 * (docs/glass-spec.md §3.2): loading, not found or not yours, and could not
 * load. They fill the conversation pane, so each one sits where the
 * conversation's own header, column and message box sit.
 */

/** A placeholder shape: a solid tonal wash, pulsed on opacity alone. */
const WASH = 'pc-skeleton bg-[var(--bub)]';

/**
 * One group of bubbles in the timeline's own geometry (the 720px column, a 32px
 * face at the group's foot, 20px bubbles joined on the face's side): widths are
 * the share of the column the bubble fills. Yours mirror it, on the right, with
 * no face.
 */
function SkeletonGroup({ widths, own = false }: { widths: readonly number[]; own?: boolean }) {
  return (
    <div className="glass-msg glass-tl-col" data-own={own || undefined}>
      {!own && (
        <span className="glass-msg__face">
          <span className={cn(WASH, 'h-8 w-8 rounded-full')} />
        </span>
      )}
      <div className="glass-msg__body">
        {!own && (
          <div className="glass-msg__head">
            <span className={cn(WASH, 'h-3 w-24 rounded-[6px]')} />
            <span className={cn(WASH, 'h-2.5 w-10 rounded-[6px]')} />
          </div>
        )}
        {widths.map((width, index) => (
          <span
            key={index}
            className={cn(
              own ? 'pc-skeleton bg-[var(--raise)]' : WASH,
              'block h-[38px] rounded-[var(--r-bubble)]',
              // The joined corner faces the author's side; the last bubble keeps its 6px tail.
              own ? 'rounded-br-[6px]' : 'rounded-bl-[6px]',
              index > 0 && (own ? 'rounded-tr-[6px]' : 'rounded-tl-[6px]'),
            )}
            style={{ width: `${width}%`, maxWidth: 560 }}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Loading: a skeleton of the conversation it becomes (header row, bubbles in the
 * column, the message box), never a bare spinner. It reads as one polite status.
 */
export function GuildLoadingScreen() {
  const layout = useGlassLayout();
  return (
    <div className="glass-conversation" data-layout={layout} role="status" aria-busy="true">
      <div className="glass-conversation__header">
        <div className="glass-header" data-layout={layout} aria-hidden="true">
          <div className="glass-header__heading">
            <span className={cn(WASH, 'mb-1 h-5 w-40 rounded-[8px]')} />
            <span className={cn(WASH, 'h-3 w-56 rounded-[6px]')} />
          </div>
          <div className="glass-header__tools">
            <span className={cn(WASH, 'mr-1 h-8 w-8 rounded-full')} />
          </div>
        </div>
      </div>
      <div className="glass-conversation__timeline" aria-hidden="true">
        <div className="glass-timeline flex min-h-0 flex-1 flex-col justify-end overflow-hidden pb-2">
          <SkeletonGroup widths={[46]} />
          <SkeletonGroup widths={[62, 38]} />
          <SkeletonGroup widths={[34]} own />
          <SkeletonGroup widths={[54, 70, 28]} />
        </div>
      </div>
      <div className="glass-conversation__composer" aria-hidden="true">
        <div className="glass-composer">
          <div className="glass-composer__capsule items-center">
            <span className={cn(WASH, 'h-9 w-9 shrink-0 rounded-full')} />
            <span className={cn(WASH, 'h-3 flex-1 rounded-[6px]')} style={{ maxWidth: '40%' }} />
          </div>
        </div>
      </div>
      <span className="sr-only">Loading channels...</span>
    </div>
  );
}

/**
 * No-channel / no-access state: one specific line of copy and a way back.
 * Covers both "deleted" and "you can't see this" without leaking which.
 */
export function ChannelNotFoundScreen({ guildId }: { guildId: string | undefined }) {
  const navigate = useNavigate();
  return (
    <GlassPage label="Channel not found">
      <PageBar title="Channel not found" />
      <PageScroll>
        <EmptyState
          icon={<Compass size={18} strokeWidth={1.7} aria-hidden="true" />}
          title="Nothing to open here"
          description="This channel may have been deleted, or you might not have permission to see it. Head back to the server to pick one you can open."
          action={
            guildId ? (
              <Button onClick={() => navigate(`/app/guilds/${guildId}`)}>Back to a channel you can see</Button>
            ) : undefined
          }
        />
      </PageScroll>
    </GlassPage>
  );
}

export function ChannelLoadErrorScreen({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <GlassPage label="Channels unavailable">
      <PageBar title="Channels unavailable" />
      <PageScroll>
        <EmptyState
          role="alert"
          title="Couldn't load channels"
          description={error}
          action={<Button onClick={onRetry}>Try again</Button>}
        />
      </PageScroll>
    </GlassPage>
  );
}
