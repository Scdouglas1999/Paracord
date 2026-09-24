/**
 * The speaking edges this client puts on the wire for its own voice.
 *
 * The local engine's speaking flag flickers with every syllable; the people
 * outside the call only need "is talking now", so the flag is debounced into
 * edges before it leaves:
 *
 *  - "started" only after {@link SPEAKING_EDGE_TIMING.startAfterMs} of continuous speech;
 *  - "stopped" only after {@link SPEAKING_EDGE_TIMING.stopAfterMs} of silence;
 *  - never more than one edge per {@link SPEAKING_EDGE_TIMING.minGapMs} on the wire (an
 *    edge due sooner waits, and one that is undone meanwhile never goes out);
 *  - "started" again every {@link SPEAKING_EDGE_TIMING.refreshMs} while still talking,
 *    because the server forgets a speaker it has not heard from in 20 s.
 *
 * A mute, a leave or a disconnect is {@link SpeakingEdges.stopNow}: no silence
 * debounce, only the wire gap.
 */

export interface SpeakingEdgeTiming {
  startAfterMs: number;
  stopAfterMs: number;
  minGapMs: number;
  refreshMs: number;
}

export const SPEAKING_EDGE_TIMING: SpeakingEdgeTiming = {
  startAfterMs: 300,
  stopAfterMs: 800,
  minGapMs: 500,
  refreshMs: 10_000,
};

type Timer = ReturnType<typeof setTimeout>;

export class SpeakingEdges {
  /** What the debounced flag says right now. */
  private desired = false;
  /** What the server was last told. */
  private reported = false;
  private raw = false;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private debounceTimer: Timer | null = null;
  private flushTimer: Timer | null = null;
  private refreshTimer: Timer | null = null;
  private disposed = false;

  constructor(
    private readonly send: (speaking: boolean) => void,
    private readonly timing: SpeakingEdgeTiming = SPEAKING_EDGE_TIMING,
  ) {}

  /** Feed the local speaking flag (already false while muted). */
  update(speaking: boolean): void {
    if (this.disposed || speaking === this.raw) return;
    this.raw = speaking;
    this.clearDebounce();
    if (speaking === this.desired) return;
    this.debounceTimer = setTimeout(
      () => {
        this.debounceTimer = null;
        this.setDesired(speaking);
      },
      speaking ? this.timing.startAfterMs : this.timing.stopAfterMs,
    );
  }

  /** Muted, left or disconnected: stop without waiting out the silence. */
  stopNow(): void {
    if (this.disposed) return;
    this.raw = false;
    this.clearDebounce();
    this.setDesired(false);
  }

  /** Whether the server currently believes we are talking. */
  get reporting(): boolean {
    return this.reported;
  }

  /** Cancel every pending edge. Nothing is sent after this. */
  dispose(): void {
    this.disposed = true;
    this.clearDebounce();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.flushTimer = null;
    this.refreshTimer = null;
  }

  private clearDebounce(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
  }

  private setDesired(speaking: boolean): void {
    this.desired = speaking;
    this.flush();
  }

  private flush(): void {
    if (this.disposed || this.flushTimer) return;
    if (this.desired === this.reported) return;
    const wait = this.lastSentAt + this.timing.minGapMs - Date.now();
    if (wait > 0) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush();
      }, wait);
      return;
    }
    this.emit(this.desired);
  }

  private emit(speaking: boolean): void {
    this.reported = speaking;
    this.lastSentAt = Date.now();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.send(speaking);
    if (speaking) this.scheduleRefresh();
  }

  private scheduleRefresh(): void {
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      if (this.disposed || !this.reported || !this.desired) return;
      this.emit(true);
    }, this.timing.refreshMs);
  }
}
