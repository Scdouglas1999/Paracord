/** Dedicated, certificate-pinned WebTransport file upload connections. */
const AUTH_TIMEOUT_MS = 10_000;
const MAX_AUTH_FRAME_SIZE = 256 * 1024;

export function hasQuicTransport(): boolean {
  return typeof WebTransport !== 'undefined';
}

export class FileTransportManager {
  private static instance: FileTransportManager | null = null;
  private readonly transports = new Set<WebTransport>();

  static getInstance(): FileTransportManager {
    return FileTransportManager.instance ??= new FileTransportManager();
  }

  /** Each transfer owns its authenticated connection; credentials never cross uploads. */
  async getOrConnect(endpoint: string, token: string, certHash?: string): Promise<WebTransport> {
    if (!certHash) throw new Error('QUIC file server did not provide a TLS certificate pin');
    const decodedHash = Uint8Array.from(atob(certHash), (char) => char.charCodeAt(0));
    if (decodedHash.byteLength !== 32) throw new Error('Invalid file server TLS certificate pin');
    const transport = new WebTransport(endpoint, {
      serverCertificateHashes: [{ algorithm: 'sha-256', value: decodedHash }],
    });
    this.transports.add(transport);
    transport.closed.then(
      () => this.transports.delete(transport),
      () => this.transports.delete(transport),
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
    try {
      await Promise.race([
        (async () => {
          await transport.ready;
          const stream = await transport.createBidirectionalStream();
          writer = stream.writable.getWriter();
          const payload = new TextEncoder().encode(JSON.stringify({ type: 'auth', token }));
          if (payload.length > 8192) throw new Error('File upload token is too large');
          const frame = new Uint8Array(4 + payload.length);
          new DataView(frame.buffer).setUint32(0, payload.length, false);
          frame.set(payload, 4);
          await writer.write(frame);
          reader = stream.readable.getReader();
          let buffer = new Uint8Array(0);
          let expected: number | undefined;
          while (expected === undefined || buffer.length < expected + 4) {
            const { value, done } = await reader.read();
            if (done) throw new Error('File connection closed before authentication');
            if (buffer.length + value.length > MAX_AUTH_FRAME_SIZE + 4) throw new Error('Oversized file authentication frame');
            const combined = new Uint8Array(buffer.length + value.length);
            combined.set(buffer);
            combined.set(value, buffer.length);
            buffer = combined;
            if (expected === undefined && buffer.length >= 4) {
              expected = new DataView(buffer.buffer).getUint32(0, false);
              if (expected === 0 || expected > MAX_AUTH_FRAME_SIZE) throw new Error('Invalid file authentication frame');
            }
          }
          const ack: unknown = JSON.parse(new TextDecoder().decode(buffer.subarray(4, 4 + expected)));
          if (!ack || typeof ack !== 'object' || !('type' in ack) || ack.type !== 'pong') {
            throw new Error('File server did not acknowledge authentication');
          }
        })(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('File connection authentication timed out')), AUTH_TIMEOUT_MS);
        }),
      ]);
      return transport;
    } catch (error) {
      transport.close({ closeCode: 1, reason: 'File authentication failed' });
      this.transports.delete(transport);
      throw error;
    } finally {
      clearTimeout(timeout);
      void reader?.cancel().catch(() => {});
      void writer?.close().catch(() => {});
    }
  }

  /** Close one completed transfer without interrupting another upload. */
  release(transport: WebTransport): void {
    this.transports.delete(transport);
    transport.close({ closeCode: 0, reason: 'File transfer finished' });
  }

  disconnect(): void {
    for (const transport of this.transports) transport.close({ closeCode: 0, reason: 'Client disconnect' });
    this.transports.clear();
  }
}
