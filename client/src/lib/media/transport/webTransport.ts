// WebTransport connection manager for browser clients.

export interface ControlMessage {
  type: string;
  [key: string]: unknown;
}

export interface StreamControlMessage {
  type: string;
  [key: string]: unknown;
}

/**
 * Re-reads the media certificate pin the server currently publishes.
 *
 * Supplied by the caller (the voice store, from the authenticated
 * transport-diagnostics route) so this module stays free of API wiring and the
 * tests can drive it with a fake.
 */
export type CertHashRefresher = () => Promise<string | undefined>;

/**
 * How long a dropped media connection is given to come back.
 *
 * Long enough to ride out a wifi roam or a base-station handover; short enough
 * that a call whose server has gone away is declared over while the person is
 * still wondering why nobody answered.
 */
export const MEDIA_RECONNECT_WINDOW_MS = 15_000;
const MEDIA_RECONNECT_MAX_BACKOFF_MS = 2_000;

/** Surfaced when a rotation is confirmed but the fresh pin is refused too. */
export const REFRESHED_PIN_REFUSED =
  "The server's media certificate changed and the new one was refused as well";

export class WebTransportManager {
  private transport: WebTransport | null = null;
  private generation = 0;
  private disposed = false;
  private readers = new Set<{ cancel(reason?: unknown): Promise<void> }>();

  private current(generation: number, transport = this.transport): boolean {
    return !this.disposed && this.generation === generation && this.transport === transport;
  }
  /** Reused for the connection lifetime — avoid getWriter()/releaseLock() per datagram. */
  private datagramWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;

  private datagramCallbacks: Array<(data: Uint8Array) => void> = [];
  private streamControlCallbacks: Array<(msg: StreamControlMessage) => void> = [];
  private uniStreamCallbacks: Array<(data: Uint8Array) => void> = [];
  private closeCallbacks: Array<(reason: string) => void> = [];
  private restoredCallbacks: Array<() => void> = [];
  private interruptCallbacks: Array<(reason: string) => void> = [];

  private reconnectAttempts = 0;
  private hasConnectedOnce = false;
  private shouldReconnect = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * When retrying stops being worth it.
   *
   * A call is a live conversation, and a conversation that has been gone for
   * longer than this is over: the honest thing is to say so and let the caller
   * dial back in. The budget used to be ten attempts on a doubling backoff
   * capped at thirty seconds — over two and a half minutes, during which a
   * client whose server had been restarted under it went on presenting a live
   * call, timer running and microphone lit, to a room the relay said was empty.
   */
  private reconnectDeadline: number | null = null;

  private lastUrl = '';
  private lastToken = '';
  private lastCertHash?: string;
  private refreshCertHash: CertHashRefresher | null = null;
  /**
   * Whether the one-shot "the pin may be stale" retry is still available.
   *
   * Armed on connect and re-armed after every successful handshake, so a
   * rotation that happens mid-session still gets exactly one refetch-and-retry
   * rather than an unbounded refetch loop against the control plane.
   */
  private certRefreshArmed = false;

  get isConnected(): boolean {
    return this.transport !== null;
  }

  async connect(
    url: string,
    token: string,
    certHash?: string,
    refreshCertHash?: CertHashRefresher,
  ): Promise<void> {
    if (this.disposed) throw new DOMException('Transport was disposed.', 'AbortError');
    this.lastUrl = url;
    this.lastToken = token;
    this.lastCertHash = certHash;
    this.refreshCertHash = refreshCertHash ?? null;
    this.certRefreshArmed = true;
    this.shouldReconnect = true;
    this.reconnectAttempts = 0;
    this.reconnectDeadline = null;

    await this.establishConnection(url, token, certHash);
  }

  /**
   * Ask the server what pin it publishes now, never throwing.
   *
   * A failure here means the control plane is unreachable too, which is not a
   * certificate problem — the caller keeps the pin it already has and lets the
   * ordinary reconnect backoff report the real cause.
   */
  private async refetchCertHash(): Promise<string | undefined> {
    if (!this.refreshCertHash) return undefined;
    try {
      return (await this.refreshCertHash()) || undefined;
    } catch {
      return undefined;
    }
  }

