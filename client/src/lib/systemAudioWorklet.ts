const WORKLET_PROCESSOR_CODE = `
class SystemAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = [];
    this.port.onmessage = (e) => {
      if (e.data instanceof Float32Array) {
        this._buffer.push(...e.data);
      }
    };
  }
  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length < 2) return true;
    const left = output[0];
    const right = output[1];
    const needed = left.length;
    // Buffer contains interleaved stereo: L, R, L, R, ...
    const samplesNeeded = needed * 2;
    if (this._buffer.length >= samplesNeeded) {
      const chunk = this._buffer.splice(0, samplesNeeded);
      for (let i = 0; i < needed; i++) {
        left[i] = chunk[i * 2];
        right[i] = chunk[i * 2 + 1];
      }
    } else {
      const pairs = Math.floor(this._buffer.length / 2);
      if (pairs > 0) {
        const chunk = this._buffer.splice(0, pairs * 2);
        for (let i = 0; i < pairs; i++) {
          left[i] = chunk[i * 2];
          right[i] = chunk[i * 2 + 1];
        }
      }
    }
    return true;
  }
}
registerProcessor('system-audio-processor', SystemAudioProcessor);
`;

export class SystemAudioBridge {
  private ctx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;

  async start(): Promise<MediaStreamTrack> {
    this.ctx = new AudioContext({ sampleRate: 48000 });

    const blob = new Blob([WORKLET_PROCESSOR_CODE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    try {
      await this.ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }

    this.workletNode = new AudioWorkletNode(this.ctx, 'system-audio-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });

    this.destination = this.ctx.createMediaStreamDestination();

    this.workletNode.connect(this.destination);

    return this.destination.stream.getAudioTracks()[0];
  }

  pushSamples(samples: Float32Array): void {
    this.workletNode?.port.postMessage(samples, [samples.buffer]);
  }

  stop(): void {
    this.workletNode?.disconnect();
    this.workletNode = null;
    this.destination = null;
    if (this.ctx) {
      void this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }
}
