/**
 * Noise Gate — Web Audio API based noise gate for microphone input.
 *
 * Implements the LiveKit TrackProcessor interface so it can be attached to a
 * LocalAudioTrack. When enabled, it monitors the mic level and smoothly
 * reduces gain when the user is not speaking, eliminating static hiss,
 * breathing, keyboard clicks, and other background noise.
 *
 * Parameters are tuned for voice chat (SM7B through an interface, etc).
 */

/** Noise gate configuration */
interface NoiseGateConfig {
  /** dBFS level above which the gate opens (voice detected). Default: -45 */
  openThreshold: number;
  /** dBFS level below which the gate closes. Lower than open for hysteresis. Default: -50 */
  closeThreshold: number;
  /** Time in ms to fully open the gate. Default: 5 */
  attackMs: number;
  /** Time in ms to fully close the gate after hold expires. Default: 150 */
  releaseMs: number;
  /** Time in ms to hold the gate open after level drops below close threshold. Default: 250 */
  holdMs: number;
  /** Minimum gain when gate is closed (0 = full silence). Default: 0 */
  floorGain: number;
}

const DEFAULT_CONFIG: NoiseGateConfig = {
  openThreshold: -45,
  closeThreshold: -50,
  attackMs: 5,
  releaseMs: 150,
  holdMs: 250,
  floorGain: 0,
};

type GateState = 'open' | 'hold' | 'closing' | 'closed';

export class NoiseGateProcessor {
  readonly name = 'noise-gate';
  processedTrack?: MediaStreamTrack;

  private ctx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private gain: GainNode | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private animFrame: number | null = null;
  private config: NoiseGateConfig;
  private state: GateState = 'closed';
  private holdUntil = 0;
  private lastTime = 0;
  private fftBuf: Float32Array<ArrayBuffer> | null = null;

  constructor(config?: Partial<NoiseGateConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async init(opts: { track: MediaStreamTrack }): Promise<void> {
    await this.setup(opts.track);
  }

  async restart(opts: { track: MediaStreamTrack }): Promise<void> {
    await this.teardown();
    await this.setup(opts.track);
  }

  async destroy(): Promise<void> {
    await this.teardown();
  }

  private async setup(inputTrack: MediaStreamTrack): Promise<void> {
    // Create audio context at the track's sample rate for zero-latency processing
    this.ctx = new AudioContext({
      sampleRate: inputTrack.getSettings().sampleRate || 48000,
      latencyHint: 'interactive',
    });

    const inputStream = new MediaStream([inputTrack]);
    this.source = this.ctx.createMediaStreamSource(inputStream);

    // Analyser for level detection — small FFT for fast response
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.3;
    this.fftBuf = new Float32Array(this.analyser.fftSize) as Float32Array<ArrayBuffer>;

    // Gain node — this is the actual "gate"
    this.gain = this.ctx.createGain();
    this.gain.gain.value = this.config.floorGain;

    // Destination — provides the processed MediaStreamTrack
    this.destination = this.ctx.createMediaStreamDestination();

    // Wire: source → analyser (for monitoring)
    //        source → gain → destination (for output)
    this.source.connect(this.analyser);
    this.source.connect(this.gain);
    this.gain.connect(this.destination);

    this.processedTrack = this.destination.stream.getAudioTracks()[0];

    // Start the gate monitoring loop
    this.state = 'closed';
    this.lastTime = performance.now();
    this.tick();
  }

  private tick = (): void => {
    if (!this.analyser || !this.gain || !this.ctx || !this.fftBuf) return;

    const now = performance.now();
    const dt = now - this.lastTime;
    this.lastTime = now;

    // Measure current audio level in dBFS
    this.analyser.getFloatTimeDomainData(this.fftBuf);
    let peak = 0;
    for (let i = 0; i < this.fftBuf.length; i++) {
      const abs = Math.abs(this.fftBuf[i]);
      if (abs > peak) peak = abs;
    }
    // Convert to dBFS (0 dB = full scale). Clamp to avoid -Infinity.
    const dbfs = peak > 0 ? 20 * Math.log10(peak) : -100;

    const { openThreshold, closeThreshold, attackMs, releaseMs, holdMs, floorGain } = this.config;
    const currentGain = this.gain.gain.value;

    switch (this.state) {
      case 'closed':
        if (dbfs >= openThreshold) {
          this.state = 'open';
          // Fast attack — ramp gain up
          const attackTarget = Math.min(currentGain + dt / attackMs, 1);
          this.gain.gain.value = attackTarget;
        }
        break;

      case 'open':
        if (currentGain < 1) {
          // Still opening
          const attackTarget = Math.min(currentGain + dt / attackMs, 1);
          this.gain.gain.value = attackTarget;
        }
        if (dbfs < closeThreshold) {
          // Voice stopped — enter hold period
          this.state = 'hold';
          this.holdUntil = now + holdMs;
        }
        break;

      case 'hold':
        if (dbfs >= openThreshold) {
          // Voice resumed during hold
          this.state = 'open';
        } else if (now >= this.holdUntil) {
          // Hold expired — start closing
          this.state = 'closing';
        }
        break;

      case 'closing':
        if (dbfs >= openThreshold) {
          // Voice resumed during release
          this.state = 'open';
        } else {
          // Smoothly ramp gain down
          const releaseTarget = Math.max(currentGain - dt / releaseMs, floorGain);
          this.gain.gain.value = releaseTarget;
          if (releaseTarget <= floorGain) {
            this.state = 'closed';
          }
        }
        break;
    }

    this.animFrame = requestAnimationFrame(this.tick);
  };

  private async teardown(): Promise<void> {
    if (this.animFrame !== null) {
      cancelAnimationFrame(this.animFrame);
      this.animFrame = null;
    }
    this.source?.disconnect();
    this.gain?.disconnect();
    this.analyser?.disconnect();
    this.source = null;
    this.gain = null;
    this.analyser = null;
    this.destination = null;
    this.fftBuf = null;
    this.processedTrack = undefined;
    if (this.ctx && this.ctx.state !== 'closed') {
      await this.ctx.close().catch(() => {});
    }
    this.ctx = null;
    this.state = 'closed';
  }
}
