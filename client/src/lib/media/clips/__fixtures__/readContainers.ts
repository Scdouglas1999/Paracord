/**
 * Independent readers for the containers the clip muxers write, so the tests
 * check the bytes as a demuxer would see them rather than trusting the writer.
 */

export interface EbmlElement {
  id: number;
  start: number;
  dataStart: number;
  size: number;
  children?: EbmlElement[];
  data: Uint8Array;
}

const MASTER = new Set([
  0x1a45dfa3, 0x18538067, 0x114d9b74, 0x4dbb, 0x1549a966, 0x1654ae6b, 0xae, 0xe0, 0xe1, 0x1f43b675, 0x1c53bb6b, 0xbb, 0xb7,
]);

function readVint(bytes: Uint8Array, at: number, keepMarker: boolean): { value: number; length: number } {
  const first = bytes[at];
  let length = 1;
  while (length <= 8 && (first & (0x80 >> (length - 1))) === 0) length++;
  if (length > 8) throw new Error(`Bad vint at ${at}`);
  let value = keepMarker ? first : first & (0xff >> length);
  for (let i = 1; i < length; i++) value = value * 256 + bytes[at + i];
  return { value, length };
}

export function readEbml(bytes: Uint8Array, start = 0, end = bytes.length): EbmlElement[] {
  const out: EbmlElement[] = [];
  let at = start;
  while (at < end) {
    const id = readVint(bytes, at, true);
    const size = readVint(bytes, at + id.length, false);
    const dataStart = at + id.length + size.length;
    const dataEnd = dataStart + size.value;
    if (dataEnd > end) throw new Error(`Element 0x${id.value.toString(16)} at ${at} runs past its parent`);
    const element: EbmlElement = { id: id.value, start: at, dataStart, size: size.value, data: bytes.subarray(dataStart, dataEnd) };
    if (MASTER.has(id.value)) element.children = readEbml(bytes, dataStart, dataEnd);
    out.push(element);
    at = dataEnd;
  }
  return out;
}

export function ebmlChild(parent: EbmlElement | EbmlElement[], id: number): EbmlElement | undefined {
  const list = Array.isArray(parent) ? parent : parent.children ?? [];
  return list.find((element) => element.id === id);
}

export function ebmlChildren(parent: EbmlElement, id: number): EbmlElement[] {
  return (parent.children ?? []).filter((element) => element.id === id);
}

export function ebmlUint(element: EbmlElement): number {
  let value = 0;
  for (const byte of element.data) value = value * 256 + byte;
  return value;
}

export function ebmlFloat(element: EbmlElement): number {
  const view = new DataView(element.data.buffer, element.data.byteOffset, element.data.byteLength);
  return element.size === 4 ? view.getFloat32(0) : view.getFloat64(0);
}

export function ebmlString(element: EbmlElement): string {
  return new TextDecoder().decode(element.data);
}

export interface Mp4Box {
  type: string;
  start: number;
  size: number;
  body: Uint8Array;
  children?: Mp4Box[];
}

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf', 'edts']);

export function readMp4(bytes: Uint8Array, start = 0, end = bytes.length): Mp4Box[] {
  const boxes: Mp4Box[] = [];
  let at = start;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (at + 8 <= end) {
    const size = view.getUint32(at);
    const type = new TextDecoder().decode(bytes.subarray(at + 4, at + 8));
    if (size < 8 || at + size > end) throw new Error(`Box ${type} at ${at} has a bad size ${size}`);
    const box: Mp4Box = { type, start: at, size, body: bytes.subarray(at + 8, at + size) };
    if (CONTAINERS.has(type)) box.children = readMp4(bytes, at + 8, at + size);
    boxes.push(box);
    at += size;
  }
  if (at !== end) throw new Error(`Trailing bytes after the last box (${end - at})`);
  return boxes;
}

export function mp4Path(boxes: Mp4Box[], path: string): Mp4Box | undefined {
  let list = boxes;
  let found: Mp4Box | undefined;
  for (const type of path.split('/')) {
    found = list.find((box) => box.type === type);
    if (!found) return undefined;
    list = found.children ?? [];
  }
  return found;
}

export function u32(bytes: Uint8Array, at: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at);
}
