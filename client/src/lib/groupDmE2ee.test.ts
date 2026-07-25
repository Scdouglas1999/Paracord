import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from './crypto/util';
import { decryptGroupDmMessage, encryptGroupDmMessage } from './groupDmE2ee';
import {
  formatIdentityFingerprint,
  IdentityPinError,
  markIdentityVerified,
} from './keyVerification';

const mocks = vi.hoisted(() => {
  const profiles = new Map<string, Map<string, string>>();
  return {
    activeStore: new Map<string, string>(),
    activeUserId: '',
    nextRecordId: 1,
    profiles,
    records: [] as Array<{
      id: string;
      channel_id: string;
      sender_id: string;
      recipient_id: string;
      epoch: number;
      ciphertext: string;
      header?: string | null;
      created_at: string;
      acknowledged?: boolean;
    }>,
    postGroupSenderKeys: vi.fn(async (channelId: string, epoch: number, envelopes: Array<{
      recipient_id: string;
      ciphertext: string;
      header?: string | null;
    }>) => {
      for (const envelope of envelopes) {
        mocks.records.push({
          id: String(mocks.nextRecordId++),
          channel_id: channelId,
          sender_id: mocks.activeUserId,
          recipient_id: envelope.recipient_id,
          epoch,
          ciphertext: envelope.ciphertext,
          header: envelope.header,
          created_at: new Date(0).toISOString(),
          acknowledged: false,
        });
      }
      return { status: 204 };
    }),
    getGroupSenderKeys: vi.fn(async (channelId: string, sinceEpoch?: number) => ({
      data: {
        sender_keys: mocks.records.filter(
          (record) =>
            record.channel_id === channelId &&
            record.recipient_id === mocks.activeUserId &&
            (!record.acknowledged || sinceEpoch != null) &&
            (sinceEpoch == null || record.epoch >= sinceEpoch),
        ),
      },
    })),
    ackGroupSenderKeys: vi.fn(async (
      channelId: string,
      payload: { sender_id?: string; up_to_epoch?: number },
    ) => {
      let acknowledged = 0;
      for (const record of mocks.records) {
        if (
          record.channel_id === channelId &&
          record.recipient_id === mocks.activeUserId &&
          (payload.sender_id == null || record.sender_id === payload.sender_id) &&
          (payload.up_to_epoch == null || record.epoch <= payload.up_to_epoch)
        ) {
          record.acknowledged = true;
          acknowledged += 1;
        }
      }
      return { data: { acknowledged } };
    }),
  };
});

vi.mock('./secureStorage', () => ({
  secureGet: vi.fn(async (key: string) => mocks.activeStore.get(key) ?? null),
  secureSet: vi.fn(async (key: string, value: string) => {
    mocks.activeStore.set(key, value);
  }),
  secureDelete: vi.fn(async (key: string) => {
    mocks.activeStore.delete(key);
  }),
}));

vi.mock('../api/channels', () => ({
  channelApi: {
    postGroupSenderKeys: mocks.postGroupSenderKeys,
    getGroupSenderKeys: mocks.getGroupSenderKeys,
    ackGroupSenderKeys: mocks.ackGroupSenderKeys,
  },
}));

interface TestUser {
  id: string;
  privateKey: Uint8Array;
  publicKey: string;
}

function makeUser(id: string): TestUser {
  const privateKey = ed25519.utils.randomSecretKey();
  return {
    id,
    privateKey,
    publicKey: bytesToHex(ed25519.getPublicKey(privateKey)),
  };
}

function setActiveUser(userId: string): void {
  mocks.activeUserId = userId;
  let store = mocks.profiles.get(userId);
  if (!store) {
    store = new Map<string, string>();
    mocks.profiles.set(userId, store);
  }
  mocks.activeStore = store;
}

function publicKeyResolver(users: TestUser[]): (userId: string) => string | null {
  const keys = new Map(users.map((user) => [user.id, user.publicKey]));
  return (userId) => keys.get(userId) ?? null;
}

function headerEpoch(payload: { header?: string }): number {
  return JSON.parse(payload.header || '{}').epoch;
}

