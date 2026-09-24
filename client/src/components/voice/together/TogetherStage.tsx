import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Lock } from 'lucide-react';

import { canControl, currentItem, formatPlaybackTime, playsFromLine } from '../../../lib/together/model';
import { cn } from '../../../lib/utils';
import { useTogetherStore } from '../../../stores/togetherStore';
import { Modal, ModalBody, ModalHeader, ModalTitle, Raised } from '../../ui';
import { runTogether, TogetherControls, usePlaybackPosition } from './TogetherControls';
import { TogetherCover } from './TogetherCover';
import { TogetherSlot } from './TogetherHost';
import { noticeSentence, useLatestNotice } from './TogetherNotices';
import { TogetherQueue } from './TogetherQueue';
import { TogetherSheet } from './TogetherSheet';
import type { TogetherContext } from './useTogether';

/** The phone Stage gives a watch session this much height: 16:9 plus controls. */
export const PHONE_WATCH_HEIGHT = 350;

function Meta({ together, className }: { together: TogetherContext & { session: NonNullable<TogetherContext['session']> }; className?: string }) {
  const { session } = together;
  const locked = session.controller_policy === 'starter';
  return (
    <span className={cn('flex min-w-0 items-center gap-1.5 truncate text-meta text-text-muted', className)}>
      {locked && <Lock size={12} className="shrink-0" aria-label="Controls locked" />}
      <span className="truncate">
        {session.kind === 'watch' ? 'Watching together' : 'Listening together'}
        {' · started by '}
        {together.nameOf(session.started_by)}
      </span>
    </span>
  );
}

/** Until the media says its shape, assume the usual 16:9. */
const DEFAULT_ASPECT = 16 / 9;

/**
 * The largest box of `aspect` that fits the column above its footer, so the
 * video fills its frame edge to edge instead of sitting in black bars.
 */
