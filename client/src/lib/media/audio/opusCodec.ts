// WebCodecs Opus encoder/decoder wrapper.

export interface OpusEncoderConfig {
  sampleRate: number;
  channels: number;
  bitrate: number;
}

export class OpusMediaEncoder {
  private encoder: AudioEncoder;
  private encodedCallbacks: Array<(data: EncodedAudioChunk) => void> = [];
  private sampleRate: number;
  private channels: number;

  constructor(config: OpusEncoderConfig) {
    this.sampleRate = config.sampleRate;
    this.channels = config.channels;

    this.encoder = new AudioEncoder({
      output: (chunk) => {
        for (const cb of this.encodedCallbacks) {
          cb(chunk);
        }
      },
      error: (err) => {
        console.error('[OpusMediaEncoder] Encoder error:', err);
      },
    });

    this.encoder.configure({
      codec: 'opus',
      sampleRate: config.sampleRate,
      numberOfChannels: config.channels,
      bitrate: config.bitrate,
    });
  }

  /** Encode a PCM frame. timestamp is in microseconds. */
  encode(pcmData: Float32Array, timestamp: number): void {
    if (this.encoder.state === 'closed') return;

    const audioData = new AudioData({
      format: 'f32-planar',
      sampleRate: this.sampleRate,
      numberOfFrames: pcmData.length,
      numberOfChannels: this.channels,
      timestamp,
      data: pcmData.buffer as ArrayBuffer,
    });

    this.encoder.encode(audioData);
    audioData.close();
  }

  onEncoded(cb: (data: EncodedAudioChunk) => void): void {
    this.encodedCallbacks.push(cb);
  }

  close(): void {
    if (this.encoder.state !== 'closed') {
      this.encoder.close();
    }
  }
}

export interface OpusDecoderConfig {
  sampleRate: number;
  channels: number;
}

export class OpusMediaDecoder {
  private decoder: AudioDecoder;
  private decodedCallbacks: Array<(data: AudioData) => void> = [];

  constructor(config: OpusDecoderConfig) {
    this.decoder = new AudioDecoder({
      output: (audioData) => {
        for (const cb of this.decodedCallbacks) {
          cb(audioData);
        }
      },
      error: (err) => {
        console.error('[OpusMediaDecoder] Decoder error:', err);
      },
    });

    this.decoder.configure({
      codec: 'opus',
      sampleRate: config.sampleRate,
      numberOfChannels: config.channels,
    });
  }

  /** Decode an encoded Opus frame. timestamp is in microseconds. */
  decode(data: Uint8Array, timestamp: number): void {
    if (this.decoder.state === 'closed') return;

    const chunk = new EncodedAudioChunk({
      type: 'key',
      timestamp,
      data,
    });

    this.decoder.decode(chunk);
  }

  onDecoded(cb: (data: AudioData) => void): void {
    this.decodedCallbacks.push(cb);
  }

  close(): void {
    if (this.decoder.state !== 'closed') {
      this.decoder.close();
    }
  }
}
