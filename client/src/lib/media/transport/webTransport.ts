// WebTransport connection manager for browser clients.

export interface ControlMessage {
  type: string;
  [key: string]: unknown;
}

export interface StreamControlMessage {
  type: string;
  [key: string]: unknown;
}

export class WebTransportManager {
  private transport: WebTransport | null = null;

  private datagramCallbacks: Array<(data: Uint8Array) => void> = [];
  private streamControlCallbacks: Array<(msg: StreamControlMessage) => void> = [];
  private closeCallbacks: Array<(reason: string) => void> = [];
  private restoredCallbacks: Array<() => void> = [];

  private reconnectAttempts = 0;
  private hasConnectedOnce = false;
  private maxReconnectAttempts = 10;
  private shouldReconnect = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private lastUrl = '';
  private lastToken = '';
  private lastCertHash?: string;

  get isConnected(): boolean {
    return this.transport !== null;
  }

  async connect(url: string, token: string, certHash?: string): Promise<void> {
    this.lastUrl = url;
    this.lastToken = token;
    this.lastCertHash = certHash;
    this.shouldReconnect = true;
    this.reconnectAttempts = 0;

    await this.establishConnection(url, token, certHash);
  }

  private async establishConnection(url: string, token: string, certHash?: string): Promise<void> {
    try {
      // When a cert hash is provided (self-signed cert), pass it to the
      // WebTransport constructor so the browser trusts the server.
      const options: WebTransportOptions | undefined = certHash
        ? {
            serverCertificateHashes: [
              {
                algorithm: 'sha-256',
                value: Uint8Array.from(atob(certHash), (c) => c.charCodeAt(0)),
              },
            ],
          }
        : undefined;

      this.transport = new WebTransport(url, options);
      await this.transport.ready;

      // Send auth on first bidirectional stream
      const controlStream = await this.transport.createBidirectionalStream();
      const writer = controlStream.writable.getWriter();
      const reader = controlStream.readable.getReader();
      try {
        const payload = new TextEncoder().encode(JSON.stringify({ type: 'auth', token }));
        const frame = new Uint8Array(4 + payload.byteLength);
        new DataView(frame.buffer).setUint32(0, payload.byteLength, false);
        frame.set(payload, 4);
        await writer.write(frame);

        const { value } = await reader.read();
        if (!value || value.byteLength < 4) {
          throw new Error('Missing auth acknowledgement');
        }
      } finally {
        writer.releaseLock();
        reader.releaseLock();
      }

      this.reconnectAttempts = 0;

      const isRestore = this.hasConnectedOnce;
      if (isRestore) {
        for (const cb of this.restoredCallbacks) {
          cb();
        }
      } else {
        this.hasConnectedOnce = true;
      }

      // Start reading datagrams and control messages
      this.readDatagrams();
      this.readIncomingStreamControls();

      // Handle connection close
      this.transport.closed
        .then(() => {
          this.handleClose('Connection closed gracefully');
        })
        .catch((err: Error) => {
          this.handleClose(err.message || 'Connection lost');
        });
    } catch (err) {
      this.transport = null;
      const msg = err instanceof Error ? err.message : 'Unknown connection error';
      if (this.shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.scheduleReconnect();
      } else {
        this.closeCallbacks.forEach((cb) => cb(msg));
      }
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.transport) {
      try {
        this.transport.close({ closeCode: 0, reason: 'Client disconnect' });
      } catch { /* already closed */ }
      this.transport = null;
    }
  }

  sendDatagram(data: Uint8Array): void {
    if (!this.transport) return;
    const writer = this.transport.datagrams.writable.getWriter();
    writer.write(data).finally(() => writer.releaseLock());
  }

  onDatagram(cb: (data: Uint8Array) => void): void {
    this.datagramCallbacks.push(cb);
  }

  onStreamControl(cb: (msg: StreamControlMessage) => void): void {
    this.streamControlCallbacks.push(cb);
  }

  async sendStreamControl(msg: StreamControlMessage): Promise<void> {
    if (!this.transport) return;
    const stream = await this.transport.createBidirectionalStream();
    const writer = stream.writable.getWriter();
    try {
      const json = new TextEncoder().encode(JSON.stringify(msg));
      const frame = new Uint8Array(4 + json.byteLength);
      new DataView(frame.buffer).setUint32(0, json.byteLength, false);
      frame.set(json, 4);
      await writer.write(frame);
    } finally {
      writer.releaseLock();
    }
  }

  onClose(cb: (reason: string) => void): void {
    this.closeCallbacks.push(cb);
  }

  onRestored(cb: () => void): void {
    this.restoredCallbacks.push(cb);
  }

  private async readDatagrams(): Promise<void> {
    if (!this.transport) return;
    const reader = this.transport.datagrams.readable.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          for (const cb of this.datagramCallbacks) {
            cb(value);
          }
        }
      }
    } catch {
      // Stream closed
    } finally {
      reader.releaseLock();
    }
  }

  private async readIncomingStreamControls(): Promise<void> {
    if (!this.transport?.incomingBidirectionalStreams) return;
    const reader = this.transport.incomingBidirectionalStreams.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        void this.handleIncomingControlStream(value);
      }
    } catch {
      // Stream closed
    } finally {
      reader.releaseLock();
    }
  }

  private async handleIncomingControlStream(stream: WebTransportBidirectionalStream): Promise<void> {
    const reader = stream.readable.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        chunks.push(value);
        total += value.byteLength;
      }
      if (total < 4) return;
      const combined = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const length = new DataView(combined.buffer, combined.byteOffset, 4).getUint32(0, false);
      if (length === 0 || total < 4 + length) return;
      const payload = combined.slice(4, 4 + length);
      const message = JSON.parse(new TextDecoder().decode(payload)) as StreamControlMessage;
      for (const cb of this.streamControlCallbacks) {
        cb(message);
      }
    } catch {
      // Ignore malformed/closed control streams
    } finally {
      reader.releaseLock();
    }
  }

  private handleClose(reason: string): void {
    this.transport = null;

    if (this.shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
      this.scheduleReconnect();
    } else {
      for (const cb of this.closeCallbacks) {
        cb(reason);
      }
    }
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts++;
    // Exponential backoff: 500ms, 1s, 2s, 4s... capped at 30s
    const delayMs = Math.min(500 * Math.pow(2, this.reconnectAttempts - 1), 30_000);
    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.establishConnection(this.lastUrl, this.lastToken, this.lastCertHash);
      } catch {
        // establishConnection handles retry scheduling internally
      }
    }, delayMs);
  }
}
