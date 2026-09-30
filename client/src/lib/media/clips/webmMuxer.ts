/**
 * A WebM (Matroska) writer for a finished clip: VP9 or AV1 video, optionally
 * Opus audio, all frames known up front. It writes what a player needs to play
 * and seek a local file, and nothing else:
 *
 *   EBML header, Segment { SeekHead, Info (with Duration), Tracks,
 *   Cluster × n (SimpleBlocks, a new cluster at each video keyframe), Cues }
 *
 * The output is a list of byte parts, so a 30 MB clip is never copied into one
 * buffer before it becomes a Blob.
 */
import { av1CodecConfigurationRecord, av1SequenceHeaderObu, av1WithoutTemporalDelimiters, type PictureSize, vp9KeyframeSize, parseAv1SequenceHeader } from './bitstream';
import type { ClipTimeline } from './clipTimeline';
import { opusHead } from './opus';

const ID = {
  EBML: 0x1a45dfa3,
  EBMLVersion: 0x4286,
  EBMLReadVersion: 0x42f7,
  EBMLMaxIDLength: 0x42f2,
  EBMLMaxSizeLength: 0x42f3,
  DocType: 0x4282,
  DocTypeVersion: 0x4287,
  DocTypeReadVersion: 0x4285,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Info: 0x1549a966,
  TimestampScale: 0x2ad7b1,
  Duration: 0x4489,
  MuxingApp: 0x4d80,
  WritingApp: 0x5741,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackUID: 0x73c5,
  TrackType: 0x83,
  FlagLacing: 0x9c,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  CodecDelay: 0x56aa,
  SeekPreRoll: 0x56bb,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,
  Cluster: 0x1f43b675,
  Timestamp: 0xe7,
  SimpleBlock: 0xa3,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
} as const;

const VIDEO_TRACK = 1;
const AUDIO_TRACK = 2;
/** A cluster's blocks are timed relative to it in a signed 16-bit field. */
const MAX_CLUSTER_SPAN_MS = 30_000;

type Parts = Uint8Array[];

function partsLength(parts: Parts): number {
  let length = 0;
  for (const part of parts) length += part.length;
  return length;
}

function idBytes(id: number): Uint8Array {
  if (id >= 0x1000000) return Uint8Array.of(id >>> 24, (id >> 16) & 0xff, (id >> 8) & 0xff, id & 0xff);
  if (id >= 0x10000) return Uint8Array.of(id >> 16, (id >> 8) & 0xff, id & 0xff);
  if (id >= 0x100) return Uint8Array.of(id >> 8, id & 0xff);
  return Uint8Array.of(id);
}

/** An EBML variable-length size, in the fewest bytes (or exactly `width`). */
export function vintSize(size: number, width?: number): Uint8Array {
  let length = 1;
  while (size >= 2 ** (7 * length) - 1) length++;
  if (width !== undefined) {
    if (width < length) throw new Error('An EBML size does not fit its width.');
    length = width;
  }
  if (length > 8) throw new Error('An EBML size is too large.');
  const out = new Uint8Array(length);
  let value = size;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = value % 256;
    value = Math.floor(value / 256);
  }
  out[0] |= 0x80 >> (length - 1);
  return out;
}

function element(id: number, body: Parts, sizeWidth?: number): Parts {
  return [idBytes(id), vintSize(partsLength(body), sizeWidth), ...body];
}

function uintBytes(value: number, width?: number): Uint8Array {
  let length = 1;
  while (length < 8 && value >= 2 ** (8 * length)) length++;
  if (width !== undefined) length = width;
  const out = new Uint8Array(length);
  let rest = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  return out;
}

const uint = (id: number, value: number, width?: number): Parts => element(id, [uintBytes(value, width)]);
const text = (id: number, value: string): Parts => element(id, [new TextEncoder().encode(value)]);
const binary = (id: number, value: Uint8Array): Parts => element(id, [value]);
function float64(id: number, value: number): Parts {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value);
  return element(id, [bytes]);
}

