import { describe, it, expect } from 'vitest';
import { SenderKeyManager } from './senderKeys';

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function fromHex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// AES-128-GCM key used by the Rust cross-platform vectors in
// crates/paracord-codec/src/crypto.rs.
const VECTOR_KEY = fromHex('000102030405060708090a0b0c0d0e0f');
// The full 16-byte MediaHeader used as AAD for vectors 1/2/4.
const VECTOR_HEADER = fromHex('80000100' + '0003c0de' + 'adbeef7f' + '01003c00');
const VECTOR_SSRC = 0xdeadbeef;
const VECTOR_EPOCH = 1;

/**
 * Build a SenderKeyManager whose local key is the fixed 16-byte vector key, and
 * import the same key as a peer key for the given (ssrc, epoch) so the same
 * manager can both encrypt (as sender) and decrypt (as receiver).
 */
async function managerWithVectorKey(ssrc: number, epoch: number): Promise<SenderKeyManager> {
  const mgr = new SenderKeyManager();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    VECTOR_KEY.buffer as ArrayBuffer,
    { name: 'AES-GCM', length: 128 },
    true,
    ['encrypt', 'decrypt'],
  );
  // Inject the fixed key as the local key (bypassing random generateKey) so the
  // ciphertext is deterministic and matches the Rust known-answer vectors.
  (mgr as unknown as { localKey: CryptoKey }).localKey = cryptoKey;
  (mgr as unknown as { localEpoch: number }).localEpoch = epoch;
  mgr.setPeerKey(ssrc, epoch, cryptoKey);
  return mgr;
}

describe('SenderKeyManager buildNonce / ROC layout', () => {
  it('matches Rust cross-platform vector 1 (ROC = 0)', async () => {
    const mgr = await managerWithVectorKey(VECTOR_SSRC, VECTOR_EPOCH);
    const plaintext = new TextEncoder().encode('Hello, voice data!');
    const ct = await mgr.encrypt(VECTOR_HEADER, plaintext, VECTOR_EPOCH, 1, VECTOR_SSRC);
    expect(hex(ct)).toBe(
      'c9611e22e84a7843baeea950f4874840d7de76e45bab8f2dc788366fe73643bb62f5',
    );

    const pt = await mgr.decrypt(VECTOR_HEADER, ct, VECTOR_EPOCH, 1, VECTOR_SSRC);
    expect(new TextDecoder().decode(pt)).toBe('Hello, voice data!');
  });

  it('matches Rust cross-platform vector 2 (empty payload, ROC = 0)', async () => {
    const mgr = await managerWithVectorKey(VECTOR_SSRC, VECTOR_EPOCH);
    const ct = await mgr.encrypt(VECTOR_HEADER, new Uint8Array(0), VECTOR_EPOCH, 0, VECTOR_SSRC);
    expect(hex(ct)).toBe('e4ee5cfea6b77f20fcb4d7c719b1f0a4');
  });

  it('matches Rust cross-platform vector 3 (different key/epoch/ssrc, ROC = 0)', async () => {
    const key = fromHex('ffffffffffffffffffffffffffffffff');
    const header = fromHex('8000' + '0a00' + '00078011' + '22334464' + '05000400');
    const ssrc = 0x11223344;
    const epoch = 5;
    const mgr = new SenderKeyManager();
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      key.buffer as ArrayBuffer,
      { name: 'AES-GCM', length: 128 },
      true,
      ['encrypt', 'decrypt'],
    );
    (mgr as unknown as { localKey: CryptoKey }).localKey = cryptoKey;
    const ct = await mgr.encrypt(header, fromHex('00010203'), epoch, 10, ssrc);
    expect(hex(ct)).toBe('81c292b9fd8c98a87d786ee1f5698993b50ae66d');
  });
});

