/**
 * The clip ring buffer (docs/glass-spec.md §6.4): the encoded stream this
 * client is already receiving, kept for the last 30 seconds so a clip can be
 * cut without touching the stream.
 *
 * What it holds: every decrypted encoded video frame of the watched screen
 * share, as whole groups of pictures (a keyframe and the deltas that follow
 * it), and the share's own Opus packets. It keeps the newest keyframe that
 * arrived at or before now − 30 s and everything after it, so any cut can start
 * on a keyframe and still cover 30 seconds.
 *
 * The memory budget is {@link CLIP_BUFFER_MAX_BYTES} (64 MiB), enough for 30 s
 * plus one GOP at about 16 Mbit/s. Past it the oldest GOP goes first, so a very
 * heavy stream keeps a shorter clip rather than more memory; the clip then says
 * how long it really is. A single GOP larger than the whole budget is dropped
 * and the ring waits for the next keyframe.
 *
 * Arrival times are this client's clock (`performance.now()` in the browser,
 * the native session's monotonic clock on the desktop). Sender timestamps are
 * kept as they came, for `clipTimeline` to smooth the arrival jitter out.
 *
 * The desktop app keeps the same ring in Rust (`native_media/clip_buffer.rs`)
 * with the same rules and constants; `nativeClipSource.ts` reads it back into
 * a {@link ClipCapture}.
 */

export type ClipCodec = 'vp9' | 'av1' | 'h264';

export const CLIP_WINDOW_MS = 30_000;
export const CLIP_BUFFER_MAX_BYTES = 64 * 1024 * 1024;
/** Audio kept from before the oldest video frame, to cover audio/video skew. */
export const CLIP_AUDIO_LEAD_MS = 1_000;
/** A sequence jump larger than this (about a minute of 20 ms packets) is a new audio stream. */
const AUDIO_RESTART_SEQ_GAP = 3_000;

export interface ClipVideoFrame {
  /** When the frame reached the decoder intake, on this client's clock (ms). */
  arrivalMs: number;
  /** The publisher's capture timestamp (µs, the publisher's clock). */
  senderUs: number;
  key: boolean;
  data: Uint8Array;
}

export interface ClipAudioPacket {
  arrivalMs: number;
  /** Packet sequence number, unwrapped to keep counting past 65535. */
  seq: number;
  data: Uint8Array;
}

/** A copy of what the ring held at `nowMs`: the input to a clip. */
export interface ClipCapture {
  codec: ClipCodec | null;
  video: ClipVideoFrame[];
  audio: ClipAudioPacket[];
  nowMs: number;
}

interface Gop {
  frames: ClipVideoFrame[];
  bytes: number;
}

export interface ClipRingOptions {
  windowMs?: number;
  maxBytes?: number;
}

export class ClipRing {
  private readonly windowMs: number;
  private readonly maxBytes: number;
  private gops: Gop[] = [];
  private audio: ClipAudioPacket[] = [];
  private videoBytes = 0;
  private audioBytes = 0;
  private codec: ClipCodec | null = null;
  private needKeyframe = true;
  private lastSenderUs = -Infinity;
  private lastSeq: number | null = null;
  private newestArrivalMs = -Infinity;

  constructor(options: ClipRingOptions = {}) {
    this.windowMs = options.windowMs ?? CLIP_WINDOW_MS;
    this.maxBytes = options.maxBytes ?? CLIP_BUFFER_MAX_BYTES;
  }

  get bytes(): number {
    return this.videoBytes + this.audioBytes;
  }

  /** Frames held, for tests and diagnostics. */
  get videoFrameCount(): number {
    return this.gops.reduce((sum, gop) => sum + gop.frames.length, 0);
  }

  get audioPacketCount(): number {
    return this.audio.length;
  }

  /** Something a clip can start from: at least one keyframe. */
  get hasVideo(): boolean {
    return this.gops.length > 0;
  }

  /**
   * Drop deltas until the next keyframe, keeping what is held. For a stream
   * that moved to another connection: its first frames there start a new
   * decode chain, and a delta before that keyframe would not follow on.
   */
  requireKeyframe(): void {
    this.needKeyframe = true;
  }

  reset(): void {
    this.gops = [];
    this.audio = [];
    this.videoBytes = 0;
    this.audioBytes = 0;
    this.codec = null;
    this.needKeyframe = true;
    this.lastSenderUs = -Infinity;
    this.lastSeq = null;
    this.newestArrivalMs = -Infinity;
  }

