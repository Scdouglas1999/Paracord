import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createDurableGroup, type GroupSenderKeyApi } from './durableGroup';
import type { GroupMember, IncomingSenderKeyEnvelope } from '../crypto/groupSenderKeys';
import { createIdentityTrustVault, installIdentityTrustVault, resetIdentityTrust } from '../../test/identityTrustVaultMock';
import { bytesToHex } from '../crypto/util';
import type { AccountVault } from '../crypto/accountVault';
import type { Message, SendMessageRequest } from '../../types';
import type { DurableIntent } from './durableOutbox';
import { decodeEncryptedBody, type SealedForward } from './attachments/attachmentEnvelope';

const LOCAL_SERVER_ID = '__local__';
const channelId = '900000000000000001';
const messageId = '123456789012345678';

function makeUser(id: string) {
  const privateKey = ed25519.utils.randomSecretKey();
  return { id, privateKey, publicKey: bytesToHex(ed25519.getPublicKey(privateKey)) };
}

/** The server's sender-key table, enforcing the membership rule the route does. */
function makeServer() {
  const rows: Array<IncomingSenderKeyEnvelope & { channel_id: string }> = [];
  let current = 'v1';
  const api = (senderId: string): GroupSenderKeyApi => ({
    async postGroupSenderKeys(id, epoch, envelopes, membersVersion) {
      // The real route refuses a publish minted against a membership that has
      // moved; the harness has to, or the test proves nothing about it.
      if (membersVersion !== current) {
        const error = Object.assign(new Error('membership moved'), { isAxiosError: true, response: { status: 409 } });
        throw error;
      }
      for (const envelope of envelopes) {
        rows.push({ channel_id: id, sender_id: senderId, recipient_id: envelope.recipient_id, epoch, ciphertext: envelope.ciphertext, header: envelope.header });
      }
    },
    async getGroupSenderKeys(id) {
      return { data: { sender_keys: rows.filter(row => row.channel_id === id), members_version: current } };
    },
    async ackGroupSenderKeys() { return {}; },
  });
  return { rows, api, version: () => current, setVersion: (next: string) => { current = next; } };
}

function makeDevice(user: ReturnType<typeof makeUser>, api: GroupSenderKeyApi) {
  // The lane holds this exact object, so a spy installed on it is the one the
  // lane calls — a fresh api per assertion would make the check vacuous.
  vi.spyOn(api, 'getGroupSenderKeys');
  const records = new Map<string, unknown>();
  const trust = new Map<string, unknown>();
  const { vault } = createIdentityTrustVault(records);
  const scoped = Object.assign(vault as AccountVault, { scope: { serverId: LOCAL_SERVER_ID, userId: user.id } });
  return {
    user,
    api,
    vault: scoped,
    lane: createDurableGroup(scoped, user.privateKey, api),
    activate() { resetIdentityTrust(); installIdentityTrustVault(trust, user.id); },
  };
}

