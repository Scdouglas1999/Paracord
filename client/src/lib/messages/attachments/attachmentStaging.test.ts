import { describe, expect, it } from 'vitest';
import type { VaultTransaction } from '../../crypto/accountVault';
import { bytesToBase64, encryptAttachmentBytes } from './attachmentCrypto';
import {
  STAGED_BODIES_NAMESPACE, collectUploadedDescriptors, listStagedAttachments, markStagedUploaded,
  nextPendingUpload, readStagedCiphertext, rekeyStagedAttachments, removeStagedAttachments,
  stageAttachments, type StageInput,
} from './attachmentStaging';

/**
 * A record store with the vault's semantics — staged writes, JSON values — so
 * the staging contract can be tested without IndexedDB. The real vault encrypts
 * every one of these records; the browser suite covers that.
 */
function fakeVault() {
  const records = new Map<string, string>();
  const tx: VaultTransaction = {
    get: async <T>(namespace: string, id: string) => {
      const stored = records.get(`${namespace}/${id}`);
      return (stored === undefined ? null : JSON.parse(stored)) as T | null;
    },
    list: async <T>(namespace: string) => [...records.entries()]
      .filter(([key]) => key.startsWith(`${namespace}/`))
      .map(([key, value]) => ({ id: key.slice(namespace.length + 1), value: JSON.parse(value) as T })),
    put: (namespace, id, value) => { records.set(`${namespace}/${id}`, JSON.stringify(value)); },
    remove: (namespace, id) => { records.delete(`${namespace}/${id}`); },
  };
  return { tx, records };
}

async function input(text: string): Promise<StageInput> {
  const sealed = await encryptAttachmentBytes(new TextEncoder().encode(text));
  return {
    ciphertext: sealed.ciphertext,
    objectName: '0123456789abcdef0123456789abcdef.bin',
    descriptor: {
      key: sealed.material.key, nonce: sealed.material.nonce, filename: 'note.txt',
      contentType: 'text/plain', size: sealed.size, sha256: sealed.sha256,
    },
  };
}

describe('durable encrypted attachment staging', () => {
  it('stores the ciphertext and reads it back whole', async () => {
    const { tx } = fakeVault();
    const staged = await input('a queued private file');
    stageAttachments(tx, 'message-1', 'channel-1', [staged]);

    const [record] = await listStagedAttachments(tx, 'message-1');
    expect(record.channelId).toBe('channel-1');
    expect(record.uploadedId).toBeUndefined();
    expect(Array.from(await readStagedCiphertext(tx, record))).toEqual(Array.from(staged.ciphertext));
  });

  it('never writes a readable copy of the file', async () => {
    const { tx, records } = fakeVault();
    const marker = 'PLAINTEXT-MARKER-must-not-be-stored';
    stageAttachments(tx, 'message-1', 'channel-1', [await input(marker)]);
    // The file key lives beside the body, and both are protected only by the
    // vault's own encryption — so the staged material must be ciphertext.
    for (const value of records.values()) expect(value).not.toContain(marker);
  });

  it('refuses to build a body before the server has the ciphertext', async () => {
    const { tx } = fakeVault();
    stageAttachments(tx, 'message-1', 'channel-1', [await input('pending upload')]);
    await expect(collectUploadedDescriptors(tx, 'message-1')).rejects.toThrow(/have not finished uploading/);
  });

  it('releases the staged body once the server holds it and keeps the reference', async () => {
    const { tx, records } = fakeVault();
    stageAttachments(tx, 'message-1', 'channel-1', [await input('uploaded file')]);
    const pending = await nextPendingUpload(tx, 'message-1');
    expect(pending).not.toBeNull();
    markStagedUploaded(tx, pending!.record, '987654321');

    expect(await nextPendingUpload(tx, 'message-1')).toBeNull();
    expect([...records.keys()].some(key => key.startsWith(`${STAGED_BODIES_NAMESPACE}/`))).toBe(false);
    const descriptors = await collectUploadedDescriptors(tx, 'message-1');
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0].id).toBe('987654321');
    expect(descriptors[0].filename).toBe('note.txt');
  });

  it('chunks a body larger than one record and reassembles it exactly', async () => {
    const { tx } = fakeVault();
    const large = new Uint8Array(500 * 1024);
    // getRandomValues is capped at 64 KiB per call.
    for (let offset = 0; offset < large.length; offset += 65_536) {
      crypto.getRandomValues(large.subarray(offset, Math.min(offset + 65_536, large.length)));
    }
    const sealed = await encryptAttachmentBytes(large);
    stageAttachments(tx, 'message-1', 'channel-1', [{
      ciphertext: sealed.ciphertext, objectName: '0123456789abcdef0123456789abcdef.bin',
      descriptor: { key: sealed.material.key, nonce: sealed.material.nonce, filename: 'big.bin',
        contentType: 'application/octet-stream', size: sealed.size, sha256: sealed.sha256 },
    }]);
    const [record] = await listStagedAttachments(tx, 'message-1');
    expect(record.chunks).toBeGreaterThan(1);
    expect(bytesToBase64(await readStagedCiphertext(tx, record))).toBe(bytesToBase64(sealed.ciphertext));
  });

  it('reports a body whose chunks are missing instead of sending a truncated file', async () => {
    const { tx, records } = fakeVault();
    stageAttachments(tx, 'message-1', 'channel-1', [await input('will be damaged')]);
    const [record] = await listStagedAttachments(tx, 'message-1');
    for (const key of [...records.keys()]) if (key.startsWith(`${STAGED_BODIES_NAMESPACE}/`)) records.delete(key);
    await expect(readStagedCiphertext(tx, record)).rejects.toThrow(/missing part of its encrypted body/);
  });

  it('discarding a queued message removes its attachments', async () => {
    const { tx, records } = fakeVault();
    stageAttachments(tx, 'message-1', 'channel-1', [await input('discard me')]);
    stageAttachments(tx, 'message-2', 'channel-1', [await input('keep me')]);
    await removeStagedAttachments(tx, 'message-1');

    expect(await listStagedAttachments(tx, 'message-1')).toHaveLength(0);
    expect(await listStagedAttachments(tx, 'message-2')).toHaveLength(1);
    expect([...records.keys()].filter(key => key.includes('message-1'))).toHaveLength(0);
  });

  it('moves uploaded attachments onto a replacement queue entry', async () => {
    const { tx } = fakeVault();
    stageAttachments(tx, 'message-1', 'channel-1', [await input('replaced send')]);
    const pending = await nextPendingUpload(tx, 'message-1');
    markStagedUploaded(tx, pending!.record, '111222333');

    await rekeyStagedAttachments(tx, 'message-1', 'message-9');
    expect(await listStagedAttachments(tx, 'message-1')).toHaveLength(0);
    expect((await collectUploadedDescriptors(tx, 'message-9')).map(d => d.id)).toEqual(['111222333']);
  });

  it('refuses to replace a queue entry whose attachments are not uploaded yet', async () => {
    const { tx } = fakeVault();
    stageAttachments(tx, 'message-1', 'channel-1', [await input('still uploading')]);
    await expect(rekeyStagedAttachments(tx, 'message-1', 'message-9')).rejects.toThrow(/finish uploading/);
  });
});
