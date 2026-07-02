import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '../crypto/util';
import { clearUnlockedPrivateKey, setUnlockedPrivateKey } from '../accountSession';
import {
  unwrapDeliveredMediaSenderKey,
  wrapMediaSenderKeyForRecipient,
} from './mediaSenderKeyEnvelope';
import { useAuthStore } from '../../stores/authStore';
import { useChannelStore } from '../../stores/channelStore';
import { useMemberStore } from '../../stores/memberStore';

function resetState(): void {
  clearUnlockedPrivateKey();
  useAuthStore.setState((state) => ({ ...state, user: null }));
  useChannelStore.setState((state) => ({
    ...state,
    channelsByGuild: {},
    channelsById: {},
    channels: [],
  }));
  useMemberStore.setState((state) => ({
    ...state,
    members: new Map(),
    membersLoaded: {},
    isLoading: false,
  }));
}

describe('mediaSenderKeyEnvelope', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    resetState();
  });

  it('wraps and unwraps a media sender key for a guild member recipient', async () => {
    const alicePrivateKey = ed25519.utils.randomSecretKey();
    const bobPrivateKey = ed25519.utils.randomSecretKey();
    const alicePublicKey = bytesToHex(ed25519.getPublicKey(alicePrivateKey));
    const bobPublicKey = bytesToHex(ed25519.getPublicKey(bobPrivateKey));

    setUnlockedPrivateKey(new Uint8Array(alicePrivateKey));
    useAuthStore.setState((state) => ({
      ...state,
      user: {
        id: '100',
        username: 'alice',
        discriminator: '0001',
        public_key: alicePublicKey,
        bot: false,
        system: false,
        flags: 0,
        created_at: new Date().toISOString(),
      },
    }));
    useMemberStore.setState((state) => ({
      ...state,
      members: new Map([
        [
          'guild-1',
          [
            {
              user: {
                id: '200',
                username: 'bob',
                discriminator: '0002',
                public_key: bobPublicKey,
                bot: false,
                system: false,
                flags: 0,
                created_at: new Date().toISOString(),
              },
              roles: [],
              joined_at: new Date().toISOString(),
              deaf: false,
              mute: false,
            },
          ],
        ],
      ]),
    }));

    const senderKey = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
    const wrapped = await wrapMediaSenderKeyForRecipient(
      'stream:stream-1:screen',
      senderKey,
      7,
      '200',
    );
    expect(wrapped).not.toBeNull();

    setUnlockedPrivateKey(new Uint8Array(bobPrivateKey));
    useAuthStore.setState((state) => ({
      ...state,
      user: {
        id: '200',
        username: 'bob',
        discriminator: '0002',
        public_key: bobPublicKey,
        bot: false,
        system: false,
        flags: 0,
        created_at: new Date().toISOString(),
      },
    }));
    useMemberStore.setState((state) => ({
      ...state,
      members: new Map([
        [
          'guild-1',
          [
            {
              user: {
                id: '100',
                username: 'alice',
                discriminator: '0001',
                public_key: alicePublicKey,
                bot: false,
                system: false,
                flags: 0,
                created_at: new Date().toISOString(),
              },
              roles: [],
              joined_at: new Date().toISOString(),
              deaf: false,
              mute: false,
            },
          ],
        ],
      ]),
    }));

    const unwrapped = await unwrapDeliveredMediaSenderKey(
      'stream:stream-1:screen',
      '100',
      wrapped!,
    );

    expect(unwrapped.epoch).toBe(7);
    expect(Array.from(unwrapped.rawKey)).toEqual(Array.from(senderKey));
  });

  it('rejects a raw 16-byte payload instead of trusting it as an unauthenticated key', async () => {
    // A bare 16-byte payload is never a legitimate delivered key: real keys are
    // wrapped in an authenticated envelope. Accepting it would let a malicious
    // relay force participants onto an attacker-known key. The old fast path
    // (epoch 0, no decryption) has been removed; this must now fail.
    const rawKey = Uint8Array.from({ length: 16 }, (_, index) => 255 - index);
    await expect(
      unwrapDeliveredMediaSenderKey('room:test:audio', '123', rawKey),
    ).rejects.toThrow();
  });
});
