// AudioWorklet processor for browser audio pipeline.
// This file is loaded via `audioContext.audioWorklet.addModule(...)`.
// It runs in the AudioWorklet global scope, NOT the main thread.

// AudioWorklet globals are not in the standard DOM lib types.
// @ts-nocheck

const FRAME_SIZE = 960; // 20ms at 48kHz

class MediaAudioProcessor extends AudioWorkletProcessor {
  private buffer: Float32Array = new Float32Array(FRAME_SIZE);
  private bufferOffset = 0;

  constructor() {
    super();
  }

  process(
    inputs: Float32Array[][],
    _outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>,
  ): boolean {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    // Take first channel (mono). If stereo, mix down.
    let mono: Float32Array;
    if (input.length === 1) {
      mono = input[0];
    } else {
      // Average all channels into mono
      mono = new Float32Array(input[0].length);
      for (let s = 0; s < mono.length; s++) {
        let sum = 0;
        for (let ch = 0; ch < input.length; ch++) {
          sum += input[ch][s];
        }
        mono[s] = sum / input.length;
      }
    }

    // Accumulate samples into 960-sample frames
    let srcOffset = 0;
    while (srcOffset < mono.length) {
      const remaining = FRAME_SIZE - this.bufferOffset;
      const available = mono.length - srcOffset;
      const toCopy = Math.min(remaining, available);

      this.buffer.set(mono.subarray(srcOffset, srcOffset + toCopy), this.bufferOffset);
      this.bufferOffset += toCopy;
      srcOffset += toCopy;

      if (this.bufferOffset >= FRAME_SIZE) {
        // Calculate RMS audio level for speaking detection
        let sumSq = 0;
        for (let i = 0; i < FRAME_SIZE; i++) {
          sumSq += this.buffer[i] * this.buffer[i];
        }
        const rms = Math.sqrt(sumSq / FRAME_SIZE);
        // Convert to 0-127 scale (matching the audioLevel header field)
        // -127 dBov to 0 dBov, where 127 = silence, 0 = max
        const dbov = rms > 0 ? 20 * Math.log10(rms) : -127;
        const audioLevel = Math.max(0, Math.min(127, Math.round(-dbov)));

        // Transfer the filled buffer to the main thread (zero-copy). Allocate a
        // fresh accumulator immediately so we never touch a detached ArrayBuffer.
        const samples = this.buffer;
        this.buffer = new Float32Array(FRAME_SIZE);
        this.bufferOffset = 0;
        this.port.postMessage({ type: 'frame', samples, audioLevel }, [samples.buffer]);
      }
    }

    return true; // Keep processor alive
  }
}

registerProcessor('media-audio-processor', MediaAudioProcessor);
