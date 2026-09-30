import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserMediaEngine } from './browserMediaEngine';
import { MediaKeyring } from './mediaKeyring';
import type { SenderKeyManager } from './senderKeys';

// The media control plane puts every message on its own QUIC stream, so the
// order the relay sent them in is not the order the engine reads them in. These
// drive the engine's control handler in the orders a join and a rejoin produce.

const SELF = '100';
const ROOM = '9';
const VINCENT = '200';

interface EngineInternals {
  localUserId: string | null;
  localRoomId: string | null;
  membershipSessionId: string | null;
  account: { assertCurrent(): void } | undefined;
  transport: { sendStreamControl: (message: unknown) => Promise<void>; disconnect: () => Promise<void> } | null;
  keyring: MediaKeyring;
  senderKeys: SenderKeyManager;
  handleStreamControlMessage(message: Record<string, unknown>): void;
  materializeRemoteParticipant(userId: string): Promise<void>;
}

async function joinedEngine() {
  const engine = new BrowserMediaEngine();
  const internals = engine as unknown as EngineInternals;
  internals.localUserId = SELF;
  internals.localRoomId = ROOM;
  internals.membershipSessionId = 'receipt-self';
  internals.account = { assertCurrent: () => {} };
  const sent: Array<Record<string, unknown>> = [];
  internals.transport = {
    sendStreamControl: async (message) => {
      sent.push(message as Record<string, unknown>);
    },
    disconnect: async () => {},
  };
  // Decoders and playback are not under test; only whether the key lands.
  vi.spyOn(internals, 'materializeRemoteParticipant').mockResolvedValue(undefined);
  await internals.senderKeys.generateKey();
  const lost = vi.fn();
  engine.onTransportLost(lost);
  const imported = vi.spyOn(internals.senderKeys, 'importPeerKey');
  return { engine, internals, sent, lost, imported };
}

function participant(userId: string, sessionId: string, keyring: MediaKeyring) {
  return { userId, sessionId, videoCapabilities: [], mediaPublicKey: keyring.publicKey };
}

async function audioKeyFrom(sender: MediaKeyring, recipientPublicKey: string, epoch: number) {
  sender.setPeerKey(SELF, recipientPublicKey);
  const wrapped = await sender.wrapSenderKey(`room:${ROOM}:audio`, new Uint8Array(16).fill(epoch), epoch, SELF);
  return { type: 'key_deliver', sender_user_id: VINCENT, epoch, ciphertext: Array.from(wrapped) };
}

