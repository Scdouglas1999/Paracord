/**
 * QUIC file transfer over WebTransport bidirectional streams.
 *
 * Provides QUICFileUploader and QUICFileDownloader classes that handle
 * the binary-framed file transfer protocol.
 */

// -- Frame encoding/decoding ------------------------------------------------

const FRAME_TYPE_CONTROL = 0x00;
const FRAME_TYPE_DATA = 0x01;
const FRAME_TYPE_END = 0x02;

const DEFAULT_CHUNK_SIZE = 256 * 1024; // 256 KiB

interface ControlMessage {
  type: string;
  [key: string]: unknown;
}

function encodeControlFrame(msg: ControlMessage): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(msg));
  const frame = new Uint8Array(1 + 4 + json.length);
  frame[0] = FRAME_TYPE_CONTROL;
  new DataView(frame.buffer).setUint32(1, json.length, false);
  frame.set(json, 5);
  return frame;
}

function encodeDataFrame(data: Uint8Array): Uint8Array {
  const frame = new Uint8Array(1 + 4 + data.length);
  frame[0] = FRAME_TYPE_DATA;
  new DataView(frame.buffer).setUint32(1, data.length, false);
  frame.set(data, 5);
  return frame;
}

function encodeEndFrame(): Uint8Array {
  return new Uint8Array([FRAME_TYPE_END]);
}

interface DecodedFrame {
  type: 'control' | 'data' | 'end';
  control?: ControlMessage;
  data?: Uint8Array;
  consumed: number;
}

function decodeFrame(buf: Uint8Array): DecodedFrame | null {
  if (buf.length === 0) return null;

  const frameType = buf[0];

  switch (frameType) {
    case FRAME_TYPE_CONTROL: {
      if (buf.length < 5) return null;
      const len = new DataView(buf.buffer, buf.byteOffset).getUint32(1, false);
      const total = 1 + 4 + len;
      if (buf.length < total) return null;
      const json = new TextDecoder().decode(buf.slice(5, total));
      const msg = JSON.parse(json) as ControlMessage;
      return { type: 'control', control: msg, consumed: total };
    }
    case FRAME_TYPE_DATA: {
      if (buf.length < 5) return null;
      const len = new DataView(buf.buffer, buf.byteOffset).getUint32(1, false);
      const total = 1 + 4 + len;
      if (buf.length < total) return null;
      return { type: 'data', data: buf.slice(5, total), consumed: total };
    }
    case FRAME_TYPE_END:
      return { type: 'end', consumed: 1 };
    default:
      throw new Error(`Unknown frame type: 0x${frameType.toString(16)}`);
  }
}

/** Buffered frame decoder for streaming reads. */
class FrameDecoder {
  private buffer = new Uint8Array(0);

  feed(data: Uint8Array): void {
    const combined = new Uint8Array(this.buffer.length + data.length);
    combined.set(this.buffer);
    combined.set(data, this.buffer.length);
    this.buffer = combined;
  }

  next(): DecodedFrame | null {
    const frame = decodeFrame(this.buffer);
    if (frame) {
      this.buffer = this.buffer.slice(frame.consumed);
    }
    return frame;
  }
}

// -- Upload token types -----------------------------------------------------

export interface UploadTokenResponse {
  transfer_id: string;
  upload_token: string;
  quic_endpoint: string;
  quic_available: boolean;
}

export interface UploadResult {
  id: string;
  filename: string;
  size: number;
  content_type?: string;
  url: string;
}

export interface DownloadResult {
  data: Blob;
  filename: string;
  contentType: string;
}

export type ProgressCallback = (bytesTransferred: number, totalBytes: number) => void;

// -- QUIC File Uploader -----------------------------------------------------

export class QUICFileUploader {
  private aborted = false;