  private async establishConnection(url: string, token: string, certHash?: string): Promise<void> {
    if (this.disposed || !this.shouldReconnect) return;
    const generation = ++this.generation;
    const previous = this.transport;
    this.releaseDatagramWriter();
    for (const reader of this.readers) void reader.cancel().catch(() => {});
    this.readers.clear();
    try { previous?.close(); } catch { /* old connection already closed */ }
    let transport: WebTransport | null = null;
    const assertCurrent = () => {
      if (!this.current(generation, transport)) {
        transport?.close();
        throw new DOMException('Transport was superseded.', 'AbortError');
      }
    };
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

      transport = new WebTransport(url, options);
      this.transport = transport;
      await transport.ready;
      assertCurrent();
      this.datagramWriter = transport.datagrams.writable.getWriter();

      // Send auth on first bidirectional stream
      const controlStream = await transport.createBidirectionalStream();
      assertCurrent();
      const writer = controlStream.writable.getWriter();
      const reader = controlStream.readable.getReader();
      this.readers.add(reader);
      try {
        const payload = new TextEncoder().encode(JSON.stringify({ type: 'auth', token }));
        const frame = new Uint8Array(4 + payload.byteLength);
        new DataView(frame.buffer).setUint32(0, payload.byteLength, false);
        frame.set(payload, 4);
        await writer.write(frame);

        const { value } = await reader.read();
        assertCurrent();
        if (!value || value.byteLength < 4) {
          throw new Error('Missing auth acknowledgement');
        }
      } finally {
        writer.releaseLock();
        this.readers.delete(reader);
        reader.releaseLock();
      }

      this.reconnectAttempts = 0;
      this.reconnectDeadline = null;
      this.certRefreshArmed = true;

      const isRestore = this.hasConnectedOnce;
      if (isRestore) {
        for (const cb of this.restoredCallbacks) {
          cb();
        }
      } else {
        this.hasConnectedOnce = true;
      }

      // Start reading datagrams, control messages, and keyframe uni streams
      void this.readDatagrams(generation);
      void this.readIncomingStreamControls(generation);
      void this.readIncomingUniStreams(generation);

      // Handle connection close
      transport.closed
        .then(() => {
          this.handleClose('Connection closed gracefully', generation);
        })
        .catch((err: Error) => {
          this.handleClose(err.message || 'Connection lost', generation);
        });
    } catch (err) {
      try { transport?.close(); } catch { /* already closed */ }
      if (!this.current(generation, transport)) throw err;
      this.releaseDatagramWriter();
      this.transport = null;

      // The server rotates its media certificate (it must stay inside the
      // 14-day window browsers accept for a pinned one), and a pin cached from
      // an earlier join names a certificate the media port no longer presents.
      // The browser refuses that handshake in milliseconds with an error that
      // reads exactly like a blocked UDP port, so message matching cannot tell
      // the two apart — re-reading the published pin can. Do it once: if the
      // pin actually changed, the cached one was stale and the retry is the
      // fix; if it did not, this was never a certificate problem and the
      // original error stands.
      if (this.certRefreshArmed && this.refreshCertHash && certHash) {
        this.certRefreshArmed = false;
        const fresh = await this.refetchCertHash();
        if (fresh && fresh !== certHash && this.current(generation)) {
          this.lastCertHash = fresh;
          try {
            return await this.establishConnection(url, token, fresh);
          } catch (retryErr) {
            const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
            throw new Error(`${REFRESHED_PIN_REFUSED}: ${retryMsg}`);
          }
        }
      }

      const msg = err instanceof Error ? err.message : 'Unknown connection error';
      if (this.canStillReconnect()) {
        this.scheduleReconnect(msg);
      } else {
        this.reconnectDeadline = null;
        this.closeCallbacks.forEach((cb) => cb(msg));
      }
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.disposed = true;
    this.generation++;
    this.shouldReconnect = false;
    for (const reader of this.readers) void reader.cancel().catch(() => {});
    this.readers.clear();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.releaseDatagramWriter();
    if (this.transport) {
      try {
        this.transport.close({ closeCode: 0, reason: 'Client disconnect' });
      } catch { /* already closed */ }
      this.transport = null;
    }
  }

