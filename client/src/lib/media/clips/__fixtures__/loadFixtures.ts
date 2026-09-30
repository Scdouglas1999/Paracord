/**
 * Test fixtures: real encoded frames, made once with ffmpeg (160×90, 10 fps,
 * 3 s, a keyframe every 10 frames; Opus in 20 ms packets):
 *
 *   ffmpeg -f lavfi -i testsrc2=size=160x90:rate=10 -t 3 -c:v libvpx-vp9 -g 10 -keyint_min 10 \
 *     -lag-in-frames 0 -auto-alt-ref 0 -deadline realtime -cpu-used 8 -b:v 80k -f ivf vp9.ivf
 *   ffmpeg … -c:v libaom-av1 -usage realtime -cpu-used 8 -lag-in-frames 0 -g 10 -keyint_min 10 -b:v 80k -f ivf av1.ivf
 *   ffmpeg … -c:v libx264 -profile:v high -bf 0 -g 10 -keyint_min 10 -sc_threshold 0 \
 *     -x264-params aud=1:repeat-headers=1 -pix_fmt yuv420p -b:v 80k -f h264 h264.h264
 *   ffmpeg … -t 1 -c:v libx264 -profile:v baseline -bf 0 -g 5 -sc_threshold 0 \
 *     -x264-params aud=1:repeat-headers=1 -vf scale=128:72 -pix_fmt yuv420p -f h264 h264-small.h264
 *   ffmpeg -f lavfi -i sine=frequency=440:duration=3 -c:a libopus -b:a 24k -frame_duration 20 -ac 1 opus-mono.ogg
 *   ffmpeg -f lavfi -i sine=frequency=440:duration=3 -c:a libopus -b:a 32k -frame_duration 20 -ac 2 opus-stereo.ogg
 *
 * These mirror what reaches the decoder intake: IVF frames are whole temporal
 * units, and the H.264 access units are Annex B with SPS/PPS repeated on every
 * IDR (what WebCodecs' `annexb` output carries).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { av1SequenceHeaderObu, h264NalType, splitAnnexB } from '../bitstream';

const HERE = join(process.cwd(), 'src/lib/media/clips/__fixtures__');

export interface FixtureFrame {
  data: Uint8Array;
  key: boolean;
}

function read(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(HERE, name)));
}

function ivfFrames(bytes: Uint8Array): Uint8Array[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint16(6, true);
  const frames: Uint8Array[] = [];
  let at = headerLength;
  while (at + 12 <= bytes.length) {
    const size = view.getUint32(at, true);
    frames.push(bytes.slice(at + 12, at + 12 + size));
    at += 12 + size;
  }
  return frames;
}

export function vp9Frames(): FixtureFrame[] {
  // Profile 0: frame_marker (2 bits), profile (2), show_existing_frame (1), frame_type (1, 0 = key).
  return ivfFrames(read('vp9.ivf')).map((data) => ({ data, key: data[0] >> 6 === 2 && (data[0] & 0x0c) === 0 }));
}

export function av1Frames(): FixtureFrame[] {
  return ivfFrames(read('av1.ivf')).map((data) => ({ data, key: av1SequenceHeaderObu(data) !== null }));
}

function annexBAccessUnits(bytes: Uint8Array): FixtureFrame[] {
  // Every access unit starts with an AUD; regroup the NAL units at each one.
  const units = splitAnnexB(bytes);
  const frames: Uint8Array[][] = [];
  for (const unit of units) {
    if (h264NalType(unit) === 9 || frames.length === 0) frames.push([]);
    frames[frames.length - 1].push(unit);
  }
  return frames.map((group) => {
    const length = group.reduce((sum, unit) => sum + 4 + unit.length, 0);
    const data = new Uint8Array(length);
    let at = 0;
    for (const unit of group) {
      data.set([0, 0, 0, 1], at);
      data.set(unit, at + 4);
      at += 4 + unit.length;
    }
    return { data, key: group.some((unit) => h264NalType(unit) === 5) };
  });
}

export function h264Frames(): FixtureFrame[] {
  return annexBAccessUnits(read('h264.h264'));
}

export function h264SmallFrames(): FixtureFrame[] {
  return annexBAccessUnits(read('h264-small.h264'));
}

/** Opus packets from an Ogg Opus file, the two header packets skipped. */
function oggOpusPackets(bytes: Uint8Array): Uint8Array[] {
  const packets: Uint8Array[] = [];
  let pending: number[] = [];
  let at = 0;
  while (at + 27 <= bytes.length) {
    if (bytes[at] !== 0x4f || bytes[at + 1] !== 0x67 || bytes[at + 2] !== 0x67 || bytes[at + 3] !== 0x53) throw new Error('Not an Ogg page.');
    const segments = bytes[at + 26];
    const table = bytes.subarray(at + 27, at + 27 + segments);
    let body = at + 27 + segments;
    for (const lacing of table) {
      for (let i = 0; i < lacing; i++) pending.push(bytes[body + i]);
      body += lacing;
      if (lacing < 255) {
        packets.push(Uint8Array.from(pending));
        pending = [];
      }
    }
    at = body;
  }
  return packets.slice(2); // OpusHead, OpusTags
}

export function opusMonoPackets(): Uint8Array[] {
  return oggOpusPackets(read('opus-mono.ogg'));
}

export function opusStereoPackets(): Uint8Array[] {
  return oggOpusPackets(read('opus-stereo.ogg'));
}