  pushVideo(frame: ClipVideoFrame & { codec: ClipCodec }): void {
    const { codec, ...entry } = frame;
    if (entry.key) {
      // A new codec, or a sender clock that went back (the share restarted),
      // starts a new stream: nothing before it can be muxed with it.
      if ((this.codec !== null && codec !== this.codec) || entry.senderUs < this.lastSenderUs) {
        this.resetVideo();
      }
      this.codec = codec;
      this.needKeyframe = false;
      this.gops.push({ frames: [entry], bytes: entry.data.length });
    } else {
      if (this.needKeyframe || this.gops.length === 0 || codec !== this.codec) return;
      if (entry.senderUs < this.lastSenderUs) return; // older than what the chain already holds
      const gop = this.gops[this.gops.length - 1];
      gop.frames.push(entry);
      gop.bytes += entry.data.length;
    }
    this.lastSenderUs = entry.senderUs;
    this.videoBytes += entry.data.length;
    this.advance(entry.arrivalMs);
  }

  pushAudio(packet: { arrivalMs: number; seq16: number; data: Uint8Array }): void {
    if (packet.data.length === 0) return;
    let seq: number;
    if (this.lastSeq === null) {
      seq = packet.seq16;
    } else {
      const delta = ((((packet.seq16 - this.lastSeq) & 0xffff) + 0x8000) & 0xffff) - 0x8000;
      if (Math.abs(delta) > AUDIO_RESTART_SEQ_GAP) {
        this.audio = [];
        this.audioBytes = 0;
        seq = packet.seq16;
      } else {
        seq = this.lastSeq + delta;
      }
    }
    // Keep sequence order; a late packet slots in, a duplicate is dropped.
    let at = this.audio.length;
    while (at > 0 && this.audio[at - 1].seq > seq) at--;
    if (at > 0 && this.audio[at - 1].seq === seq) return;
    this.audio.splice(at, 0, { arrivalMs: packet.arrivalMs, seq, data: packet.data });
    this.audioBytes += packet.data.length;
    if (this.lastSeq === null || seq > this.lastSeq) this.lastSeq = seq;
    this.advance(packet.arrivalMs);
  }

  /** What a clip cut now would be made from. The arrays are copies; the frames are shared. */
  snapshot(nowMs: number): ClipCapture {
    this.advance(nowMs);
    return {
      codec: this.gops.length > 0 ? this.codec : null,
      video: this.gops.flatMap((gop) => gop.frames),
      audio: this.audio.slice(),
      nowMs,
    };
  }

  private resetVideo(): void {
    this.gops = [];
    this.videoBytes = 0;
    this.lastSenderUs = -Infinity;
  }

  private advance(arrivalMs: number): void {
    if (arrivalMs > this.newestArrivalMs) this.newestArrivalMs = arrivalMs;
    this.prune(this.newestArrivalMs);
  }

  private dropOldestGop(): void {
    const gop = this.gops.shift();
    if (gop) this.videoBytes -= gop.bytes;
  }

  private prune(nowMs: number): void {
    const horizon = nowMs - this.windowMs;
    // Keep the newest keyframe at or before the horizon; drop the GOPs before it.
    while (this.gops.length >= 2 && this.gops[1].frames[0].arrivalMs <= horizon) this.dropOldestGop();
    while (this.bytes > this.maxBytes && this.gops.length >= 2) this.dropOldestGop();
    if (this.bytes > this.maxBytes && this.gops.length === 1) {
      this.resetVideo();
      this.needKeyframe = true;
    }
    const audioFrom =
      (this.gops.length > 0 ? this.gops[0].frames[0].arrivalMs : horizon) - CLIP_AUDIO_LEAD_MS;
    let drop = 0;
    while (drop < this.audio.length && this.audio[drop].arrivalMs < audioFrom) {
      this.audioBytes -= this.audio[drop].data.length;
      drop++;
    }
    if (drop > 0) this.audio.splice(0, drop);
    // Audio alone past the budget (no video to trade against): oldest first.
    while (this.bytes > this.maxBytes && this.audio.length > 0) {
      this.audioBytes -= this.audio[0].data.length;
      this.audio.shift();
    }
  }
}
