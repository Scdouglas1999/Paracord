import { useEffect, useState, type CSSProperties } from 'react';
import { ListMusic, Lock, Pause, Play, SkipForward, Square, Volume2, VolumeX } from 'lucide-react';

import { togetherErrorMessage, type TogetherApi } from '../../../api/together';
import {
  canControl,
  currentItem,
  expectedPositionMs,
  formatPlaybackTime,
  type TogetherSession,
} from '../../../lib/together/model';
import { serverNowMs } from '../../../lib/together/serverClock';
import { cn } from '../../../lib/utils';
import { toast } from '../../../stores/toastStore';
import { useTogetherStore } from '../../../stores/togetherStore';
import { IconButton, Tooltip } from '../../ui';

/** The server's position for the playing item, re-read four times a second. */
export function usePlaybackPosition(session: TogetherSession, serverId: string): number {
  const [now, setNow] = useState(() => serverNowMs(serverId));
  useEffect(() => {
    setNow(serverNowMs(serverId));
    if (!session.playing) return;
    const timer = window.setInterval(() => setNow(serverNowMs(serverId)), 250);
    return () => window.clearInterval(timer);
  }, [session.playing, session.revision, serverId]);
  return expectedPositionMs(session, now);
}

export async function runTogether(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    toast.error(togetherErrorMessage(error));
  }
}

const RANGE =
  'h-1.5 w-full cursor-pointer appearance-none rounded-full disabled:cursor-default ' +
  '[&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:appearance-none ' +
  '[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-text-primary ' +
  '[&::-webkit-slider-thumb]:shadow-[var(--shadow-chip)] [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:w-3.5 ' +
  '[&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-text-primary';

function trackFill(fraction: number): CSSProperties {
  const percent = `${Math.round(Math.min(1, Math.max(0, fraction)) * 1000) / 10}%`;
  return {
    background: `linear-gradient(to right, var(--text-secondary) ${percent}, var(--bg-mod-strong) ${percent})`,
  };
}

export interface TogetherControlsProps {
  session: TogetherSession;
  serverId: string;
  api: TogetherApi;
  selfUserId: string | null;
  starterName: string;
  queueOpen: boolean;
  onToggleQueue: () => void;
  /** Phone and the now-playing bar: fewer words, same controls. */
  compact?: boolean;
  /** Show the seek bar in this row (the listen bar draws its own progress). */
  showSeek?: boolean;
  className?: string;
}

/**
 * Shared controls: play/pause, the seek bar with times, your own volume, the
 * queue, and "Stop for everyone". Everyone in the call sees the same position;
 * only the person who started it can use them when they are locked.
 */
export function TogetherControls({
  session,
  serverId,
  api,
  selfUserId,
  starterName,
  queueOpen,
  onToggleQueue,
  compact = false,
  showSeek = true,
  className,
}: TogetherControlsProps) {
  const item = currentItem(session);
  const player = useTogetherStore((s) => s.player);
  const volume = useTogetherStore((s) => s.volume);
  const setVolume = useTogetherStore((s) => s.setVolume);
  const position = usePlaybackPosition(session, serverId);
  const [dragMs, setDragMs] = useState<number | null>(null);
  const allowed = canControl(session, selfUserId);
  const duration = item?.duration_ms ?? (player.itemId === item?.id ? player.durationMs : null);
  const shown = dragMs ?? position;
  const channelId = session.channel_id;
  const hasNext = session.current_index + 1 < session.items.length;
  const locked = !allowed;

  const commitSeek = (ms: number) => {
    setDragMs(null);
    void runTogether(() => api.playback(channelId, { action: 'seek', position_ms: Math.round(ms) }));
  };

  const seekBar = showSeek && (
    <div className="flex min-w-0 items-center gap-2.5 px-1">
      <span className="pc-mono min-w-9 shrink-0 text-right text-meta text-text-secondary">{formatPlaybackTime(shown)}</span>
      <input
        type="range"
        min={0}
        max={duration ?? 0}
        step={1000}
        value={Math.min(shown, duration ?? shown)}
        disabled={!allowed || !duration || !item}
        aria-label="Seek"
        aria-valuetext={formatPlaybackTime(shown)}
        onChange={(event) => setDragMs(Number(event.target.value))}
        onPointerUp={(event) => commitSeek(Number((event.target as HTMLInputElement).value))}
        onKeyUp={(event) => {
          if (dragMs != null) commitSeek(Number((event.target as HTMLInputElement).value));
        }}
        className={RANGE}
        style={trackFill(duration ? shown / duration : 0)}
      />
      <span className="pc-mono min-w-9 shrink-0 text-meta text-text-muted">{duration ? formatPlaybackTime(duration) : '--:--'}</span>
    </div>
  );

  const buttons = (
    <div className={cn('flex min-w-0 items-center gap-2', !showSeek && className)} role="group" aria-label="Shared playback controls">
      <Tooltip content={session.playing ? 'Pause for everyone' : 'Play for everyone'} side="top">
        <IconButton
          label={session.playing ? 'Pause for everyone' : 'Play for everyone'}
          tone="raised"
          size={compact ? 'md' : 'lg'}
          disabled={locked || !item}
          onClick={() => void runTogether(() => api.playback(channelId, { action: session.playing ? 'pause' : 'play' }))}
        >
          {session.playing ? <Pause size={18} /> : <Play size={18} />}
        </IconButton>
      </Tooltip>
      <Tooltip content="Next in the queue" side="top">
        <IconButton
          label="Skip to the next item"
          tone="ghost"
          size="md"
          disabled={locked || !hasNext}
          onClick={() => void runTogether(() => api.playback(channelId, { action: 'skip' }))}
        >
          <SkipForward size={17} />
        </IconButton>
      </Tooltip>
      <span className="min-w-0 flex-1" />
      {!compact && (
        <div className="flex w-32 shrink-0 items-center gap-1.5">
          <IconButton
            label={volume === 0 ? 'Unmute shared playback for you' : 'Mute shared playback for you'}
            tone="ghost"
            size="sm"
            onClick={() => setVolume(volume === 0 ? 0.8 : 0)}
          >
            {volume === 0 ? <VolumeX size={15} /> : <Volume2 size={15} />}
          </IconButton>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            aria-label="Your volume"
            title={`Your volume: ${Math.round(volume * 100)}%`}
            onChange={(event) => setVolume(Number(event.target.value))}
            className={RANGE}
            style={trackFill(volume)}
          />
        </div>
      )}
      {locked && !compact && (
        <Tooltip content={`Only ${starterName} can control this`} side="top">
          <span className="flex shrink-0 items-center gap-1 text-meta text-text-muted">
            <Lock size={13} aria-hidden />
            <span className="sr-only">{`Only ${starterName} can control this`}</span>
          </span>
        </Tooltip>
      )}
      <Tooltip content={queueOpen ? 'Hide the queue' : 'Show the queue'} side="top">
        <IconButton
          label={queueOpen ? 'Hide the queue' : `Show the queue (${session.items.length})`}
          tone="ghost"
          size="md"
          active={queueOpen}
          onClick={onToggleQueue}
        >
          <ListMusic size={17} />
        </IconButton>
      </Tooltip>
      <Tooltip content="Stop for everyone" side="top">
        <IconButton
          label="Stop for everyone"
          tone="ghost"
          size="md"
          disabled={locked}
          onClick={() => void runTogether(() => api.stop(channelId))}
        >
          <Square size={15} />
        </IconButton>
      </Tooltip>
    </div>
  );

  if (!showSeek) return buttons;
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      {seekBar}
      {buttons}
    </div>
  );
}
