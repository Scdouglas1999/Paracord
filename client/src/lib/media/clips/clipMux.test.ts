import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { av1SequenceHeaderObu, parseAv1SequenceHeader, parseH264Sps, splitAnnexB, vp9KeyframeSize } from './bitstream';
import type { ClipCodec } from './clipRing';
import { muxClip } from './clipMux';
import type { ClipTimeline } from './clipTimeline';
import { vintSize } from './webmMuxer';
import { av1Frames, h264Frames, h264SmallFrames, opusMonoPackets, opusStereoPackets, vp9Frames, type FixtureFrame } from './__fixtures__/loadFixtures';
import { ebmlChild, ebmlChildren, ebmlFloat, ebmlString, ebmlUint, mp4Path, readEbml, readMp4, u32 } from './__fixtures__/readContainers';

/** Fixtures are 10 fps: a frame every 100 ms. */
function timeline(codec: ClipCodec, frames: FixtureFrame[], opus: Uint8Array[] | null, options: { audioStartMs?: number } = {}): ClipTimeline {
  const video = frames.map((frame, i) => ({ tMs: i * 100, durMs: 100, key: frame.key, data: frame.data }));
  const audioStart = options.audioStartMs ?? 0;
  const audio = (opus ?? []).map((data, i) => ({ tMs: audioStart + i * 20, durMs: 20, data, lost: false }));
  const end = Math.max(frames.length * 100, audio.length ? audioStart + audio.length * 20 : 0);
  return { codec, video, audio, audioChannels: opus ? ((opus[0][0] & 0x04) ? 2 : 1) : null, durationMs: end, cutAt: 0 };
}

async function bytesOf(parts: Uint8Array[]): Promise<Uint8Array> {
  return new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer());
}

/** `CLIP_MUX_OUT=/some/dir npx vitest run clipMux` writes the files, for ffprobe and a browser. */
function dump(name: string, bytes: Uint8Array): void {
  const dir = process.env.CLIP_MUX_OUT;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), bytes);
}

describe('bitstream', () => {
  it('reads the picture size of each codec', () => {
    expect(vp9KeyframeSize(vp9Frames()[0].data)).toEqual({ width: 160, height: 90 });
    const header = av1SequenceHeaderObu(av1Frames()[0].data)!;
    expect(parseAv1SequenceHeader(header)).toMatchObject({ width: 160, height: 90, seqProfile: 0 });
    const sps = splitAnnexB(h264Frames()[0].data).find((unit) => (unit[0] & 0x1f) === 7)!;
    expect(parseH264Sps(sps)).toMatchObject({ width: 160, height: 90, profileIdc: 100 });
  });

  it('refuses a delta frame as a VP9 keyframe', () => {
    expect(() => vp9KeyframeSize(vp9Frames()[1].data)).toThrow();
  });

  it('writes EBML sizes in the fewest bytes, avoiding the reserved all-ones value', () => {
    expect([...vintSize(0)]).toEqual([0x80]);
    expect([...vintSize(126)]).toEqual([0xfe]);
    expect([...vintSize(127)]).toEqual([0x40, 0x7f]);
    expect([...vintSize(5, 8)]).toEqual([0x01, 0, 0, 0, 0, 0, 0, 5]);
  });
});

