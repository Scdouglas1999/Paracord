import { cn } from '../../../lib/utils';

/**
 * The talking waveform (docs/index-spec.md §4.4): four amber bars, 2.5x12, gap
 * 2, radius 2, each `scaleY(.35 <-> 1)`.
 *
 * Drawn only while the person talks; the caller removes it when they stop, so
 * nothing loops at rest. Where this client hears the room (`real`: joined or
 * listening) the bars follow the voice: the engine writes `--voice-level` on
 * every `[data-motion-speaking="<userId>"]` (lib/motion/voiceLevel.ts) and the
 * CSS scales each bar from it. Elsewhere only "somebody is talking" is known
 * (`VOICE_SPEAKING`), and the bars run their CSS loop, ticking on the shared
 * 100ms grid. Reduced motion: static bars at mid height (ix-card.css).
 */
export function Wave({ userId, real, className }: { userId: string; real: boolean; className?: string }) {
  return (
    <span
      className={cn('ix-wave', className)}
      aria-hidden="true"
      data-real={real ? '' : undefined}
      data-motion-speaking={real ? userId : undefined}
    >
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}
