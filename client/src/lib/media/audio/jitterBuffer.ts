// Adaptive jitter buffer (JS implementation for browser).

interface BufferedFrame {
  sequence: number;
  timestamp: number;
  data: Uint8Array;
  receivedAt: number;
}

export class JitterBuffer {
  private frames: BufferedFrame[] = [];
  private nextSequence = -1;
  private frameMs: number;

  // Adaptive depth parameters
  private targetMs: number;
  private minMs = 20;
  private maxMs = 200;
  private currentDepthMs: number;

  // Jitter tracking
  private lastArrivalTime = 0;
  private lastTimestamp = 0;
  private jitterEstimate = 0;
  private totalReceived = 0;
  private totalLost = 0;

  constructor(frameMs: number, targetMs?: number) {
    this.frameMs = frameMs;
    this.targetMs = targetMs ?? 60;
    this.currentDepthMs = this.targetMs;
  }

  /** Push a received frame into the buffer. */
  push(sequence: number, timestamp: number, data: Uint8Array): void {
    const now = performance.now();
    this.totalReceived++;

    // Update jitter estimate (RFC 3550 algorithm)
    if (this.lastArrivalTime > 0) {
      const arrivalDelta = now - this.lastArrivalTime;
      const timestampDelta = (timestamp - this.lastTimestamp) / 48; // Convert 48kHz ticks to ms
      const deviation = Math.abs(arrivalDelta - timestampDelta);
      this.jitterEstimate += (deviation - this.jitterEstimate) / 16;
    }
    this.lastArrivalTime = now;
    this.lastTimestamp = timestamp;

    // Adapt buffer depth based on jitter
    const desiredDepth = Math.max(this.minMs, Math.min(this.maxMs, this.jitterEstimate * 3));
    // Smooth adaptation
    this.currentDepthMs += (desiredDepth - this.currentDepthMs) * 0.1;
    this.currentDepthMs = Math.max(this.minMs, Math.min(this.maxMs, this.currentDepthMs));

    // Initialize next expected sequence on first packet
    if (this.nextSequence === -1) {
      this.nextSequence = sequence;
    }

    // Discard if too old (sequence already passed)
    if (this.nextSequence !== -1 && this.seqDiff(sequence, this.nextSequence) < 0) {
      return; // Late packet, already passed
    }

    // Insert in order by sequence number
    const frame: BufferedFrame = { sequence, timestamp, data, receivedAt: now };
    let inserted = false;
    for (let i = this.frames.length - 1; i >= 0; i--) {
      if (this.seqDiff(sequence, this.frames[i].sequence) > 0) {
        this.frames.splice(i + 1, 0, frame);
        inserted = true;
        break;
      } else if (sequence === this.frames[i].sequence) {
        return; // Duplicate
      }
    }
    if (!inserted) {
      this.frames.unshift(frame);
    }

    // Trim buffer if too large
    const maxFrames = Math.ceil(this.maxMs / this.frameMs) + 2;
    while (this.frames.length > maxFrames) {
      this.frames.shift();
    }
  }

  /**
   * Pull the next frame in sequence order.
   * Returns null if the next frame is missing (PLC opportunity)
   * but only after we have buffered enough depth.
   */
  pull(): Uint8Array | null {
    if (this.nextSequence === -1) return null;

    // Wait until we have enough depth
    const targetFrames = Math.ceil(this.currentDepthMs / this.frameMs);
    if (this.frames.length < targetFrames && this.frames.length > 0) {
      const oldestAge = performance.now() - this.frames[0].receivedAt;
      if (oldestAge < this.currentDepthMs) {
        return null; // Still buffering
      }
    }

    if (this.frames.length === 0) return null;

    // Check if next expected sequence is available
    if (this.frames[0].sequence === this.nextSequence) {
      const frame = this.frames.shift()!;
      this.nextSequence = (frame.sequence + 1) & 0xffff;
      return frame.data;
    }

    // Gap detected - frame is missing
    this.totalLost++;
    this.nextSequence = (this.nextSequence + 1) & 0xffff;
    return null; // Caller should do PLC
  }

  get stats(): { depth: number; lossRate: number; jitter: number } {
    const total = this.totalReceived + this.totalLost;
    return {
      depth: this.frames.length * this.frameMs,
      lossRate: total > 0 ? this.totalLost / total : 0,
      jitter: this.jitterEstimate,
    };
  }

  /** Signed sequence number difference with 16-bit wrapping. */
  private seqDiff(a: number, b: number): number {
    const diff = (a - b) & 0xffff;
    return diff > 0x7fff ? diff - 0x10000 : diff;
  }
}
