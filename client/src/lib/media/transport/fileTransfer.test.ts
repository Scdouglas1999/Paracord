import { describe, expect, it, vi } from 'vitest';
import { QUICFileUploader, type UploadTokenResponse } from './fileTransfer';

const token: UploadTokenResponse = {
  transfer_id: 'transfer-1', upload_token: 'scoped-token', quic_endpoint: 'https://example.test', quic_available: true,
};
const file = {
  name: 'test.txt', size: 4,
  slice: (start: number, end: number) => ({ arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).slice(start, end).buffer }),
} as File;

function control(message: Record<string, unknown>): Uint8Array {
  const data = new TextEncoder().encode(JSON.stringify(message));
  const frame = new Uint8Array(5 + data.length);
  new DataView(frame.buffer).setUint32(1, data.length, false);
  frame.set(data, 5);
  return frame;
}

function transportWith(responses: Uint8Array[]) {
  const cancel = vi.fn();
  const abort = vi.fn();
  const write = vi.fn();
  const readable = new ReadableStream<Uint8Array>({
    start(controller) { responses.forEach((response) => controller.enqueue(response)); },
    cancel,
  });
  const writable = new WritableStream<Uint8Array>({ write, abort });
  return { transport: { createBidirectionalStream: async () => ({ readable, writable }) } as WebTransport, cancel, abort, write };
}

describe('QUIC file upload response boundaries', () => {
  it.each([0, -1, 0.5, '1024', null, 512 * 1024 + 1])('rejects invalid chunk size %s before reading the file', async (chunk_size) => {
    const peer = transportWith([control({ type: 'file_transfer_accept', transfer_id: token.transfer_id, chunk_size, offset: 0 })]);
    await expect(new QUICFileUploader().upload(peer.transport, token, file)).rejects.toThrow('chunk size');
    expect(peer.write).toHaveBeenCalledTimes(1);
    expect(peer.cancel).toHaveBeenCalled();
    expect(peer.abort).toHaveBeenCalled();
  });

  it.each([-1, 0.5, 5, '0'])('rejects invalid resume offset %s', async (offset) => {
    const peer = transportWith([control({ type: 'file_transfer_accept', transfer_id: token.transfer_id, chunk_size: 1024, offset })]);
    await expect(new QUICFileUploader().upload(peer.transport, token, file)).rejects.toThrow('resume offset');
  });

  it('rejects an oversized frame from its header without waiting for its body', async () => {
    const frame = new Uint8Array([0, 0xff, 0xff, 0xff, 0xff]);
    const peer = transportWith([frame]);
    await expect(new QUICFileUploader().upload(peer.transport, token, file)).rejects.toThrow('frame is too large');
    expect(peer.cancel).toHaveBeenCalled();
  });

  it('rejects a response for a different transfer', async () => {
    const peer = transportWith([control({ type: 'file_transfer_accept', transfer_id: 'other', chunk_size: 1024, offset: 0 })]);
    await expect(new QUICFileUploader().upload(peer.transport, token, file)).rejects.toThrow('ID mismatch');
  });

  it('uploads normally with fragmented responses and progress acknowledgments', async () => {
    const accept = control({ type: 'file_transfer_accept', transfer_id: token.transfer_id, chunk_size: 2, offset: 0 });
    const peer = transportWith([
      accept.slice(0, 3), accept.slice(3),
      control({ type: 'file_transfer_progress', transfer_id: token.transfer_id, bytes_received: 4 }),
      control({ type: 'file_transfer_done', transfer_id: token.transfer_id, attachment_id: 'attachment-1', url: '/file' }),
    ]);
    const result = await new QUICFileUploader().upload(peer.transport, token, file);
    expect(result).toEqual({ id: 'attachment-1', filename: 'test.txt', size: 4, url: '/file' });
    expect(peer.write).toHaveBeenCalledTimes(4);
    expect(peer.abort).not.toHaveBeenCalled();
  });
  it('returns authoritative stored filename and content type', async () => {
    const peer = transportWith([
      control({ type: 'file_transfer_accept', transfer_id: token.transfer_id, chunk_size: 4, offset: 0 }),
      control({ type: 'file_transfer_done', transfer_id: token.transfer_id, attachment_id: 'attachment-1', url: '/file',
        attachment: { filename: 'opaque.bin', content_type: 'application/octet-stream' } }),
    ]);
    expect(await new QUICFileUploader().upload(peer.transport, token, file)).toEqual({
      id: 'attachment-1', filename: 'opaque.bin', content_type: 'application/octet-stream', size: 4, url: '/file',
    });
  });

});