export interface MuxedClip {
  parts: Uint8Array[];
  byteLength: number;
  /** The file's type, without parameters: the server serves exactly `video/webm` and `video/mp4` inline. */
  mimeType: 'video/webm' | 'video/mp4';
  /** The RFC 6381 codecs, for `canPlayType`. */
  codecs: string;
  extension: 'webm' | 'mp4';
  size: PictureSize;
}

function pictureSize(timeline: ClipTimeline): PictureSize {
  const key = timeline.video[0];
  if (timeline.codec === 'vp9') return vp9KeyframeSize(key.data);
  const header = av1SequenceHeaderObu(key.data);
  if (!header) throw new Error('The clip starts on an AV1 keyframe without a sequence header.');
  const { width, height } = parseAv1SequenceHeader(header);
  return { width, height };
}

interface Block {
  track: number;
  tMs: number;
  key: boolean;
  data: Uint8Array;
}

export function muxWebm(timeline: ClipTimeline): MuxedClip {
  if (timeline.codec !== 'vp9' && timeline.codec !== 'av1') throw new Error(`WebM does not carry ${timeline.codec}.`);
  if (timeline.video.length === 0 || !timeline.video[0].key) throw new Error('A clip must start on a keyframe.');
  const size = pictureSize(timeline);
  const av1 = timeline.codec === 'av1';

  // ---- Tracks
  const videoEntry: Parts = [
    ...uint(ID.TrackNumber, VIDEO_TRACK),
    ...uint(ID.TrackUID, VIDEO_TRACK),
    ...uint(ID.TrackType, 1),
    ...uint(ID.FlagLacing, 0),
    ...text(ID.CodecID, av1 ? 'V_AV1' : 'V_VP9'),
  ];
  if (av1) {
    const header = av1SequenceHeaderObu(timeline.video[0].data);
    if (!header) throw new Error('The clip starts on an AV1 keyframe without a sequence header.');
    videoEntry.push(...binary(ID.CodecPrivate, av1CodecConfigurationRecord(header)));
  }
  videoEntry.push(...element(ID.Video, [...uint(ID.PixelWidth, size.width), ...uint(ID.PixelHeight, size.height)]));
  const trackEntries: Parts = element(ID.TrackEntry, videoEntry);
  if (timeline.audio.length > 0 && timeline.audioChannels) {
    trackEntries.push(
      ...element(ID.TrackEntry, [
        ...uint(ID.TrackNumber, AUDIO_TRACK),
        ...uint(ID.TrackUID, AUDIO_TRACK),
        ...uint(ID.TrackType, 2),
        ...uint(ID.FlagLacing, 0),
        ...text(ID.CodecID, 'A_OPUS'),
        ...binary(ID.CodecPrivate, opusHead(timeline.audioChannels)),
        ...uint(ID.CodecDelay, 0),
        ...uint(ID.SeekPreRoll, 80_000_000),
        ...element(ID.Audio, [...float64(ID.SamplingFrequency, 48_000), ...uint(ID.Channels, timeline.audioChannels)]),
      ]),
    );
  }
  const tracks = element(ID.Tracks, trackEntries);

  // ---- Info
  const info = element(ID.Info, [
    ...uint(ID.TimestampScale, 1_000_000), // 1 ms
    ...float64(ID.Duration, timeline.durationMs),
    ...text(ID.MuxingApp, 'Paracord'),
    ...text(ID.WritingApp, 'Paracord'),
  ]);

  // ---- Blocks, in time order (video first at a tie, so a cluster opens on its keyframe)
  const blocks: Block[] = [
    ...timeline.video.map((frame) => ({
      track: VIDEO_TRACK,
      tMs: Math.round(frame.tMs),
      key: frame.key,
      data: av1 ? av1WithoutTemporalDelimiters(frame.data) : frame.data,
    })),
    ...timeline.audio.map((packet) => ({ track: AUDIO_TRACK, tMs: Math.round(packet.tMs), key: true, data: packet.data })),
  ].sort((a, b) => a.tMs - b.tMs || a.track - b.track);

  // ---- Clusters
  const clusters: Array<{ parts: Parts; tMs: number; opensOnKeyframe: boolean }> = [];
  let current: { tMs: number; body: Parts; opensOnKeyframe: boolean } | null = null;
  const closeCluster = () => {
    if (current) clusters.push({ parts: element(ID.Cluster, current.body), tMs: current.tMs, opensOnKeyframe: current.opensOnKeyframe });
    current = null;
  };
  for (const block of blocks) {
    const videoKey = block.track === VIDEO_TRACK && block.key;
    if (!current || videoKey || block.tMs - current.tMs > MAX_CLUSTER_SPAN_MS) {
      closeCluster();
      current = { tMs: block.tMs, body: uint(ID.Timestamp, block.tMs), opensOnKeyframe: videoKey };
    }
    const header = new Uint8Array(4);
    header[0] = 0x80 | block.track; // track number as a 1-byte vint
    new DataView(header.buffer).setInt16(1, block.tMs - current.tMs);
    header[3] = block.key ? 0x80 : 0x00;
    current.body.push(...element(ID.SimpleBlock, [header, block.data]));
  }
  closeCluster();

  // ---- Layout: SeekHead (fixed width), Info, Tracks, Clusters, Cues
  const seekEntry = (id: number, position: number): Parts =>
    element(ID.Seek, [...binary(ID.SeekID, idBytes(id)), ...uint(ID.SeekPosition, position, 8)]);
  const seekHeadFor = (positions: { info: number; tracks: number; cues: number }) =>
    element(ID.SeekHead, [
      ...seekEntry(ID.Info, positions.info),
      ...seekEntry(ID.Tracks, positions.tracks),
      ...seekEntry(ID.Cues, positions.cues),
    ]);
  const seekHeadLength = partsLength(seekHeadFor({ info: 0, tracks: 0, cues: 0 }));
  const infoAt = seekHeadLength;
  const tracksAt = infoAt + partsLength(info);
  let at = tracksAt + partsLength(tracks);
  const cuePoints: Parts = [];
  for (const cluster of clusters) {
    if (cluster.opensOnKeyframe) {
      cuePoints.push(
        ...element(ID.CuePoint, [
          ...uint(ID.CueTime, cluster.tMs),
          ...element(ID.CueTrackPositions, [...uint(ID.CueTrack, VIDEO_TRACK), ...uint(ID.CueClusterPosition, at, 8)]),
        ]),
      );
    }
    at += partsLength(cluster.parts);
  }
  const cues = element(ID.Cues, cuePoints);
  const segmentBody: Parts = [
    ...seekHeadFor({ info: infoAt, tracks: tracksAt, cues: at }),
    ...info,
    ...tracks,
    ...clusters.flatMap((cluster) => cluster.parts),
    ...cues,
  ];

  const header = element(ID.EBML, [
    ...uint(ID.EBMLVersion, 1),
    ...uint(ID.EBMLReadVersion, 1),
    ...uint(ID.EBMLMaxIDLength, 4),
    ...uint(ID.EBMLMaxSizeLength, 8),
    ...text(ID.DocType, 'webm'),
    ...uint(ID.DocTypeVersion, 4),
    ...uint(ID.DocTypeReadVersion, 2),
  ]);
  const parts = [...header, ...element(ID.Segment, segmentBody, 8)];
  const codecs = timeline.audio.length > 0 ? `${av1 ? 'av01' : 'vp9'},opus` : av1 ? 'av01' : 'vp9';
  return {
    parts,
    byteLength: partsLength(parts),
    mimeType: 'video/webm',
    codecs,
    extension: 'webm',
    size,
  };
}
