import { describe, it, expect, vi } from 'vitest';
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
  it('encrypts and authenticates only the supplied byte views', async () => {
    const mgr = await managerWithVectorKey(VECTOR_SSRC, VECTOR_EPOCH);
    const paddedHeader = new Uint8Array(40).fill(0xaa);
    paddedHeader.set(VECTOR_HEADER, 4);
    const paddedPayload = new TextEncoder().encode('secretHello, voice data!private');
    const ct = await mgr.encrypt(
      paddedHeader.subarray(4, 20),
      paddedPayload.subarray(6, 24),
      VECTOR_EPOCH, 1, VECTOR_SSRC,
    );
    expect(hex(ct)).toBe('c9611e22e84a7843baeea950f4874840d7de76e45bab8f2dc788366fe73643bb62f5');
    const paddedCiphertext = new Uint8Array(ct.length + 10);
    paddedCiphertext.set(ct, 5);
    const paddedKey = new Uint8Array(32).fill(0xff);
    paddedKey.set(VECTOR_KEY, 8);
    const receiver = new SenderKeyManager();
    await receiver.importPeerKey(VECTOR_SSRC, VECTOR_EPOCH, paddedKey.subarray(8, 24));
    const pt = await receiver.decrypt(
      paddedHeader.subarray(4, 20), paddedCiphertext.subarray(5, 5 + ct.length),
      VECTOR_EPOCH, 1, VECTOR_SSRC,
    );
    expect(new TextDecoder().decode(pt)).toBe('Hello, voice data!');
  });

  it('accepts concurrent identical packets only once', async () => {
    const mgr = await managerWithVectorKey(VECTOR_SSRC, VECTOR_EPOCH);
    const ct = await mgr.encrypt(VECTOR_HEADER, new Uint8Array([1]), VECTOR_EPOCH, 10, VECTOR_SSRC);
    const results = await Promise.allSettled([
      mgr.decrypt(VECTOR_HEADER, ct, VECTOR_EPOCH, 10, VECTOR_SSRC),
      mgr.decrypt(VECTOR_HEADER, ct, VECTOR_EPOCH, 10, VECTOR_SSRC),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    await expect(mgr.decrypt(VECTOR_HEADER, ct, VECTOR_EPOCH, 10, VECTOR_SSRC)).rejects.toThrow('replay');
  });

  it('does not consume a receive slot for a forged packet', async () => {
    const mgr = await managerWithVectorKey(VECTOR_SSRC, VECTOR_EPOCH);
    const ct = await mgr.encrypt(VECTOR_HEADER, new Uint8Array([1]), VECTOR_EPOCH, 10, VECTOR_SSRC);
    const forged = ct.slice();
    forged[0] ^= 1;
    await expect(mgr.decrypt(VECTOR_HEADER, forged, VECTOR_EPOCH, 10, VECTOR_SSRC)).rejects.toThrow();
    expect(await mgr.decrypt(VECTOR_HEADER, ct, VECTOR_EPOCH, 10, VECTOR_SSRC)).toEqual(new Uint8Array([1]));
  });

  it('keeps replay detection across a repeated peer key announcement', async () => {
    const mgr = await managerWithVectorKey(VECTOR_SSRC, VECTOR_EPOCH);
    await mgr.importPeerKey(VECTOR_SSRC, VECTOR_EPOCH, VECTOR_KEY);
    const ct = await mgr.encrypt(VECTOR_HEADER, new Uint8Array([1]), VECTOR_EPOCH, 10, VECTOR_SSRC);
    await mgr.decrypt(VECTOR_HEADER, ct, VECTOR_EPOCH, 10, VECTOR_SSRC);
    await mgr.importPeerKey(VECTOR_SSRC, VECTOR_EPOCH, VECTOR_KEY);
    await expect(mgr.decrypt(VECTOR_HEADER, ct, VECTOR_EPOCH, 10, VECTOR_SSRC)).rejects.toThrow('replay');
  });

  it('keeps key rotation working when the wire epoch wraps', async () => {
    const sender = new SenderKeyManager();
    const receiver = new SenderKeyManager();
    for (let rotation = 0; rotation < 2; rotation++) {
      (sender as unknown as { localEpoch: number }).localEpoch = 255;
      const { epoch } = await sender.generateKey();
      expect(epoch).toBe(1);
      await receiver.importPeerKey(VECTOR_SSRC, epoch, await sender.exportKey());
      for (const sequence of [65535, 0]) {
        const ciphertext = await sender.encrypt(VECTOR_HEADER, new Uint8Array([1]), epoch, sequence, VECTOR_SSRC);
        expect(await receiver.decrypt(VECTOR_HEADER, ciphertext, epoch, sequence, VECTOR_SSRC)).toEqual(new Uint8Array([1]));
      }
    }
  });

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

    // A fresh receiver that never saw the pre-wrap frame (a viewer handed the
    // key after the wrap) does not open the post-wrap frame at ROC 0; it finds
    // ROC 1 by searching (WP-G23). The nonce it opened it with carries ROC 1 —
    // proving the ROC bytes actually feed the GCM nonce.
    const freshReceiver = new SenderKeyManager();
    freshReceiver.setPeerKey(
      VECTOR_SSRC,
      VECTOR_EPOCH,
      (mgr as unknown as { localKey: CryptoKey }).localKey,
    );
    const ivs: Uint8Array[] = [];
    const realDecrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, 'decrypt').mockImplementation(async (algo: any, key: any, data: any) => {
      const result = await realDecrypt(algo, key, data);
      ivs.push(new Uint8Array(algo.iv));
      return result;
    });
    try {
      const pt = await freshReceiver.decrypt(VECTOR_HEADER, ctWrap, VECTOR_EPOCH, 0, VECTOR_SSRC);
      expect(new TextDecoder().decode(pt)).toBe('after-wrap');
    } finally {
      spy.mockRestore();
    }
    // Only the successful call is recorded; bytes 7..11 are the ROC.
    expect(ivs).toHaveLength(1);
    expect(Array.from(ivs[0].subarray(7, 11))).toEqual([0, 0, 0, 1]);

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

describe('a receiver that starts on a key the sender has used for a while (WP-G23)', () => {
  /** Fast-forward a sender as if it had already sent `roc` wraps' worth of packets. */
  function fastForward(sender: SenderKeyManager, ssrc: number, epoch: number, roc: number, seq: number) {
    (sender as unknown as { sendRocState: Map<string, { roc: number; seq: number }> }).sendRocState.set(`${ssrc}:${epoch}`, { roc, seq });
  }

  it('finds the counter on the first packet and keeps decrypting across the next wrap', async () => {
    const ssrc = 0x5c12ee01;
    const epoch = 3;
    const sender = await managerWithVectorKey(ssrc, epoch);
    fastForward(sender, ssrc, epoch, 2, 65_530);
    const seqs = [65_531, 65_532, 65_535, 0, 1, 2];
    const frames: { seq: number; ct: Uint8Array }[] = [];
    for (const seq of seqs) {
      frames.push({ seq, ct: await sender.encrypt(VECTOR_HEADER, new Uint8Array([seq & 0xff]), epoch, seq, ssrc) });
    }
    const viewer = new SenderKeyManager();
    viewer.setPeerKey(ssrc, epoch, (sender as unknown as { localKey: CryptoKey }).localKey);
    for (const frame of frames) {
      expect(Array.from(await viewer.decrypt(VECTOR_HEADER, frame.ct, epoch, frame.seq, ssrc))).toEqual([frame.seq & 0xff]);
    }
    // The replay window still holds.
    await expect(viewer.decrypt(VECTOR_HEADER, frames[0].ct, epoch, frames[0].seq, ssrc)).rejects.toBeTruthy();
  });

  it('finds an SSRC again after the relay had it elsewhere for a few wraps', async () => {
    const ssrc = 0x35120317;
    const epoch = 1;
    const sender = await managerWithVectorKey(ssrc, epoch);
    const viewer = new SenderKeyManager();
    viewer.setPeerKey(ssrc, epoch, (sender as unknown as { localKey: CryptoKey }).localKey);
    for (let seq = 1; seq <= 3; seq += 1) {
      const ct = await sender.encrypt(VECTOR_HEADER, new Uint8Array([seq]), epoch, seq, ssrc);
      await viewer.decrypt(VECTOR_HEADER, ct, epoch, seq, ssrc);
    }
    // Three wraps later the viewer is back on this SSRC; its reference says ROC 0.
    fastForward(sender, ssrc, epoch, 3, 10);
    const opened: boolean[] = [];
    for (let seq = 11; seq < 11 + 70; seq += 1) {
      const ct = await sender.encrypt(VECTOR_HEADER, new Uint8Array([seq & 0xff]), epoch, seq, ssrc);
      opened.push(await viewer.decrypt(VECTOR_HEADER, ct, epoch, seq, ssrc).then(() => true, () => false));
    }
    // One bad packet is not a lost counter: the 64th failure in a row searches.
    expect(opened.slice(0, 63).every((ok) => !ok)).toBe(true);
    expect(opened.slice(63).every((ok) => ok)).toBe(true);
  });

  it.each([
    { name: 'one missed wrap', anchorRoc: 0, anchorSeq: 1000, resumedRoc: 1, resumedSeq: 2000 },
    { name: 'a stale sequence within the current ROC', anchorRoc: 1, anchorSeq: 1000, resumedRoc: 1, resumedSeq: 50000 },
    { name: 'fresh sequences overlapping old replay slots', anchorRoc: 0, anchorSeq: 20000, resumedRoc: 3, resumedSeq: 10000 },
  ])('recovers $name while still rejecting authenticated replays', async ({ anchorRoc, anchorSeq, resumedRoc, resumedSeq }) => {
    const ssrc = 0x35120318;
    const epoch = 1;
    const sender = await managerWithVectorKey(ssrc, epoch);
    const viewer = new SenderKeyManager();
    viewer.setPeerKey(ssrc, epoch, (sender as unknown as { localKey: CryptoKey }).localKey);
    // Populate receive slots which will overlap the returning stream's sequences.
    if (resumedSeq < anchorSeq) {
      for (let seq = resumedSeq; seq < resumedSeq + 70; seq += 1) {
        const ct = await sender.encrypt(VECTOR_HEADER, new Uint8Array([1]), epoch, seq, ssrc);
        await viewer.decrypt(VECTOR_HEADER, ct, epoch, seq, ssrc);
      }
    }
    fastForward(sender, ssrc, epoch, anchorRoc, anchorSeq - 1);
    const anchorCt = await sender.encrypt(VECTOR_HEADER, new Uint8Array([1]), epoch, anchorSeq, ssrc);
    await viewer.decrypt(VECTOR_HEADER, anchorCt, epoch, anchorSeq, ssrc);
    fastForward(sender, ssrc, epoch, resumedRoc, resumedSeq - 1);
    const opened: boolean[] = [];
    let lastCt: Uint8Array = new Uint8Array();
    for (let seq = resumedSeq; seq < resumedSeq + 70; seq += 1) {
      lastCt = await sender.encrypt(VECTOR_HEADER, new Uint8Array([2]), epoch, seq, ssrc);
      opened.push(await viewer.decrypt(VECTOR_HEADER, lastCt, epoch, seq, ssrc).then(() => true, () => false));
    }
    expect(opened.slice(0, 63).every((ok) => !ok)).toBe(true);
    expect(opened.slice(63).every((ok) => ok)).toBe(true);
    await expect(viewer.decrypt(VECTOR_HEADER, lastCt, epoch, resumedSeq + 69, ssrc)).rejects.toThrow('replay');
    await expect(viewer.decrypt(VECTOR_HEADER, anchorCt, epoch, anchorSeq, ssrc)).rejects.toThrow();
  });

  it('searches a stream that never opens only on its first failure and every 64th after', async () => {
    const ssrc = 0x0badc0de;
    const epoch = 1;
    const sender = await managerWithVectorKey(ssrc, epoch);
    const wrongKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 128 }, false, ['decrypt']);
    const viewer = new SenderKeyManager();
    viewer.setPeerKey(ssrc, epoch, wrongKey);
    const decrypt = vi.spyOn(crypto.subtle, 'decrypt');
    try {
      for (let seq = 1; seq <= 65; seq += 1) {
        const ct = await sender.encrypt(VECTOR_HEADER, new Uint8Array([1]), epoch, seq, ssrc);
        await expect(viewer.decrypt(VECTOR_HEADER, ct, epoch, seq, ssrc)).rejects.toBeTruthy();
      }
      // Two searches (packets 1 and 65) of 1 + 1024 tries, and 63 single tries.
      expect(decrypt).toHaveBeenCalledTimes(2 * 1025 + 63);
    } finally {
      decrypt.mockRestore();
    }
  });
});
