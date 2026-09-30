/**
 * An MP4 (ISO BMFF) writer for a finished H.264 clip, optionally with Opus
 * audio ("Opus in ISOBMFF"). WebM cannot carry H.264 for a browser, so this is
 * the H.264 container.
 *
 *   ftyp, moov { mvhd, trak (avc1 + avcC), trak (Opus + dOps, edit list for
 *   its start) }, mdat
 *
 * `moov` comes first so the file plays before it has fully arrived. Samples are
 * interleaved in time order, one per chunk. The encoders Paracord receives
 * from run in real-time mode without B-frames, so decode order is presentation
 * order and no `ctts` is written.
 */
import { avcDecoderConfigurationRecord, h264ParameterSets, h264ToLengthPrefixed, parseH264Sps } from './bitstream';
import type { ClipTimeline } from './clipTimeline';
import { OPUS_SAMPLE_RATE } from './opus';
import type { MuxedClip } from './webmMuxer';

const MOVIE_TIMESCALE = 1_000;
const VIDEO_TIMESCALE = 90_000;

type Parts = Uint8Array[];

function partsLength(parts: Parts): number {
  let length = 0;
  for (const part of parts) length += part.length;
  return length;
}

function fourcc(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function box(type: string, body: Parts): Parts {
  const header = new Uint8Array(8);
  new DataView(header.buffer).setUint32(0, 8 + partsLength(body));
  header.set(fourcc(type), 4);
  return [header, ...body];
}

function fullBox(type: string, version: number, flags: number, body: Parts): Parts {
  return box(type, [Uint8Array.of(version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff), ...body]);
}

/** Big-endian fields, written in order. */
class Fields {
  private readonly bytes: number[] = [];
  u8(value: number): this {
    this.bytes.push(value & 0xff);
    return this;
  }
  u16(value: number): this {
    return this.u8(value >> 8).u8(value);
  }
  i16(value: number): this {
    return this.u16(value & 0xffff);
  }
  u32(value: number): this {
    return this.u16(Math.floor(value / 0x10000) & 0xffff).u16(value & 0xffff);
  }
  i32(value: number): this {
    return this.u32(value >>> 0);
  }
  zeros(count: number): this {
    for (let i = 0; i < count; i++) this.bytes.push(0);
    return this;
  }
  raw(values: ArrayLike<number>): this {
    for (let i = 0; i < values.length; i++) this.bytes.push(values[i]);
    return this;
  }
  done(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

const UNITY_MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];
function matrix(fields: Fields): Fields {
  for (const value of UNITY_MATRIX) fields.u32(value);
  return fields;
}

/** Run-length `stts` entries from per-sample durations. */
function sttsEntries(durations: number[]): Array<[number, number]> {
  const entries: Array<[number, number]> = [];
  for (const duration of durations) {
    const last = entries[entries.length - 1];
    if (last && last[1] === duration) last[0]++;
    else entries.push([1, duration]);
  }
  return entries;
}

interface TrackSamples {
  sizes: number[];
  durations: number[];
  /** Absolute offsets in the file, one chunk per sample. */
  offsets: number[];
}

function sampleTable(sampleEntry: Parts, samples: TrackSamples, syncSamples: number[] | null): Parts {
  const stts = new Fields().u32(0); // version and flags: stts is a full box
  const runs = sttsEntries(samples.durations);
  stts.u32(runs.length);
  for (const [count, delta] of runs) stts.u32(count).u32(delta);
  const stsz = new Fields().u32(0).u32(samples.sizes.length);
  for (const size of samples.sizes) stsz.u32(size);
  const stco = new Fields().u32(samples.offsets.length);
  for (const offset of samples.offsets) stco.u32(offset);
  const children: Parts = [
    ...fullBox('stsd', 0, 0, [new Fields().u32(1).done(), ...sampleEntry]),
    ...box('stts', [stts.done()]),
  ];
  if (syncSamples) {
    const stss = new Fields().u32(syncSamples.length);
    for (const index of syncSamples) stss.u32(index);
    children.push(...fullBox('stss', 0, 0, [stss.done()]));
  }
  children.push(
    ...fullBox('stsc', 0, 0, [new Fields().u32(1).u32(1).u32(1).u32(1).done()]),
    ...fullBox('stsz', 0, 0, [stsz.done()]),
    ...fullBox('stco', 0, 0, [stco.done()]),
  );
  return box('stbl', children);
}

function dataInformation(): Parts {
  return box('dinf', fullBox('dref', 0, 0, [new Fields().u32(1).done(), ...fullBox('url ', 0, 1, [])]));
}

function mediaHeader(timescale: number, duration: number): Parts {
  return fullBox('mdhd', 0, 0, [new Fields().u32(0).u32(0).u32(timescale).u32(duration).u16(0x55c4).u16(0).done()]);
}

function handler(type: string, name: string): Parts {
  return fullBox('hdlr', 0, 0, [new Fields().u32(0).raw(fourcc(type)).zeros(12).raw(fourcc(name)).u8(0).done()]);
}

function trackHeader(trackId: number, durationMovie: number, audio: boolean, width: number, height: number): Parts {
  const fields = new Fields()
    .u32(0) // creation
    .u32(0) // modification
    .u32(trackId)
    .u32(0)
    .u32(durationMovie)
    .zeros(8)
    .u16(0) // layer
    .u16(0) // alternate group
    .u16(audio ? 0x0100 : 0) // volume
    .u16(0);
  matrix(fields);
  fields.u32(width * 0x10000).u32(height * 0x10000);
  return fullBox('tkhd', 0, 0x3, [fields.done()]);
}

export function muxMp4(timeline: ClipTimeline): MuxedClip {
  if (timeline.codec !== 'h264') throw new Error(`This MP4 writer carries H.264, not ${timeline.codec}.`);
  const first = timeline.video[0];
  if (!first?.key) throw new Error('A clip must start on a keyframe.');
  const params = h264ParameterSets(first.data);
  if (!params) throw new Error('The clip starts on an H.264 keyframe without its SPS and PPS.');
  const { width, height } = parseH264Sps(params.sps);
  const size = { width, height };
  const avcC = avcDecoderConfigurationRecord(params.sps, params.pps);

  // ---- Samples, interleaved in time order
  const videoData = timeline.video.map((frame) => h264ToLengthPrefixed(frame.data));
  const videoTicks = timeline.video.map((frame) => Math.round(frame.tMs * (VIDEO_TIMESCALE / 1000)));
  const lastVideoEnd = Math.round((timeline.video[timeline.video.length - 1].tMs + timeline.video[timeline.video.length - 1].durMs) * (VIDEO_TIMESCALE / 1000));
  const video: TrackSamples = {
    sizes: videoData.map((data) => data.length),
    durations: videoTicks.map((tick, i) => Math.max(1, (i + 1 < videoTicks.length ? videoTicks[i + 1] : lastVideoEnd) - tick)),
    offsets: videoData.map(() => 0),
  };
  const syncSamples = timeline.video.flatMap((frame, i) => (frame.key ? [i + 1] : []));
  const hasAudio = timeline.audio.length > 0 && timeline.audioChannels !== null;
  const audio: TrackSamples = {
    sizes: timeline.audio.map((packet) => packet.data.length),
    durations: timeline.audio.map((packet) => Math.round(packet.durMs * (OPUS_SAMPLE_RATE / 1000))),
    offsets: timeline.audio.map(() => 0),
  };
  const order = [
    ...timeline.video.map((frame, i) => ({ tMs: frame.tMs, track: 0, i })),
    ...(hasAudio ? timeline.audio.map((packet, i) => ({ tMs: packet.tMs, track: 1, i })) : []),
  ].sort((a, b) => a.tMs - b.tMs || a.track - b.track);

  const videoDurationTicks = video.durations.reduce((a, b) => a + b, 0);
  const audioDurationSamples = audio.durations.reduce((a, b) => a + b, 0);
  const durationMovie = Math.round(timeline.durationMs);
  const audioStartMovie = hasAudio ? Math.round(timeline.audio[0].tMs) : 0;

  const buildMoov = (): Parts => {
    const avc1 = new Fields()
      .zeros(6)
      .u16(1) // data_reference_index
      .zeros(16)
      .u16(size.width)
      .u16(size.height)
      .u32(0x00480000)
      .u32(0x00480000)
      .u32(0)
      .u16(1) // frame_count
      .zeros(32) // compressorname
      .u16(0x0018)
      .i16(-1)
      .done();
    const videoTrak = box('trak', [
      ...trackHeader(1, Math.round((videoDurationTicks * MOVIE_TIMESCALE) / VIDEO_TIMESCALE), false, size.width, size.height),
      ...box('mdia', [
        ...mediaHeader(VIDEO_TIMESCALE, videoDurationTicks),
        ...handler('vide', 'VideoHandler'),
        ...box('minf', [
          ...fullBox('vmhd', 0, 1, [new Fields().zeros(8).done()]),
          ...dataInformation(),
          ...sampleTable(box('avc1', [avc1, ...box('avcC', [avcC])]), video, syncSamples),
        ]),
      ]),
    ]);
    const traks: Parts = [...videoTrak];
    if (hasAudio && timeline.audioChannels) {
      const opusEntry = new Fields()
        .zeros(6)
        .u16(1) // data_reference_index
        .zeros(8)
        .u16(timeline.audioChannels)
        .u16(16) // samplesize
        .u16(0)
        .u16(0)
        .u32(OPUS_SAMPLE_RATE * 0x10000)
        .done();
      const dOps = new Fields().u8(0).u8(timeline.audioChannels).u16(0).u32(OPUS_SAMPLE_RATE).i16(0).u8(0).done();
      const audioDurationMovie = Math.round((audioDurationSamples * MOVIE_TIMESCALE) / OPUS_SAMPLE_RATE);
      const edits = new Fields();
      const entries: Array<[number, number]> = [];
      if (audioStartMovie > 0) entries.push([audioStartMovie, -1]);
      entries.push([audioDurationMovie, 0]);
      edits.u32(entries.length);
      for (const [segmentDuration, mediaTime] of entries) edits.u32(segmentDuration).i32(mediaTime).u16(1).u16(0);
      traks.push(
        ...box('trak', [
          ...trackHeader(2, audioStartMovie + audioDurationMovie, true, 0, 0),
          ...box('edts', fullBox('elst', 0, 0, [edits.done()])),
          ...box('mdia', [
            ...mediaHeader(OPUS_SAMPLE_RATE, audioDurationSamples),
            ...handler('soun', 'SoundHandler'),
            ...box('minf', [
              ...fullBox('smhd', 0, 0, [new Fields().u16(0).u16(0).done()]),
              ...dataInformation(),
              ...sampleTable(box('Opus', [opusEntry, ...box('dOps', [dOps])]), audio, null),
            ]),
          ]),
        ]),
      );
    }
    const mvhd = new Fields().u32(0).u32(0).u32(MOVIE_TIMESCALE).u32(durationMovie).u32(0x00010000).u16(0x0100).zeros(10);
    matrix(mvhd);
    mvhd.zeros(24).u32(hasAudio ? 3 : 2);
    return box('moov', [...fullBox('mvhd', 0, 0, [mvhd.done()]), ...traks]);
  };

  const ftyp = box('ftyp', [fourcc('isom'), new Fields().u32(0x200).done(), fourcc('isom'), fourcc('iso2'), fourcc('avc1'), fourcc('mp41')]);
  // The moov's size does not depend on the offsets (stco entries are fixed
  // width): size it once, then write it again with the real offsets.
  const moovLength = partsLength(buildMoov());
  const mdatPayload: Parts = [];
  let at = partsLength(ftyp) + moovLength + 8;
  for (const entry of order) {
    const data = entry.track === 0 ? videoData[entry.i] : timeline.audio[entry.i].data;
    (entry.track === 0 ? video : audio).offsets[entry.i] = at;
    mdatPayload.push(data);
    at += data.length;
  }
  if (at > 0xffffffff) throw new Error('The clip is too large for this MP4 writer.');
  const moov = buildMoov();
  if (partsLength(moov) !== moovLength) throw new Error('The MP4 index changed size while it was written.');
  const parts = [...ftyp, ...moov, ...box('mdat', mdatPayload)];
  return {
    parts,
    byteLength: partsLength(parts),
    mimeType: 'video/mp4',
    codecs: hasAudio ? `avc1.${hex(params.sps[1])}${hex(params.sps[2])}${hex(params.sps[3])},opus` : `avc1.${hex(params.sps[1])}${hex(params.sps[2])}${hex(params.sps[3])}`,
    extension: 'mp4',
    size,
  };
}

function hex(value: number): string {
  return value.toString(16).padStart(2, '0');
}
