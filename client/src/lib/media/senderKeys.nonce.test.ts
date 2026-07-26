import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SenderKeyManager } from './senderKeys';
import { videoFragmentCount, videoSequenceSpan } from './browserMediaEngine';

/**
 * The AES-GCM nonce is a pure function of `(ssrc, epoch, sequence, roc)` and the
 * sender key is fixed for an epoch, so a repeated sequence reuses a
 * `(key, nonce)` pair. That is catastrophic, not cosmetic: it exposes the XOR of
 * the two plaintexts *and* the GHASH subkey, which lets an observer forge
 * authenticated media frames for the rest of the epoch.
 *
 * The browser publisher used to advance its sequence counter by 1 per *frame*
 * while each frame emitted `fragmentCount` packets at `seq + fragmentIndex`, so
 * consecutive multi-fragment frames overlapped and produced byte-identical
 * nonces. The Rust encryptor refuses this outright
 * (`CryptoError::SequenceReuse`); the TypeScript port silently permitted it.
 */

/** Record every IV handed to WebCrypto so duplicates are detectable. */
function captureIvs(): string[] {
  const ivs: string[] = [];
  const realEncrypt = crypto.subtle.encrypt.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, 'encrypt').mockImplementation((algo: any, key: any, data: any) => {
    ivs.push(Buffer.from(new Uint8Array(algo.iv)).toString('hex'));
    return realEncrypt(algo, key, data);
  });
  return ivs;
}

async function newManager(): Promise<SenderKeyManager> {
  const mgr = new SenderKeyManager();
  await mgr.generateKey();
  return mgr;
}

/** Emit one frame the way `sendEncodedVideo` does, at `seq + fragmentIndex`. */
async function sendFrame(mgr: SenderKeyManager, seq: number, fragments: number, ssrc: number) {
  for (let i = 0; i < fragments; i += 1) {
    await mgr.encrypt(new Uint8Array(16), new Uint8Array(32), 1, (seq + i) & 0xffff, ssrc);
  }
}

describe('media sender-key nonce uniqueness', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('never repeats a nonce when frames advance by their true sequence span', async () => {
    const mgr = await newManager();
    const ivs = captureIvs();
    const ssrc = 0xdeadbeef;
    const fragments = 2;

    let seq = 0;
    for (let frame = 0; frame < 8; frame += 1) {
      await sendFrame(mgr, seq, fragments, ssrc);
      // What the fixed call sites do.
      seq = (seq + videoSequenceSpan(fragments * 1000, false)) & 0xffff;
    }

    expect(ivs.length).toBe(16);
    expect(new Set(ivs).size).toBe(ivs.length);
  });

  /**
   * The guard is what makes a future regression loud instead of catastrophic:
   * even if a caller advances wrongly again, the encrypt must fail rather than
   * emit the duplicate.
   */
  it('refuses to encrypt a repeated sequence instead of emitting a duplicate nonce', async () => {
    const mgr = await newManager();
    const ivs = captureIvs();
    const ssrc = 0xdeadbeef;

    // The old, broken arithmetic: advance by 1 while consuming 2 per frame.
    await sendFrame(mgr, 0, 2, ssrc); // uses 0, 1
    await expect(sendFrame(mgr, 1, 2, ssrc)).rejects.toThrow(/already used|key, nonce/i);

    // Whatever was emitted before the refusal is still unique.
    expect(new Set(ivs).size).toBe(ivs.length);
  });

  it('still bumps the rollover counter on a genuine 16-bit wrap', async () => {
    const mgr = await newManager();
    const ivs = captureIvs();
    const ssrc = 7;

    await mgr.encrypt(new Uint8Array(16), new Uint8Array(8), 1, 0xffff, ssrc);
    await mgr.encrypt(new Uint8Array(16), new Uint8Array(8), 1, 0x0000, ssrc);

    expect(new Set(ivs).size).toBe(2);
    // roc is bytes 7..11; it must have advanced past the wrap.
    expect(ivs[0].slice(14, 22)).toBe('00000000');
    expect(ivs[1].slice(14, 22)).toBe('00000001');
  });

  it('sequence span matches how many packets a frame actually emits', () => {
    const small = 100;
    expect(videoFragmentCount(small)).toBe(1);
    expect(videoSequenceSpan(small, false)).toBe(1);

    // A multi-fragment inter-frame consumes one sequence per fragment.
    const big = 5000;
    expect(videoFragmentCount(big)).toBeGreaterThan(1);
    expect(videoSequenceSpan(big, false)).toBe(videoFragmentCount(big));

    // A keyframe rides one reliable stream as a single AEAD, so it consumes one.
    expect(videoSequenceSpan(big, true)).toBe(1);
  });
});
