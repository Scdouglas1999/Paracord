/**
 * Manages a dedicated QUIC (WebTransport) connection for file transfers,
 * independent of voice/media connections.
 *
 * The connection is established lazily on first file transfer request
 * and kept alive for reuse across multiple transfers (idle timeout: 5 min).
 */

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Check if WebTransport API is available in this browser. */
export function hasQuicTransport(): boolean {
  return typeof WebTransport !== 'undefined';
}

export class FileTransportManager {
  private static instance: FileTransportManager | null = null;

  private transport: WebTransport | null = null;
  private endpoint = '';
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private connecting: Promise<WebTransport> | null = null;

  static getInstance(): FileTransportManager {
    if (!FileTransportManager.instance) {
      FileTransportManager.instance = new FileTransportManager();
    }
    return FileTransportManager.instance;
  }

  /**
   * Get an active WebTransport connection, or establish a new one.
   * The token is used for authentication on the initial connection.
   */
  async getOrConnect(endpoint: string, token: string): Promise<WebTransport> {
    this.resetIdleTimer();

    // Reuse existing connection if same endpoint and still open
    if (this.transport && this.endpoint === endpoint) {
      return this.transport;
    }

    // If already connecting, wait for it
    if (this.connecting && this.endpoint === endpoint) {
      return this.connecting;
    }

    // Establish new connection
    this.connecting = this.establishConnection(endpoint, token);
    try {
      const transport = await this.connecting;
      return transport;
    } finally {
      this.connecting = null;
    }
  }

  private async establishConnection(endpoint: string, token: string): Promise<WebTransport> {
    // Close existing connection if any
    this.closeTransport();

    const transport = new WebTransport(endpoint);
    await transport.ready;

    // Authenticate on the control stream
    const controlStream = await transport.createBidirectionalStream();
    const writer = controlStream.writable.getWriter();

    // Send auth message (same format as voice: length-prefixed JSON)
    const authMsg = JSON.stringify({ type: 'auth', token });
    const authBytes = new TextEncoder().encode(authMsg);
    const frame = new Uint8Array(4 + authBytes.length);
    new DataView(frame.buffer).setUint32(0, authBytes.length, false);
    frame.set(authBytes, 4);
    await writer.write(frame);

    // Wait for pong (auth acknowledgement)
    const reader = controlStream.readable.getReader();
    const { value } = await reader.read();
    if (!value || value.length < 4) {
      throw new Error('Auth failed: no response');
    }

    writer.releaseLock();
    reader.releaseLock();

    this.transport = transport;
    this.endpoint = endpoint;

    // Handle unexpected close
    transport.closed
      .then(() => this.handleClose())
      .catch(() => this.handleClose());

    return transport;
  }

  /** Gracefully disconnect the file transfer connection. */
  disconnect(): void {
    this.clearIdleTimer();
    this.closeTransport();
  }

  private closeTransport(): void {
    if (this.transport) {
      try {
        this.transport.close({ closeCode: 0, reason: 'Client disconnect' });
      } catch { /* already closed */ }
      this.transport = null;
      this.endpoint = '';
    }
  }

  private handleClose(): void {
    this.transport = null;
    this.endpoint = '';
    this.clearIdleTimer();
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.disconnect();
    }, IDLE_TIMEOUT_MS);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