describe('groupDmE2ee', () => {
  const channelId = 'group-channel-1';

  beforeEach(() => {
    localStorage.clear();
    mocks.activeUserId = '';
    mocks.activeStore = new Map<string, string>();
    mocks.profiles.clear();
    mocks.records.length = 0;
    mocks.nextRecordId = 1;
    mocks.postGroupSenderKeys.mockClear();
    mocks.getGroupSenderKeys.mockClear();
    mocks.ackGroupSenderKeys.mockClear();
  });

  it('distributes a sender key once, decrypts for recipients, and uses the cached key afterwards', async () => {
    const alice = makeUser('alice');
    const bob = makeUser('bob');
    const carol = makeUser('carol');
    const recipients = [alice, bob, carol].map((user) => ({
      id: user.id,
      public_key: user.publicKey,
    }));

    setActiveUser(alice.id);
    const firstPayload = await encryptGroupDmMessage(
      channelId,
      'hello group',
      alice.id,
      alice.privateKey,
      recipients,
    );

    expect(headerEpoch(firstPayload)).toBe(0);
    expect(mocks.postGroupSenderKeys).toHaveBeenCalledTimes(1);
    expect(mocks.postGroupSenderKeys).toHaveBeenCalledWith(
      channelId,
      0,
      expect.arrayContaining([
        expect.objectContaining({ recipient_id: bob.id }),
        expect.objectContaining({ recipient_id: carol.id }),
      ]),
    );

    setActiveUser(bob.id);
    await expect(
      decryptGroupDmMessage(
        channelId,
        firstPayload,
        bob.id,
        bob.privateKey,
        publicKeyResolver([alice, bob, carol]),
      ),
    ).resolves.toBe('hello group');
    expect(mocks.ackGroupSenderKeys).toHaveBeenCalledWith(channelId, {
      sender_id: alice.id,
      up_to_epoch: 0,
    });

    setActiveUser(alice.id);
    const followUpPayload = await encryptGroupDmMessage(
      channelId,
      'cached delivery',
      alice.id,
      alice.privateKey,
      recipients,
    );
    expect(headerEpoch(followUpPayload)).toBe(0);
    expect(mocks.postGroupSenderKeys).toHaveBeenCalledTimes(1);

    mocks.getGroupSenderKeys.mockClear();
    setActiveUser(bob.id);
    await expect(
      decryptGroupDmMessage(
        channelId,
        followUpPayload,
        bob.id,
        bob.privateKey,
        publicKeyResolver([alice, bob, carol]),
      ),
    ).resolves.toBe('cached delivery');
    expect(mocks.getGroupSenderKeys).not.toHaveBeenCalled();
  });

  it('recovers an acknowledged sender key when local cache is lost', async () => {
    const alice = makeUser('alice');
    const bob = makeUser('bob');
    const recipients = [alice, bob].map((user) => ({
      id: user.id,
      public_key: user.publicKey,
    }));
    const resolvePublicKey = publicKeyResolver([alice, bob]);

    setActiveUser(alice.id);
    const firstPayload = await encryptGroupDmMessage(
      channelId,
      'initial delivery',
      alice.id,
      alice.privateKey,
      recipients,
    );

    setActiveUser(bob.id);
    await expect(
      decryptGroupDmMessage(channelId, firstPayload, bob.id, bob.privateKey, resolvePublicKey),
    ).resolves.toBe('initial delivery');
    expect(mocks.records[0]?.acknowledged).toBe(true);

    setActiveUser(alice.id);
    const followUpPayload = await encryptGroupDmMessage(
      channelId,
      'after cache loss',
      alice.id,
      alice.privateKey,
      recipients,
    );

    mocks.profiles.set(bob.id, new Map());
    mocks.getGroupSenderKeys.mockClear();
    setActiveUser(bob.id);
    await expect(
      decryptGroupDmMessage(channelId, followUpPayload, bob.id, bob.privateKey, resolvePublicKey),
    ).resolves.toBe('after cache loss');
    expect(mocks.getGroupSenderKeys).toHaveBeenCalledWith(channelId, 0);
  });

  it('rejects decryption when the recipient has no sender-key envelope', async () => {
    const alice = makeUser('alice');
    const bob = makeUser('bob');
    const dave = makeUser('dave');
    const recipients = [alice, bob].map((user) => ({
      id: user.id,
      public_key: user.publicKey,
    }));

    setActiveUser(alice.id);
    const payload = await encryptGroupDmMessage(
      channelId,
      'not for dave',
      alice.id,
      alice.privateKey,
      recipients,
    );

    setActiveUser(dave.id);
    await expect(
      decryptGroupDmMessage(
        channelId,
        payload,
        dave.id,
        dave.privateKey,
        publicKeyResolver([alice, bob, dave]),
      ),
    ).rejects.toThrow('No sender key available for this group DM message');
  });

  it('rotates the local sender key when group membership changes', async () => {
    const alice = makeUser('alice');
    const bob = makeUser('bob');
    const carol = makeUser('carol');
    const initialRecipients = [alice, bob].map((user) => ({
      id: user.id,
      public_key: user.publicKey,
    }));
    const expandedRecipients = [alice, bob, carol].map((user) => ({
      id: user.id,
      public_key: user.publicKey,
    }));
    const resolvePublicKey = publicKeyResolver([alice, bob, carol]);

    setActiveUser(alice.id);
    const firstPayload = await encryptGroupDmMessage(
      channelId,
      'before carol',
      alice.id,
      alice.privateKey,
      initialRecipients,
    );
    expect(headerEpoch(firstPayload)).toBe(0);

    setActiveUser(bob.id);
    await expect(
      decryptGroupDmMessage(channelId, firstPayload, bob.id, bob.privateKey, resolvePublicKey),
    ).resolves.toBe('before carol');

    setActiveUser(alice.id);
    const secondPayload = await encryptGroupDmMessage(
      channelId,
      'after carol',
      alice.id,
      alice.privateKey,
      expandedRecipients,
    );

    expect(headerEpoch(secondPayload)).toBe(1);
    expect(mocks.postGroupSenderKeys).toHaveBeenLastCalledWith(
      channelId,
      1,
      expect.arrayContaining([
        expect.objectContaining({ recipient_id: bob.id }),
        expect.objectContaining({ recipient_id: carol.id }),
      ]),
    );

    setActiveUser(carol.id);
    await expect(
      decryptGroupDmMessage(channelId, firstPayload, carol.id, carol.privateKey, resolvePublicKey),
    ).rejects.toThrow('No sender key available for this group DM message');

    await expect(
      decryptGroupDmMessage(channelId, secondPayload, carol.id, carol.privateKey, resolvePublicKey),
    ).resolves.toBe('after carol');

    setActiveUser(bob.id);
    await expect(
      decryptGroupDmMessage(channelId, secondPayload, bob.id, bob.privateKey, resolvePublicKey),
    ).resolves.toBe('after carol');
  });

  it('rotates the local sender key when a recipient identity key changes', async () => {
    const alice = makeUser('alice');
    const oldBob = makeUser('bob');
    const newBob = makeUser('bob');
    const initialRecipients = [alice, oldBob].map((user) => ({
      id: user.id,
      public_key: user.publicKey,
    }));
    const rotatedRecipients = [
      { id: alice.id, public_key: alice.publicKey },
      { id: newBob.id, public_key: newBob.publicKey },
    ];

    setActiveUser(alice.id);
    const firstPayload = await encryptGroupDmMessage(
      channelId,
      'before identity rotation',
      alice.id,
      alice.privateKey,
      initialRecipients,
    );
    expect(headerEpoch(firstPayload)).toBe(0);

    setActiveUser(oldBob.id);
    await expect(
      decryptGroupDmMessage(
        channelId,
        firstPayload,
        oldBob.id,
        oldBob.privateKey,
        publicKeyResolver([alice, oldBob]),
      ),
    ).resolves.toBe('before identity rotation');

    mocks.profiles.set(newBob.id, new Map());
    setActiveUser(alice.id);

    // The rotated key is server-supplied, so distributing the group key to it
    // must fail closed until Alice verifies it out of band.
    await expect(
      encryptGroupDmMessage(
        channelId,
        'after identity rotation',
        alice.id,
        alice.privateKey,
        rotatedRecipients,
      ),
    ).rejects.toBeInstanceOf(IdentityPinError);

    // Recovery path: Alice accepts the new fingerprint from the profile card.
    await markIdentityVerified(newBob.id, formatIdentityFingerprint(newBob.publicKey));

    const secondPayload = await encryptGroupDmMessage(
      channelId,
      'after identity rotation',
      alice.id,
      alice.privateKey,
      rotatedRecipients,
    );
    expect(headerEpoch(secondPayload)).toBe(1);

    setActiveUser(newBob.id);
    await expect(
      decryptGroupDmMessage(
        channelId,
        secondPayload,
        newBob.id,
        newBob.privateKey,
        publicKeyResolver([alice, newBob]),
      ),
    ).resolves.toBe('after identity rotation');

    mocks.profiles.set(oldBob.id, new Map());
    setActiveUser(oldBob.id);
    await expect(
      decryptGroupDmMessage(
        channelId,
        secondPayload,
        oldBob.id,
        oldBob.privateKey,
        publicKeyResolver([alice, oldBob]),
      ),
    ).rejects.toThrow('No sender key available for this group DM message');
  });
});