  sendDatagram(data: Uint8Array): void {
    const writer = this.datagramWriter;
    if (!writer) return;
    void writer.write(data).catch(() => {
      // Datagram write failed (connection closing); ignore — handleClose reconnects.
    });
  }

  private releaseDatagramWriter(): void {
    if (!this.datagramWriter) return;
    try {
      this.datagramWriter.releaseLock();
    } catch {
      // Already released or stream closed.
    }
    this.datagramWriter = null;
  }

  onDatagram(cb: (data: Uint8Array) => void): void {
    this.datagramCallbacks.push(cb);
  }

  onStreamControl(cb: (msg: StreamControlMessage) => void): void {
    this.streamControlCallbacks.push(cb);
  }

  async sendStreamControl(msg: StreamControlMessage): Promise<void> {
    if (!this.transport) return;
    const transport = this.transport;
    const generation = this.generation;
    const stream = await transport.createBidirectionalStream();
    const writer = stream.writable.getWriter();
    try {
      if (!this.current(generation, transport)) {
        void stream.readable.cancel().catch(() => {});
        await writer.abort();
        return;
      }
      const json = new TextEncoder().encode(JSON.stringify(msg));
      const frame = new Uint8Array(4 + json.byteLength);
      new DataView(frame.buffer).setUint32(0, json.byteLength, false);
      frame.set(json, 4);
      await writer.write(frame);
    } finally {
      writer.releaseLock();
    }
  }

  /**
   * Register a callback for whole-frame keyframe messages arriving on
   * WebTransport unidirectional streams. Each callback receives the complete
   * message body (the stream drained to its FIN) byte-for-byte as the relay
   * forwarded it — the same wire framing native QUIC uni streams use (§5).
   */
  onUniStream(cb: (data: Uint8Array) => void): void {
    this.uniStreamCallbacks.push(cb);
  }

  /**
   * Publish one whole-frame keyframe message on a fresh unidirectional stream.
   * The message is written and the stream finished (its FIN delimits the frame),
   * mirroring the native publisher's `send_encoded_video_frame_stream`.
   */
  async sendUniStream(data: Uint8Array): Promise<void> {
    if (!this.transport) return;
    const transport = this.transport;
    const generation = this.generation;
    const stream = await transport.createUnidirectionalStream();
    const writer = stream.getWriter();
    try {
      if (!this.current(generation, transport)) { await writer.abort(); return; }
      await writer.write(data);
      await writer.close();
    } finally {
      try {
        writer.releaseLock();
      } catch {
        // Already released by close().
      }
    }
  }

  onClose(cb: (reason: string) => void): void {
    this.closeCallbacks.push(cb);
  }

  /**
   * Fired when the media connection drops and a reconnect has been scheduled.
   * A matching `onRestored` follows if it comes back, `onClose` if it does not.
   */
  onInterrupt(cb: (reason: string) => void): void {
    this.interruptCallbacks.push(cb);
  }

  onRestored(cb: () => void): void {
    this.restoredCallbacks.push(cb);
  }

