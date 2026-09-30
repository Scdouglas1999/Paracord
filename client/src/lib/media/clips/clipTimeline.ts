/**
 * From a ring snapshot to a presentation timeline: which frames make the clip,
 * and when each one plays.
 *
 * - **Window.** The clip starts at the newest keyframe at or before
 *   `now − 30 s` (or the oldest keyframe held, when less is held) and runs to
 *   the newest frame. So it covers the last 30 seconds whenever the ring does,
 *   plus the part of a GOP before the window that a decoder needs.
 * - **Clock.** Arrival times carry network jitter, sender timestamps do not
 *   but are on the publisher's clock. Video plays at `senderMs + offset` and
 *   audio at `sequence × packet length + offset`, each offset being the
 *   smallest `arrival − sender` seen in the clip: the stream's own spacing,
 *   placed on this client's clock where it arrived fastest. Audio and video then
 *   line up as they did live, to within the difference of their fastest paths.
 * - **Lost audio** becomes lost-packet markers, which a decoder conceals, so
 *   the audio track stays continuous and in step.
 */
import type { ClipAudioPacket, ClipCapture, ClipCodec, ClipVideoFrame } from './clipRing';
import { CLIP_WINDOW_MS } from './clipRing';
import { opusLostPacket, opusPacketDurationMs, opusPacketIsStereo } from './opus';

export interface TimedVideoFrame {
  /** Presentation time from the clip's start (ms). */
  tMs: number;
  /** How long the frame shows (ms). */
  durMs: number;
  key: boolean;
  data: Uint8Array;
}

export interface TimedAudioPacket {
  tMs: number;
  durMs: number;
  data: Uint8Array;
  /** A stand-in for a packet that never arrived. */
  lost: boolean;
}

export interface ClipTimeline {
  codec: ClipCodec;
  video: TimedVideoFrame[];
  audio: TimedAudioPacket[];
  audioChannels: 1 | 2 | null;
  /** From the first frame to the end of the last (ms). */
  durationMs: number;
  /** When the clip was cut, as a wall clock time (ms since the epoch). */
  cutAt: number;
}

/** A frame length used only when a clip holds a single video frame. */
const SINGLE_FRAME_MS = 1000 / 30;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** The frames a clip cut at `nowMs` is made of, starting on a keyframe. */
export function selectClipFrames(video: readonly ClipVideoFrame[], nowMs: number, windowMs = CLIP_WINDOW_MS): ClipVideoFrame[] {
  const horizon = nowMs - windowMs;
  let start = -1;
  for (let i = 0; i < video.length; i++) {
    if (!video[i].key) continue;
    if (start === -1 || video[i].arrivalMs <= horizon) start = i;
    if (video[i].arrivalMs > horizon) break;
  }
  return start === -1 ? [] : video.slice(start);
}

export function buildClipTimeline(capture: ClipCapture, options: { windowMs?: number; cutAt?: number } = {}): ClipTimeline {
  if (!capture.codec) throw new Error('Nothing from this stream has arrived yet.');
  const frames = selectClipFrames(capture.video, capture.nowMs, options.windowMs);
  if (frames.length === 0) throw new Error('Nothing from this stream has arrived yet.');

  // Video: sender spacing, placed where it arrived fastest.
  let videoOffset = Infinity;
  for (const frame of frames) videoOffset = Math.min(videoOffset, frame.arrivalMs - frame.senderUs / 1000);
  const localTimes: number[] = [];
  let previous = -Infinity;
  for (const frame of frames) {
    // Never let two frames share a time, or run backwards.
    const t = Math.max(frame.senderUs / 1000 + videoOffset, previous + 1);
    localTimes.push(t);
    previous = t;
  }
  const start = localTimes[0];
  const gaps = localTimes.slice(1).map((t, i) => t - localTimes[i]);
  const lastFrameMs = gaps.length > 0 ? median(gaps) : SINGLE_FRAME_MS;
  const video: TimedVideoFrame[] = frames.map((frame, i) => ({
    tMs: localTimes[i] - start,
    durMs: i + 1 < frames.length ? localTimes[i + 1] - localTimes[i] : lastFrameMs,
    key: frame.key,
    data: frame.data,
  }));
  let durationMs = video[video.length - 1].tMs + video[video.length - 1].durMs;

  const audio = timeAudio(capture.audio, start);
  let audioChannels: 1 | 2 | null = null;
  if (audio.length > 0) {
    audioChannels = audio.some((packet) => !packet.lost && opusPacketIsStereo(packet.data)) ? 2 : 1;
    const last = audio[audio.length - 1];
    durationMs = Math.max(durationMs, last.tMs + last.durMs);
  }

  return { codec: capture.codec, video, audio, audioChannels, durationMs, cutAt: options.cutAt ?? Date.now() };
}