async function until(check: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BrowserMediaEngine key exchange across joins and rejoins', () => {
  it('applies a newcomer’s key that was read before its session_participant_join', async () => {
    const { engine, internals, lost, imported } = await joinedEngine();
    internals.handleStreamControlMessage({ type: 'session_state', participants: [] });

    const vincent = MediaKeyring.create();
    internals.handleStreamControlMessage(await audioKeyFrom(vincent, internals.keyring.publicKey, 3));
    internals.handleStreamControlMessage({
      type: 'session_participant_join',
      participant: participant(VINCENT, 'receipt-vincent', vincent),
    });

    await until(() => imported.mock.calls.length > 0);
    expect(imported.mock.calls[0][1]).toBe(3);
    expect(Array.from(imported.mock.calls[0][2] as Uint8Array)).toEqual(Array.from(new Uint8Array(16).fill(3)));
    expect(lost).not.toHaveBeenCalled();
    await engine.disconnect();
  });

  it('applies a rejoining peer’s key that was read between its leave and its new join', async () => {
    const { engine, internals, lost, imported } = await joinedEngine();
    const vincentBefore = MediaKeyring.create();
    internals.handleStreamControlMessage({
      type: 'session_state',
      participants: [participant(VINCENT, 'receipt-vincent-1', vincentBefore)],
    });
    internals.handleStreamControlMessage({
      type: 'session_participant_leave',
      user_id: VINCENT,
      session_id: 'receipt-vincent-1',
    });

    const vincentAgain = MediaKeyring.create();
    internals.handleStreamControlMessage(await audioKeyFrom(vincentAgain, internals.keyring.publicKey, 1));
    internals.handleStreamControlMessage({
      type: 'session_participant_join',
      participant: participant(VINCENT, 'receipt-vincent-2', vincentAgain),
    });

    await until(() => imported.mock.calls.length > 0);
    expect(Array.from(imported.mock.calls[0][2] as Uint8Array)).toEqual(Array.from(new Uint8Array(16).fill(1)));
    expect(lost).not.toHaveBeenCalled();
    await engine.disconnect();
  });

  it('keeps a rejoiner’s new key when its join overtakes the old call’s leave', async () => {
    const { engine, internals, lost, sent } = await joinedEngine();
    const vincentBefore = MediaKeyring.create();
    internals.handleStreamControlMessage({
      type: 'session_state',
      participants: [participant(VINCENT, 'receipt-vincent-1', vincentBefore)],
    });
    const vincentAgain = MediaKeyring.create();
    internals.handleStreamControlMessage({
      type: 'session_participant_join',
      participant: participant(VINCENT, 'receipt-vincent-2', vincentAgain),
    });
    // The old call's leave names the old receipt, so it must not remove the new call.
    internals.handleStreamControlMessage({
      type: 'session_participant_leave',
      user_id: VINCENT,
      session_id: 'receipt-vincent-1',
    });

    // This engine's audio key reaches the rejoiner under its *new* call key:
    // the rejoin rotates the voice key and announces it to the new call key.
    // (The roster's own announce was wrapped to the call key Vincent held in
    // that roster, before the rejoin was known.)
    vincentAgain.setPeerKey(SELF, internals.keyring.publicKey);
    await until(() => sent.filter((message) => message.type === 'key_announce').length >= 2);
    const announces = sent.filter((message) => message.type === 'key_announce');
    const last = announces[announces.length - 1] as { encrypted_keys: Array<[string, number[]]> | Record<string, number[]> };
    const entries = Array.isArray(last.encrypted_keys) ? last.encrypted_keys : Object.entries(last.encrypted_keys);
    const forVincent = entries.find(([recipient]) => String(recipient) === VINCENT);
    expect(forVincent).toBeDefined();
    const opened = await vincentAgain.unwrapSenderKey(`room:${ROOM}:audio`, SELF, Uint8Array.from(forVincent![1]));
    expect(opened?.rawKey.byteLength).toBe(16);
    expect(lost).not.toHaveBeenCalled();
    await engine.disconnect();
  });

  it('does not fail the call when someone leaves while this engine is announcing to them', async () => {
    const { engine, internals, lost, sent } = await joinedEngine();
    const vincent = MediaKeyring.create();
    const brendanId = '300';
    const brendan = MediaKeyring.create();
    // The roster arrives and the engine starts announcing to both; Vincent's
    // leave lands before the wrapping does.
    internals.handleStreamControlMessage({
      type: 'session_state',
      participants: [participant(VINCENT, 'receipt-vincent', vincent), participant(brendanId, 'receipt-brendan', brendan)],
    });
    internals.handleStreamControlMessage({
      type: 'session_participant_leave',
      user_id: VINCENT,
      session_id: 'receipt-vincent',
    });

    await until(() => sent.filter((message) => message.type === 'key_announce').length >= 2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(lost).not.toHaveBeenCalled();
    // The roster's announce was wrapped for whoever was in the call when it
    // started; Vincent's leave then rotated the voice key, and the new key
    // went to Brendan alone.
    const announces = sent.filter((message) => message.type === 'key_announce');
    const last = announces[announces.length - 1];
    const recipients = (last.encrypted_keys as Array<[string, number[]]>).map(([recipient]) => recipient);
    expect(recipients).toEqual([brendanId]);
    expect(last.epoch as number).toBeGreaterThan(announces[0].epoch as number);
    await engine.disconnect();
  });

  it('still fails the call loudly on a key sealed to a call key it does not hold', async () => {
    const { engine, internals, lost, imported } = await joinedEngine();
    const vincent = MediaKeyring.create();
    internals.handleStreamControlMessage({
      type: 'session_state',
      participants: [participant(VINCENT, 'receipt-vincent', vincent)],
    });
    // Sealed to this account's call key from an earlier join, not this one.
    const earlierSelf = MediaKeyring.create();
    internals.handleStreamControlMessage(await audioKeyFrom(vincent, earlierSelf.publicKey, 2));

    await until(() => lost.mock.calls.length > 0);
    expect(String(lost.mock.calls[0][0])).toContain('could not be opened');
    expect(imported).not.toHaveBeenCalled();
    await engine.disconnect();
  });
});