describe('SenderKeyManager sequence-wrap (ROC increment) roundtrip', () => {
  it('increments the ROC on a 16-bit sequence wrap and decrypts across it', async () => {
    const mgr = await managerWithVectorKey(VECTOR_SSRC, VECTOR_EPOCH);

    // Encrypt the last packet before the wrap (seq = 65535, ROC = 0) then the
    // first packet after the wrap (seq = 0, ROC must become 1).
    const beforeWrap = new TextEncoder().encode('before-wrap');
    const afterWrap = new TextEncoder().encode('after-wrap');
    const ctLast = await mgr.encrypt(VECTOR_HEADER, beforeWrap, VECTOR_EPOCH, 0xffff, VECTOR_SSRC);
    const ctWrap = await mgr.encrypt(VECTOR_HEADER, afterWrap, VECTOR_EPOCH, 0, VECTOR_SSRC);

    // The post-wrap frame at seq=0 must decrypt only when the receiver has
    // observed the pre-wrap frame (so its ROC window is anchored at ROC 0,
    // seq 65535 and it estimates ROC 1 for seq 0). A fresh receiver that has
    // never seen the pre-wrap frame estimates ROC 0 and fails authentication —
    // proving the ROC bytes actually feed the GCM nonce.
    const freshReceiver = new SenderKeyManager();
    freshReceiver.setPeerKey(
      VECTOR_SSRC,
      VECTOR_EPOCH,
      (mgr as unknown as { localKey: CryptoKey }).localKey,
    );
    await expect(
      freshReceiver.decrypt(VECTOR_HEADER, ctWrap, VECTOR_EPOCH, 0, VECTOR_SSRC),
    ).rejects.toBeTruthy();

    // In-order receiver: decrypt the pre-wrap frame first to anchor the window.
    const orderedReceiver = new SenderKeyManager();
    orderedReceiver.setPeerKey(
      VECTOR_SSRC,
      VECTOR_EPOCH,
      (mgr as unknown as { localKey: CryptoKey }).localKey,
    );
    const ptLast = await orderedReceiver.decrypt(
      VECTOR_HEADER,
      ctLast,
      VECTOR_EPOCH,
      0xffff,
      VECTOR_SSRC,
    );
    expect(new TextDecoder().decode(ptLast)).toBe('before-wrap');

    const ptWrap = await orderedReceiver.decrypt(
      VECTOR_HEADER,
      ctWrap,
      VECTOR_EPOCH,
      0,
      VECTOR_SSRC,
    );
    expect(new TextDecoder().decode(ptWrap)).toBe('after-wrap');
  });

  it('roundtrips a full stream that straddles the 16-bit wrap boundary', async () => {
    const ssrc = 0x11223344;
    const epoch = 2;
    const sender = await managerWithVectorKey(ssrc, epoch);
    const receiver = new SenderKeyManager();
    receiver.setPeerKey(ssrc, epoch, (sender as unknown as { localKey: CryptoKey }).localKey);

    const seqs = [65533, 65534, 65535, 0, 1, 2];
    const frames: { seq: number; text: string; ct: Uint8Array }[] = [];
    for (let i = 0; i < seqs.length; i++) {
      const text = `frame-${i}`;
      const ct = await sender.encrypt(
        VECTOR_HEADER,
        new TextEncoder().encode(text),
        epoch,
        seqs[i],
        ssrc,
      );
      frames.push({ seq: seqs[i], text, ct });
    }

    for (const frame of frames) {
      const pt = await receiver.decrypt(VECTOR_HEADER, frame.ct, epoch, frame.seq, ssrc);
      expect(new TextDecoder().decode(pt)).toBe(frame.text);
    }
  });

  it('does not move the receive window on a frame that fails authentication', async () => {
    const sender = await managerWithVectorKey(VECTOR_SSRC, VECTOR_EPOCH);
    const receiver = new SenderKeyManager();
    receiver.setPeerKey(
      VECTOR_SSRC,
      VECTOR_EPOCH,
      (sender as unknown as { localKey: CryptoKey }).localKey,
    );

    // Anchor the window at seq = 10.
    const ct10 = await sender.encrypt(
      VECTOR_HEADER,
      new TextEncoder().encode('ten'),
      VECTOR_EPOCH,
      10,
      VECTOR_SSRC,
    );
    expect(
      new TextDecoder().decode(
        await receiver.decrypt(VECTOR_HEADER, ct10, VECTOR_EPOCH, 10, VECTOR_SSRC),
      ),
    ).toBe('ten');

    // A forged frame at a wildly different sequence must fail and leave the
    // window untouched.
    const forged = new Uint8Array(20);
    await expect(
      receiver.decrypt(VECTOR_HEADER, forged, VECTOR_EPOCH, 5000, VECTOR_SSRC),
    ).rejects.toBeTruthy();

    // A legitimate next frame at seq = 11 still decrypts.
    const ct11 = await sender.encrypt(
      VECTOR_HEADER,
      new TextEncoder().encode('eleven'),
      VECTOR_EPOCH,
      11,
      VECTOR_SSRC,
    );
    expect(
      new TextDecoder().decode(
        await receiver.decrypt(VECTOR_HEADER, ct11, VECTOR_EPOCH, 11, VECTOR_SSRC),
      ),
    ).toBe('eleven');
  });
});