/**
 * A packet that arrived this much later than its sequence spacing says starts
 * a new audio segment: the publisher paused its stream audio (sequence numbers
 * do not advance while it sends nothing), or the network stalled. Each segment
 * is placed on the clock by its own fastest packet, which is right for both.
 */
const AUDIO_SEGMENT_BREAK_MS = 400;

interface SequencedAudio {
  rel: number;
  dur: number;
  data: Uint8Array;
  lost: boolean;
  arrivalMs: number | null;
}

/** Audio on the clip's clock, from its first video frame on: continuous, lost packets filled. */
function timeAudio(packets: readonly ClipAudioPacket[], clipStartMs: number): TimedAudioPacket[] {
  if (packets.length === 0) return [];
  // Sequence time: each packet starts where the previous one ended; a missing
  // sequence number lasts as long as the packet before it.
  const segments: SequencedAudio[][] = [];
  let segment: SequencedAudio[] = [];
  let rel = 0;
  let lastReal: SequencedAudio | null = null;
  for (let i = 0; i < packets.length; i++) {
    const packet = packets[i];
    if (i > 0) {
      const previous = packets[i - 1];
      for (let missing = previous.seq + 1; missing < packet.seq; missing++) {
        const like = segment[segment.length - 1];
        segment.push({ rel, dur: like.dur, data: opusLostPacket(like.data), lost: true, arrivalMs: null });
        rel += like.dur;
      }
    }
    const dur = opusPacketDurationMs(packet.data);
    if (lastReal && lastReal.arrivalMs !== null && packet.arrivalMs - lastReal.arrivalMs - (rel - lastReal.rel) > AUDIO_SEGMENT_BREAK_MS) {
      segments.push(segment);
      segment = [];
    }
    const entry: SequencedAudio = { rel, dur, data: packet.data, lost: false, arrivalMs: packet.arrivalMs };
    segment.push(entry);
    lastReal = entry;
    rel += dur;
  }
  segments.push(segment);

  const placed: Array<SequencedAudio & { t: number }> = [];
  for (const entries of segments) {
    let offset = Infinity;
    for (const entry of entries) {
      if (entry.arrivalMs !== null) offset = Math.min(offset, entry.arrivalMs - entry.rel);
    }
    for (const entry of entries) placed.push({ ...entry, t: entry.rel + offset - clipStartMs });
  }

  // One continuous track: each packet where the previous one ended. A packet
  // that would overlap the one before by more than half its length is dropped;
  // a gap is filled with lost-packet markers, which a decoder conceals.
  const timed: TimedAudioPacket[] = [];
  for (const entry of placed) {
    if (entry.t < 0) continue; // before the clip's first picture
    if (timed.length === 0) {
      if (entry.lost) continue; // a clip never starts on a lost packet
      timed.push({ tMs: entry.t, durMs: entry.dur, data: entry.data, lost: false });
      continue;
    }
    const last = timed[timed.length - 1];
    let expected = last.tMs + last.durMs;
    if (entry.t < expected - entry.dur / 2) continue;
    while (entry.t >= expected + entry.dur / 2) {
      const filler = timed[timed.length - 1];
      timed.push({ tMs: expected, durMs: filler.durMs, data: opusLostPacket(filler.data), lost: true });
      expected += filler.durMs;
    }
    timed.push({ tMs: expected, durMs: entry.dur, data: entry.data, lost: entry.lost });
  }
  return timed;
}