  private async readDatagrams(generation = this.generation): Promise<void> {
    if (!this.transport) return;
    const reader = this.transport.datagrams.readable.getReader();
    this.readers.add(reader);
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done || !this.current(generation)) break;
        if (value) {
          for (const cb of this.datagramCallbacks) {
            cb(value);
          }
        }
      }
    } catch {
      // Stream closed
    } finally {
      this.readers.delete(reader);
      reader.releaseLock();
    }
  }

  private async readIncomingStreamControls(generation = this.generation): Promise<void> {
    if (!this.transport?.incomingBidirectionalStreams) return;
    const reader = this.transport.incomingBidirectionalStreams.getReader();
    this.readers.add(reader);
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done || !this.current(generation)) break;
        if (!value) continue;
        void this.handleIncomingControlStream(value, generation);
      }
    } catch {
      // Stream closed
    } finally {
      this.readers.delete(reader);
      reader.releaseLock();
    }
  }

  private async handleIncomingControlStream(stream: WebTransportBidirectionalStream, generation = this.generation): Promise<void> {
    const reader = stream.readable.getReader();
    this.readers.add(reader);
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done || !this.current(generation)) break;
        if (!value) continue;
        chunks.push(value);
        total += value.byteLength;
      }
      if (!this.current(generation) || total < 4) return;
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
      this.readers.delete(reader);
      reader.releaseLock();
    }
  }

  private async readIncomingUniStreams(generation = this.generation): Promise<void> {
    if (!this.transport?.incomingUnidirectionalStreams) return;
    const reader = this.transport.incomingUnidirectionalStreams.getReader();
    this.readers.add(reader);
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done || !this.current(generation)) break;
        if (!value) continue;
        void this.handleIncomingUniStream(value, generation);
      }
    } catch {
      // Stream closed
    } finally {
      this.readers.delete(reader);
      reader.releaseLock();
    }
  }

  private async handleIncomingUniStream(stream: ReadableStream<Uint8Array>, generation = this.generation): Promise<void> {
    const reader = stream.getReader();
    this.readers.add(reader);
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done || !this.current(generation)) break;
        if (!value) continue;
        chunks.push(value);
        total += value.byteLength;
      }
      if (!this.current(generation) || total === 0) return;
      const combined = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      for (const cb of this.uniStreamCallbacks) {
        cb(combined);
      }
    } catch {
      // Ignore truncated/aborted uni streams (a stale keyframe the relay reset).
    } finally {
      this.readers.delete(reader);
      reader.releaseLock();
    }
  }

  private handleClose(reason: string, generation = this.generation): void {
    if (!this.current(generation)) return;
    this.releaseDatagramWriter();
    this.transport = null;

    if (this.canStillReconnect()) {
      this.scheduleReconnect(reason);
    } else {
      this.reconnectDeadline = null;
      for (const cb of this.closeCallbacks) {
        cb(reason);
      }
    }
  }

  /**
   * Whether this transport may try again, and start the clock if it has not.
   *
   * The budget is a wall-clock window rather than an attempt count, so the
   * answer does not depend on how quickly the attempts happen to fail: a
   * refused port fails in a millisecond and a black hole takes seconds, and
   * both should give up at the same moment.
   */
  private canStillReconnect(): boolean {
    if (this.disposed || !this.shouldReconnect) return false;
    if (this.reconnectDeadline == null) {
      this.reconnectDeadline = Date.now() + MEDIA_RECONNECT_WINDOW_MS;
      return true;
    }
    return Date.now() < this.reconnectDeadline;
  }

  private scheduleReconnect(reason: string): void {
    if (this.disposed || !this.shouldReconnect || this.reconnectTimer) return;
    const generation = this.generation;
    this.reconnectAttempts++;
    if (this.reconnectAttempts === 1) {
      // The call is not over, but it is not carrying anybody's voice either.
      // Say so now, rather than letting the room look live until the budget
      // runs out.
      for (const cb of this.interruptCallbacks) cb(reason);
    }
    // 250ms, 500ms, 1s, 2s, then every 2s until the window closes.
    const delayMs = Math.min(250 * Math.pow(2, this.reconnectAttempts - 1), MEDIA_RECONNECT_MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.disposed || !this.shouldReconnect || generation !== this.generation) return;
      // Read the pin fresh on every reconnect rather than replaying the one the
      // join handed us: a server that rotated its media certificate while this
      // session was down would otherwise refuse every attempt until the backoff
      // is exhausted.
      const fresh = await this.refetchCertHash();
      if (fresh) this.lastCertHash = fresh;
      if (this.disposed || !this.shouldReconnect || generation !== this.generation) return;
      try {
        await this.establishConnection(this.lastUrl, this.lastToken, this.lastCertHash);
      } catch {
        // establishConnection handles retry scheduling internally
      }
    }, delayMs);
  }
}