describe('durableGroup', () => {
  let server: ReturnType<typeof makeServer>;
  let alice: ReturnType<typeof makeDevice>, bob: ReturnType<typeof makeDevice>;
  let members: GroupMember[];
  let resolve: (id: string) => string | null;

  beforeEach(() => {
    resetIdentityTrust();
    server = makeServer();
    const a = makeUser('alice'), b = makeUser('bob');
    alice = makeDevice(a, server.api(a.id));
    bob = makeDevice(b, server.api(b.id));
    members = [a, b].map(user => ({ id: user.id, publicKey: user.publicKey }));
    const keys = new Map(members.map(member => [member.id, member.publicKey]));
    resolve = id => keys.get(id) ?? null;
  });

  async function aliceSends(content: string): Promise<SendMessageRequest & { nonce: string }> {
    alice.activate();
    const queued = await alice.lane.prepare(channelId, members, content, undefined, server.version());
    return JSON.parse(queued.serializedRequest) as SendMessageRequest & { nonce: string };
  }

  it('prepares a group send and opens it on the other device', async () => {
    const request = await aliceSends('good morning');
    expect(request.content).toBe('');
    expect(request.e2ee).toBeTruthy();

    bob.activate();
    await expect(bob.lane.decrypt(channelId, members, request.e2ee!, messageId, alice.user.id, resolve))
      .resolves.toBe('good morning');
  });

  it('refuses a message whose signed sender is not the account that posted it', async () => {
    // The server attributes authorship from the access token; the signature
    // names who sealed the body. A member who re-posted a peer's ciphertext
    // under their own account is exactly this mismatch.
    const request = await aliceSends('from alice');
    bob.activate();
    await expect(bob.lane.decrypt(channelId, members, request.e2ee!, messageId, bob.user.id, resolve))
      .rejects.toThrow('claims a different author than the one it was delivered under');
  });

  it('reuses one epoch across sends and mints a new one when the roster changes', async () => {
    await aliceSends('first');
    await aliceSends('second');
    expect(server.rows.filter(row => row.sender_id === alice.user.id)).toHaveLength(1);

    const carol = makeUser('carol');
    members = [...members, { id: carol.id, publicKey: carol.publicKey }];
    alice.activate();
    await alice.lane.prepare(channelId, members, 'with carol', undefined, server.version());
    const epochs = new Set(server.rows.filter(row => row.sender_id === alice.user.id).map(row => row.epoch));
    expect([...epochs].sort()).toEqual([0, 1]);
  });

  it('serves a cached plaintext without going back to the server', async () => {
    const request = await aliceSends('cached');
    bob.activate();
    await bob.lane.decrypt(channelId, members, request.e2ee!, messageId, alice.user.id, resolve);
    expect(bob.api.getGroupSenderKeys).toHaveBeenCalledTimes(1);

    await expect(bob.lane.decrypt(channelId, members, request.e2ee!, messageId, alice.user.id, resolve))
      .resolves.toBe('cached');
    expect(bob.api.getGroupSenderKeys).toHaveBeenCalledTimes(1);
  });

  it('can still read its own messages from an epoch it has rotated past', async () => {
    // The sender is the one member it never wraps a copy of the key to, so a
    // rotation used to make its own older messages unreadable as soon as the
    // plaintext cache was gone.
    const request = await aliceSends('written before the rotation');
    const carol = makeUser('carol');
    alice.activate();
    await alice.lane.prepare(channelId, [...members, { id: carol.id, publicKey: carol.publicKey }], 'after', undefined, server.version());

    // Drop the cached plaintext, leaving only the retired key to work from.
    await alice.vault.transact(async tx => {
      for (const { id } of await tx.list('messages.plaintext')) tx.remove('messages.plaintext', id);
    });
    await expect(alice.lane.decrypt(channelId, members, request.e2ee!, messageId, alice.user.id, resolve))
      .resolves.toBe('written before the rotation');
  });

  it('is refused by the server when the membership moved under it', async () => {
    // This is the property a client-only roster check cannot give: the server
    // owns dm_recipients, so it is the only party that can say "that key would
    // have gone to somebody who already left".
    server.setVersion('v2');
    alice.activate();
    await expect(alice.lane.prepare(channelId, members, 'stale roster', undefined, 'v1'))
      .rejects.toMatchObject({ response: { status: 409 } });
    expect(server.rows).toHaveLength(0);

    // Minting against the membership the server actually holds goes through,
    // and the epoch was not burned by the refusal.
    const request = await aliceSends('current roster');
    expect(server.rows.length).toBeGreaterThan(0);
    bob.activate();
    await expect(bob.lane.decrypt(channelId, members, request.e2ee!, messageId, alice.user.id, resolve))
      .resolves.toBe('current roster');
  });

  it('refuses to publish a key that names no membership at all', async () => {
    alice.activate();
    await expect(alice.lane.prepare(channelId, members, 'unnamed roster', undefined, null))
      .rejects.toThrow('membership has not loaded yet');
    expect(server.rows).toHaveLength(0);
  });

  it('claims only the sends it prepared', async () => {
    const request = await aliceSends('mine');
    const nonce = request.nonce;
    expect(await alice.vault.transact(tx => alice.lane.ownsSend(tx, nonce))).toBe(true);
    expect(await alice.vault.transact(tx => alice.lane.ownsSend(tx, 'some-other-nonce'))).toBe(false);
  });

  it('seals a forward’s attribution into the body and sends none of it in the clear', async () => {
    await aliceSends('warm up');
    const forward: SealedForward = {
      channelId: '900000000000000077', messageId: '900000000000000078', authorId: 'bob', authorName: 'Bob', sentAt: '2026-09-20T10:00:00Z',
    };
    const intent = {
      id: 'forward-1', nonce: 'forward-1', sequence: 9, channelId, draft: { content: 'the quote' }, revision: 'r1',
      createdAt: new Date().toISOString(), status: 'pending', attempts: 0, nextAttemptAt: 0, error: null,
      intent: { encryption: { kind: 'group', members }, sealedForward: forward },
    } as unknown as DurableIntent;
    alice.activate();
    const request = await alice.vault.transact(tx => alice.lane.prepareIntent(tx, intent, { members, membersVersion: server.version() }));
    expect(request.forwarded_from).toBeUndefined();
    const wire = JSON.stringify(request);
    expect(wire).not.toContain(forward.channelId);
    expect(wire).not.toContain(forward.messageId);

    bob.activate();
    const plaintext = await bob.lane.decrypt(channelId, members, request.e2ee!, messageId, alice.user.id, resolve);
    expect(decodeEncryptedBody(plaintext)).toEqual({ text: 'the quote', attachments: [], forward });

    // An edit replaces the whole body; it re-states the attribution.
    alice.activate();
    const edit = await alice.vault.transact(tx => alice.lane.prepareDeliveredEdit(tx, channelId, members, messageId, 'edit-1', 'the quote, edited', [], forward));
    const edited = JSON.parse(edit.serializedRequest) as SendMessageRequest;
    bob.activate();
    const reread = await bob.lane.decrypt(channelId, members, edited.e2ee!, messageId, alice.user.id, resolve);
    expect(decodeEncryptedBody(reread).forward).toEqual(forward);
  });

  it('refuses a forward that names its source both ways', async () => {
    await aliceSends('warm up');
    const intent = {
      id: 'forward-2', nonce: 'forward-2', sequence: 10, channelId, draft: { content: 'x' }, revision: 'r2',
      createdAt: new Date().toISOString(), status: 'pending', attempts: 0, nextAttemptAt: 0, error: null,
      intent: {
        encryption: { kind: 'group', members },
        forwardedFrom: { channel_id: '1', message_id: '2' },
        sealedForward: { channelId: '1', messageId: '2' },
      },
    } as unknown as DurableIntent;
    alice.activate();
    await expect(alice.vault.transact(tx => alice.lane.prepareIntent(tx, intent, { members, membersVersion: server.version() })))
      .rejects.toThrow('either in the clear or inside the encrypted body');
  });

  it('clears staged attachment state once the server acknowledges the send', async () => {
    const request = await aliceSends('with an ack');
    const message = { id: messageId, channel_id: channelId, nonce: request.nonce, author: { id: alice.user.id } } as Message;
    await expect(alice.vault.transact(tx => alice.lane.acknowledgeSend(tx, request.nonce, message))).resolves.toBeUndefined();

    const wrongAuthor = { ...message, author: { id: bob.user.id } } as Message;
    await expect(alice.vault.transact(tx => alice.lane.acknowledgeSend(tx, request.nonce, wrongAuthor)))
      .rejects.toThrow('belongs to another message');
  });
});