describe.each([
  ['vp9', vp9Frames, opusMonoPackets, 'V_VP9', 1],
  ['av1', av1Frames, opusStereoPackets, 'V_AV1', 2],
] as const)('WebM (%s + Opus)', (codec, frames, opus, codecId, channels) => {
  it('writes a parseable file with the right duration, tracks, blocks and cues', async () => {
    const input = frames();
    const packets = opus();
    const { muxed } = muxClip(timeline(codec, input, packets));
    expect(muxed.mimeType).toBe('video/webm');
    const bytes = await bytesOf(muxed.parts);
    expect(bytes.length).toBe(muxed.byteLength);
    dump(`clip-${codec}.webm`, bytes);

    const [ebml, segment, ...rest] = readEbml(bytes);
    expect(rest).toHaveLength(0);
    expect(ebmlString(ebmlChild(ebml, 0x4282)!)).toBe('webm');
    const info = ebmlChild(segment, 0x1549a966)!;
    expect(ebmlUint(ebmlChild(info, 0x2ad7b1)!)).toBe(1_000_000);
    const duration = ebmlFloat(ebmlChild(info, 0x4489)!);
    expect(duration).toBe(Math.max(input.length * 100, packets.length * 20));
    expect(duration).toBeGreaterThanOrEqual(3_000);

    const entries = ebmlChildren(ebmlChild(segment, 0x1654ae6b)!, 0xae);
    expect(entries.map((e) => ebmlString(ebmlChild(e, 0x86)!))).toEqual([codecId, 'A_OPUS']);
    const videoEl = ebmlChild(entries[0], 0xe0)!;
    expect([ebmlUint(ebmlChild(videoEl, 0xb0)!), ebmlUint(ebmlChild(videoEl, 0xba)!)]).toEqual([160, 90]);
    if (codec === 'av1') {
      const av1C = ebmlChild(entries[0], 0x63a2)!.data;
      expect(av1C[0]).toBe(0x81);
      expect(av1C.length).toBeGreaterThan(4); // carries the sequence header OBU
    }
    const opusHead = ebmlChild(entries[1], 0x63a2)!.data;
    expect(new TextDecoder().decode(opusHead.subarray(0, 8))).toBe('OpusHead');
    expect(opusHead[9]).toBe(channels);

    const clusters = ebmlChildren(segment, 0x1f43b675);
    const blocks = clusters.flatMap((cluster) => {
      const base = ebmlUint(ebmlChild(cluster, 0xe7)!);
      return ebmlChildren(cluster, 0xa3).map((block) => ({
        track: block.data[0] & 0x7f,
        t: base + new DataView(block.data.buffer, block.data.byteOffset + 1, 2).getInt16(0),
        key: (block.data[3] & 0x80) !== 0,
        size: block.size - 4,
      }));
    });
    const videoBlocks = blocks.filter((b) => b.track === 1);
    const audioBlocks = blocks.filter((b) => b.track === 2);
    expect(videoBlocks).toHaveLength(input.length);
    expect(audioBlocks).toHaveLength(packets.length);
    expect(videoBlocks.map((b) => b.key)).toEqual(input.map((f) => f.key));
    expect(videoBlocks.map((b) => b.t)).toEqual(input.map((_, i) => i * 100));
    // Blocks never go back in time.
    for (let i = 1; i < blocks.length; i++) expect(blocks[i].t).toBeGreaterThanOrEqual(blocks[i - 1].t);
    // One cluster per keyframe, each cued at its real position.
    const keyCount = input.filter((f) => f.key).length;
    expect(clusters).toHaveLength(keyCount);
    const cuePoints = ebmlChildren(ebmlChild(segment, 0x1c53bb6b)!, 0xbb);
    expect(cuePoints).toHaveLength(keyCount);
    cuePoints.forEach((cue, i) => {
      const position = ebmlUint(ebmlChild(ebmlChild(cue, 0xb7)!, 0xf1)!);
      expect(segment.dataStart + position).toBe(clusters[i].start);
      expect(ebmlUint(ebmlChild(cue, 0xb3)!)).toBe(ebmlUint(ebmlChild(clusters[i], 0xe7)!));
    });
    // The seek head points at Info, Tracks and Cues.
    const seeks = ebmlChildren(ebmlChild(segment, 0x114d9b74)!, 0x4dbb).map((seek) => segment.dataStart + ebmlUint(ebmlChild(seek, 0x53ac)!));
    expect(seeks).toEqual([info.start, ebmlChild(segment, 0x1654ae6b)!.start, ebmlChild(segment, 0x1c53bb6b)!.start]);
  });

  it('writes a video-only file when the stream has no audio', async () => {
    const { muxed } = muxClip(timeline(codec, frames(), null));
    const [, segment] = readEbml(await bytesOf(muxed.parts));
    expect(ebmlChildren(ebmlChild(segment, 0x1654ae6b)!, 0xae)).toHaveLength(1);
    expect(muxed.codecs).toBe(codec === 'av1' ? 'av01' : 'vp9');
  });
});

