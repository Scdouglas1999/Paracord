import { describe, expect, it } from 'vitest';
import { runtimeSendDecision } from './messagingReadiness';
import type { MessagingSnapshot } from './accountMessagingRuntime';
const allowed = { allowed: true, supported: true, reason: null };
const ready: MessagingSnapshot = { storage: 'ready', synchronization: 'ready', encryption: 'ready', error: null, encryptionError: null, previousEpoch: null, draftGeneration: 0, queue: [], mutations: [], recovery: [] };
describe('production send readiness', () => {
  it('permits ordinary channels without Signal enrollment', () => {
    expect(runtimeSendDecision(allowed, { ...ready, encryption: 'setup' }, false, 'channel', 0)).toEqual(allowed);
  });
  it.each(['error', 'review', 'opening', 'awaiting-handshake'] as const)('blocks acceptance while encrypted local storage is %s', storage => {
    expect(runtimeSendDecision(allowed, { ...ready, storage }, false, 'channel').allowed).toBe(false);
  });
  it('blocks group encryption until its account-owned producer is integrated', () => {
    expect(runtimeSendDecision(allowed, ready, true, 'group', 3)).toMatchObject({ allowed: false, supported: false });
  });
  it('blocks only the conversation needing a legacy-session decision', () => {
    const state: MessagingSnapshot = { ...ready, encryptionRecovery: { kind: 'legacy-session', channelId: 'first' } };
    expect(runtimeSendDecision(allowed, state, true, 'first').allowed).toBe(false);
    expect(runtimeSendDecision(allowed, state, true, 'second')).toEqual(allowed);
  });
  it('preserves server permission denial ahead of local setup hints', () => {
    const denied = { allowed: false, supported: true, reason: 'Permission revoked' };
    expect(runtimeSendDecision(denied, { ...ready, storage: 'error' }, true, 'channel')).toEqual(denied);
  });
  it('blocks delivery during recovery while preserving readiness in unrelated conversations', () => {
    expect(runtimeSendDecision(allowed, { ...ready, synchronization: 'recovering' }, false, 'channel').allowed).toBe(false);
    const state = { ...ready, channelErrors: { first: 'History retained for review' } };
    expect(runtimeSendDecision(allowed, state, true, 'first').allowed).toBe(false);
    expect(runtimeSendDecision(allowed, state, false, 'second')).toEqual(allowed);
  });
});
