/**
 * A clip's container follows its codec: WebM for VP9 and AV1 (with Opus), MP4
 * for H.264 (with Opus). Nothing is transcoded; the frames are the ones that
 * arrived.
 */
import { av1SequenceHeaderObu, bytesEqual, concatBytes, h264ParameterSets } from './bitstream';
import type { ClipTimeline } from './clipTimeline';
import { muxMp4 } from './mp4Muxer';
import { muxWebm, type MuxedClip } from './webmMuxer';

export type { MuxedClip } from './webmMuxer';

/** What a keyframe's decoder configuration is, for codecs whose container records it once. */
function keyframeConfig(codec: ClipTimeline['codec'], data: Uint8Array): Uint8Array | null {
  if (codec === 'av1') return av1SequenceHeaderObu(data);
  if (codec === 'h264') {
    const params = h264ParameterSets(data);
    return params ? concatBytes([params.sps, params.pps]) : null;
  }
  return null; // VP9 codes its size in every keyframe; WebM needs nothing else.
}

/**
 * The part of a timeline one container configuration can describe. AV1 in
 * WebM and H.264 in MP4 record the decoder configuration once, so a clip that
 * spans a change (a new sequence header or SPS, e.g. the sharer changed
 * resolution) starts at the keyframe where the last change took effect. The
 * clip then says how long it really is.
 */
export function lastConfigurationSpan(timeline: ClipTimeline): ClipTimeline {
  if (timeline.codec === 'vp9') return timeline;
  let startIndex = 0;
  let current: Uint8Array | null = null;
  timeline.video.forEach((frame, i) => {
    if (!frame.key) return;
    const config = keyframeConfig(timeline.codec, frame.data);
    if (!config) {
      if (i === 0) throw new Error(`The clip starts on a ${timeline.codec.toUpperCase()} keyframe without its decoder configuration.`);
      return; // a keyframe that repeats no configuration keeps the current one
    }
    if (current && !bytesEqual(config, current)) startIndex = i;
    current = config;
  });
  if (startIndex === 0) return timeline;
  const start = timeline.video[startIndex].tMs;
  const video = timeline.video.slice(startIndex).map((frame) => ({ ...frame, tMs: frame.tMs - start }));
  const audio = timeline.audio.filter((packet) => packet.tMs >= start).map((packet) => ({ ...packet, tMs: packet.tMs - start }));
  while (audio.length > 0 && audio[0].lost) audio.shift();
  return { ...timeline, video, audio, durationMs: timeline.durationMs - start };
}

export function muxClip(timeline: ClipTimeline): { muxed: MuxedClip; timeline: ClipTimeline } {
  const span = lastConfigurationSpan(timeline);
  const muxed = span.codec === 'h264' ? muxMp4(span) : muxWebm(span);
  return { muxed, timeline: span };
}