  /**
   * Upload a file over a WebTransport bidirectional stream.
   */
  async upload(
    transport: WebTransport,
    token: UploadTokenResponse,
    file: File,
    onProgress?: ProgressCallback,
  ): Promise<UploadResult> {
    const stream = await transport.createBidirectionalStream();
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    const decoder = new FrameDecoder();

    try {
      // 1. Send FileTransferInit
      const initMsg: ControlMessage = {
        type: 'file_transfer_init',
        transfer_id: token.transfer_id,
        upload_token: token.upload_token,
      };
      await writer.write(encodeControlFrame(initMsg));

      // 2. Wait for FileTransferAccept
      const acceptMsg = await this.readNextControl(reader, decoder);
      if (acceptMsg.type === 'file_transfer_reject') {
        throw new Error(`Upload rejected: ${acceptMsg.reason}`);
      }
      if (acceptMsg.type !== 'file_transfer_accept') {
        throw new Error(`Unexpected message: ${acceptMsg.type}`);
      }

      const chunkSize = (acceptMsg.chunk_size as number) || DEFAULT_CHUNK_SIZE;
      const offset = (acceptMsg.offset as number) || 0;

      // 3. Send file data in chunks
      const totalSize = file.size;
      let bytesSent = offset;

      while (bytesSent < totalSize && !this.aborted) {
        const end = Math.min(bytesSent + chunkSize, totalSize);
        const slice = file.slice(bytesSent, end);
        const chunk = new Uint8Array(await slice.arrayBuffer());
        await writer.write(encodeDataFrame(chunk));
        bytesSent += chunk.length;
        onProgress?.(bytesSent, totalSize);
      }

      if (this.aborted) {
        const cancelMsg: ControlMessage = {
          type: 'file_transfer_cancel',
          transfer_id: token.transfer_id,
        };
        await writer.write(encodeControlFrame(cancelMsg));
        throw new Error('Upload cancelled');
      }

      // 4. Send EndOfData
      await writer.write(encodeEndFrame());

      // 5. Wait for FileTransferDone
      const doneMsg = await this.readNextControl(reader, decoder);
      if (doneMsg.type === 'file_transfer_error') {
        throw new Error(`Upload error: ${doneMsg.message}`);
      }
      if (doneMsg.type !== 'file_transfer_done') {
        throw new Error(`Unexpected message: ${doneMsg.type}`);
      }

      return {
        id: (doneMsg.attachment_id as string) || token.transfer_id,
        filename: file.name,
        size: file.size,
        url: (doneMsg.url as string) || '',
      };
    } finally {
      try { writer.releaseLock(); } catch { /* ignore */ }
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
  }

  /** Cancel an in-progress upload. */
  cancel(): void {
    this.aborted = true;
  }

  private async readNextControl(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    decoder: FrameDecoder,
  ): Promise<ControlMessage> {
    while (true) {
      const frame = decoder.next();
      if (frame?.type === 'control' && frame.control) {
        return frame.control;
      }

      const { value, done } = await reader.read();
      if (done) throw new Error('Stream closed unexpectedly');
      if (value) decoder.feed(value);
    }
  }
}

// -- QUIC File Downloader ---------------------------------------------------

export class QUICFileDownloader {
  private aborted = false;

  /**
   * Download a file over a WebTransport bidirectional stream.
   */
  async download(
    transport: WebTransport,
    attachmentId: string,
    authToken: string,
    onProgress?: ProgressCallback,
  ): Promise<DownloadResult> {
    const stream = await transport.createBidirectionalStream();
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    const decoder = new FrameDecoder();

    try {
      // 1. Send FileDownloadRequest
      const reqMsg: ControlMessage = {
        type: 'file_download_request',
        attachment_id: attachmentId,
        auth_token: authToken,
      };
      await writer.write(encodeControlFrame(reqMsg));

      // 2. Wait for FileDownloadAccept
      const acceptMsg = await this.readNextControl(reader, decoder);
      if (acceptMsg.type === 'file_transfer_error') {
        throw new Error(`Download error: ${acceptMsg.message}`);
      }
      if (acceptMsg.type !== 'file_download_accept') {
        throw new Error(`Unexpected message: ${acceptMsg.type}`);
      }

      const totalSize = acceptMsg.size as number;
      const filename = acceptMsg.filename as string;
      const contentType = acceptMsg.content_type as string;

      // 3. Read data chunks
      const chunks: Uint8Array[] = [];
      let bytesReceived = 0;

      while (!this.aborted) {
        // Try decoding from buffer first
        let frame = decoder.next();
        while (frame) {
          if (frame.type === 'data' && frame.data) {
            chunks.push(frame.data);
            bytesReceived += frame.data.length;
            onProgress?.(bytesReceived, totalSize);
          } else if (frame.type === 'end') {
            // Keep reading for the done message
            const doneMsg = await this.readNextControl(reader, decoder);
            if (doneMsg.type === 'file_transfer_error') {
              throw new Error(`Download error: ${doneMsg.message}`);
            }
            const blob = new Blob(chunks as BlobPart[], { type: contentType });
            return { data: blob, filename, contentType };
          } else if (frame.type === 'control' && frame.control) {
            if (frame.control.type === 'file_transfer_done') {
              const blob = new Blob(chunks as BlobPart[], { type: contentType });
              return { data: blob, filename, contentType };
            }
            if (frame.control.type === 'file_transfer_error') {
              throw new Error(`Download error: ${frame.control.message}`);
            }
            // progress messages are informational during download
          }
          frame = decoder.next();
        }

        const { value, done } = await reader.read();
        if (done) break;
        if (value) decoder.feed(value);
      }

      if (this.aborted) {
        throw new Error('Download cancelled');
      }

      // If stream closed, return what we have
      const blob = new Blob(chunks as BlobPart[], { type: contentType });
      return { data: blob, filename, contentType };
    } finally {
      try { writer.releaseLock(); } catch { /* ignore */ }
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
  }

  cancel(): void {
    this.aborted = true;
  }

  private async readNextControl(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    decoder: FrameDecoder,
  ): Promise<ControlMessage> {
    while (true) {
      const frame = decoder.next();
      if (frame?.type === 'control' && frame.control) {
        return frame.control;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error('Stream closed unexpectedly');
      if (value) decoder.feed(value);
    }
  }
}