describe('MP4 (H.264 + Opus)', () => {
  it('writes a parseable file: moov first, sample tables matching the frames, offsets into mdat', async () => {
    const input = h264Frames();
    const packets = opusMonoPackets();
    const { muxed } = muxClip(timeline('h264', input, packets, { audioStartMs: 40 }));
    expect(muxed.mimeType).toBe('video/mp4');
    const bytes = await bytesOf(muxed.parts);
    dump('clip-h264.mp4', bytes);
    const boxes = readMp4(bytes);
    expect(boxes.map((b) => b.type)).toEqual(['ftyp', 'moov', 'mdat']);

    const mvhd = mp4Path(boxes, 'moov/mvhd')!;
    expect(u32(mvhd.body, 12)).toBe(1_000); // timescale
    expect(u32(mvhd.body, 16)).toBe(Math.max(3_000, 40 + packets.length * 20)); // duration

    const [videoTrak, audioTrak] = mp4Path(boxes, 'moov')!.children!.filter((b) => b.type === 'trak');
    const vstbl = mp4Path(videoTrak.children!, 'mdia/minf/stbl')!;
    const stsd = vstbl.children!.find((b) => b.type === 'stsd')!;
    expect(new TextDecoder().decode(stsd.body.subarray(12, 16))).toBe('avc1');
    const avc1 = stsd.body.subarray(8);
    expect([new DataView(avc1.buffer, avc1.byteOffset).getUint16(32), new DataView(avc1.buffer, avc1.byteOffset).getUint16(34)]).toEqual([160, 90]);
    expect(new TextDecoder().decode(avc1.subarray(8 + 78 + 4, 8 + 78 + 8))).toBe('avcC');
    const stsz = vstbl.children!.find((b) => b.type === 'stsz')!;
    expect(u32(stsz.body, 8)).toBe(input.length);
    const stss = vstbl.children!.find((b) => b.type === 'stss')!;
    const syncs = Array.from({ length: u32(stss.body, 4) }, (_, i) => u32(stss.body, 8 + i * 4));
    expect(syncs).toEqual(input.flatMap((f, i) => (f.key ? [i + 1] : [])));
    const stts = vstbl.children!.find((b) => b.type === 'stts')!;
    expect([u32(stts.body, 4), u32(stts.body, 8), u32(stts.body, 12)]).toEqual([1, input.length, 9_000]);

    // Every chunk offset lands inside mdat, on a length-prefixed NAL unit of the right size.
    const mdat = boxes[2];
    const stco = vstbl.children!.find((b) => b.type === 'stco')!;
    for (let i = 0; i < input.length; i++) {
      const offset = u32(stco.body, 8 + i * 4);
      const size = u32(stsz.body, 12 + i * 4);
      expect(offset).toBeGreaterThanOrEqual(mdat.start + 8);
      expect(offset + size).toBeLessThanOrEqual(mdat.start + mdat.size);
      const firstNal = u32(bytes, offset);
      expect(firstNal).toBeLessThanOrEqual(size - 4);
      expect([5, 1, 6]).toContain(bytes[offset + 4] & 0x1f); // IDR, slice or SEI; no SPS/PPS/AUD in band
    }

    // Opus track: dOps, one 960-sample run, and an edit list that starts it 40 ms in.
    const astbl = mp4Path(audioTrak.children!, 'mdia/minf/stbl')!;
    const astsd = astbl.children!.find((b) => b.type === 'stsd')!;
    expect(new TextDecoder().decode(astsd.body.subarray(12, 16))).toBe('Opus');
    const astts = astbl.children!.find((b) => b.type === 'stts')!;
    expect([u32(astts.body, 4), u32(astts.body, 8), u32(astts.body, 12)]).toEqual([1, packets.length, 960]);
    const elst = mp4Path(audioTrak.children!, 'edts')!.children!.find((b) => b.type === 'elst')!;
    expect(u32(elst.body, 4)).toBe(2);
    expect([u32(elst.body, 8), u32(elst.body, 12) | 0]).toEqual([40, -1]);
  });

  it('starts a clip that spans a change of SPS at the keyframe where it changed', async () => {
    const big = h264Frames();
    const small = h264SmallFrames();
    const joined = [...big, ...small];
    const { muxed, timeline: span } = muxClip(timeline('h264', joined, null));
    expect(span.video).toHaveLength(small.length);
    expect(span.video[0].tMs).toBe(0);
    expect(muxed.size).toEqual({ width: 128, height: 72 });
    const boxes = readMp4(await bytesOf(muxed.parts));
    const stsz = mp4Path(boxes, 'moov/trak/mdia/minf/stbl/stsz')!;
    expect(u32(stsz.body, 8)).toBe(small.length);
  });
});