function useFittedMedia(
  column: RefObject<HTMLDivElement | null>,
  footer: RefObject<HTMLDivElement | null>,
  aspect: number,
  gap: number,
): { width: number; height: number } | null {
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const col = column.current;
    const foot = footer.current;
    if (!col || !foot) return;
    const measure = () => {
      const availableWidth = col.clientWidth;
      const availableHeight = col.clientHeight - foot.offsetHeight - gap;
      if (availableWidth <= 0 || availableHeight <= 0) return;
      let width = availableWidth;
      let height = width / aspect;
      if (height > availableHeight) {
        height = availableHeight;
        width = height * aspect;
      }
      const next = { width: Math.floor(width), height: Math.floor(height) };
      setBox((prev) => (prev && prev.width === next.width && prev.height === next.height ? prev : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(col);
    observer.observe(foot);
    return () => observer.disconnect();
  }, [column, footer, aspect, gap]);
  return box;
}

/**
 * Watch together on the Stage: the player takes the big tile, the people move
 * to the strip, and the shared controls sit under the picture. The queue opens
 * beside it (a sheet on a phone).
 */
export function TogetherWatchStage({ together, phone }: { together: TogetherContext; phone: boolean }) {
  const session = together.session;
  const [queueOpen, setQueueOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const addAnchor = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const notice = useLatestNotice(together.channelId);
  const player = useTogetherStore((s) => s.player);
  const item = currentItem(session);
  const aspect = (item && player.itemId === item.id ? player.aspect : null) ?? DEFAULT_ASPECT;
  const box = useFittedMedia(columnRef, addAnchor, aspect, 8);
  if (!session) return null;
  const ctx = { ...together, session };
  const playsFrom = playsFromLine(item);

  const queue = (
    <TogetherQueue
      session={session}
      api={together.api}
      selfUserId={together.selfUserId}
      nameOf={together.nameOf}
      onAdd={() => setAdding(true)}
      className={phone ? 'max-h-[60vh]' : 'h-full'}
    />
  );

  return (
    <div className="flex h-full min-h-0 gap-[var(--gutter)]" data-together-stage="watch">
      <div ref={columnRef} className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-2">
        <div
          className="relative max-w-full shrink-0"
          style={box ? { width: box.width, height: box.height } : { width: '100%', aspectRatio: String(aspect) }}
        >
          <TogetherSlot variant="stage" className="absolute inset-0 rounded-[var(--radius-card)] bg-bg-well" />
        </div>
        <div ref={addAnchor} className="flex w-full min-w-0 shrink-0 flex-col gap-2">
          <div className="flex min-w-0 flex-col gap-0.5 px-1">
            <div className={cn('flex min-w-0 gap-x-2 gap-y-0.5', phone ? 'flex-col' : 'items-baseline')}>
              <h2 className="min-w-0 shrink truncate text-label font-semibold text-text-primary">{item?.title ?? 'The queue is empty'}</h2>
              {notice ? (
                <span key={notice.id} aria-live="polite" className="pc-enter min-w-0 truncate text-meta text-text-secondary">
                  {noticeSentence(notice, together.nameOf)}
                </span>
              ) : (
                <Meta together={ctx} />
              )}
            </div>
            {playsFrom && <p className="truncate text-meta text-text-muted">{playsFrom}</p>}
          </div>
          <TogetherControls
            session={session}
            serverId={together.serverId}
            api={together.api}
            selfUserId={together.selfUserId}
            starterName={together.nameOf(session.started_by)}
            queueOpen={queueOpen}
            onToggleQueue={() => setQueueOpen((open) => !open)}
            compact={phone}
          />
        </div>
      </div>
      {queueOpen && !phone && (
        <Raised bare className="flex w-72 shrink-0 flex-col p-2.5 pc-enter">
          {queue}
        </Raised>
      )}
      {phone && (
        <Modal open={queueOpen} onClose={() => setQueueOpen(false)} size="sm">
          <ModalHeader>
            <ModalTitle>Queue</ModalTitle>
          </ModalHeader>
          <ModalBody>{queue}</ModalBody>
        </Modal>
      )}
      <TogetherSheet
        anchor={addAnchor}
        open={adding}
        onClose={() => setAdding(false)}
        guildId={together.guildId}
        channelId={together.channelId}
        api={together.api}
        session={session}
        selfUserId={together.selfUserId}
      />
    </div>
  );
}

/**
 * Listen together: a compact now-playing bar above the call's tiles, which
 * stay as they are. The queue unfolds under it.
 */
export function TogetherNowPlaying({ together, phone }: { together: TogetherContext; phone: boolean }) {
  const session = together.session;
  const [queueOpen, setQueueOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const notice = useLatestNotice(together.channelId);
  const player = useTogetherStore((s) => s.player);
  if (!session) return null;
  const item = currentItem(session);
  const ctx = { ...together, session };
  return (
    <Raised bare className="flex shrink-0 flex-col gap-2 p-2.5" data-together-stage="listen" ref={anchor}>
      <div className="flex min-w-0 items-center gap-3">
        <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-[var(--radius-control)] bg-bg-well">
          {item ? <TogetherSlot variant="bar" className="absolute inset-0" /> : null}
          {!item && <TogetherCover item={{ thumbnail: null, source: 'url', content_type: 'audio/' }} />}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-label font-semibold text-text-primary">{item?.title ?? 'The queue is empty'}</span>
          {notice ? (
            <span aria-live="polite" className="truncate text-meta text-text-secondary">
              {noticeSentence(notice, together.nameOf)}
            </span>
          ) : player.error && player.itemId === item?.id ? (
            <span role="alert" className="truncate text-meta text-accent-danger">{player.error}</span>
          ) : playsFromLine(item) ? (
            <span className="truncate text-meta text-text-muted">{playsFromLine(item)}</span>
          ) : (
            <Meta together={ctx} />
          )}
          <ListenProgress together={ctx} />
        </div>
        {!phone && (
          <TogetherControls
            session={session}
            serverId={together.serverId}
            api={together.api}
            selfUserId={together.selfUserId}
            starterName={together.nameOf(session.started_by)}
            queueOpen={queueOpen}
            onToggleQueue={() => setQueueOpen((open) => !open)}
            showSeek={false}
            className="shrink-0"
          />
        )}
      </div>
      {phone && (
        <TogetherControls
          session={session}
          serverId={together.serverId}
          api={together.api}
          selfUserId={together.selfUserId}
          starterName={together.nameOf(session.started_by)}
          queueOpen={queueOpen}
          onToggleQueue={() => setQueueOpen((open) => !open)}
          showSeek={false}
          compact
        />
      )}
      {queueOpen && (
        <div className="max-h-64 border-t border-border-subtle pt-2 pc-enter">
          <TogetherQueue
            session={session}
            api={together.api}
            selfUserId={together.selfUserId}
            nameOf={together.nameOf}
            onAdd={() => setAdding(true)}
            className="max-h-60"
          />
        </div>
      )}
      <TogetherSheet
        anchor={anchor}
        open={adding}
        onClose={() => setAdding(false)}
        guildId={together.guildId}
        channelId={together.channelId}
        api={together.api}
        session={session}
        selfUserId={together.selfUserId}
      />
    </Raised>
  );
}

/** A thin progress line with times; seeking lives in the watch controls and the queue. */
function ListenProgress({ together }: { together: TogetherContext & { session: NonNullable<TogetherContext['session']> } }) {
  const { session } = together;
  const item = currentItem(session);
  const player = useTogetherStore((s) => s.player);
  const position = usePlaybackPosition(session, together.serverId);
  const [dragMs, setDragMs] = useState<number | null>(null);
  const duration = item?.duration_ms ?? (player.itemId === item?.id ? player.durationMs : null);
  const allowed = canControl(session, together.selfUserId);
  const shown = dragMs ?? position;
  const percent = duration ? Math.min(100, (shown / duration) * 100) : 0;
  const commit = (value: number) => {
    setDragMs(null);
    void runTogether(() => together.api.playback(session.channel_id, { action: 'seek', position_ms: Math.round(value) }));
  };
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="pc-mono shrink-0 text-meta text-text-muted">{formatPlaybackTime(shown)}</span>
      <input
        type="range"
        min={0}
        max={duration ?? 0}
        step={1000}
        value={Math.min(shown, duration ?? shown)}
        disabled={!allowed || !duration}
        aria-label="Seek"
        aria-valuetext={formatPlaybackTime(shown)}
        onChange={(event) => setDragMs(Number(event.target.value))}
        onPointerUp={(event) => commit(Number((event.target as HTMLInputElement).value))}
        onKeyUp={(event) => {
          if (dragMs != null) commit(Number((event.target as HTMLInputElement).value));
        }}
        className="h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded-full disabled:cursor-default [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-text-primary"
        style={{
          background: `linear-gradient(to right, var(--text-secondary) ${percent}%, var(--bg-mod-strong) ${percent}%)`,
        }}
      />
      <span className="pc-mono shrink-0 text-meta text-text-muted">{duration ? formatPlaybackTime(duration) : '--:--'}</span>
    </div>
  );
}
