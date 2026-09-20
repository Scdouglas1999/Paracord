import { describe, expect, it } from 'vitest';
import { groupEnrollmentReason, GROUP_ROSTER_UNLOADED_REASON, runtimeSendDecision } from './messagingReadiness';
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
  const enrolled = (id: string, username: string) => ({ id, username, public_key: 'a'.repeat(64) });
  it('permits a group whose members have all enrolled', () => {
    const roster = [enrolled('me', 'me'), enrolled('u2', 'ada'), enrolled('u3', 'bo')];
    expect(runtimeSendDecision(allowed, ready, true, 'group', 3, roster)).toEqual(allowed);
  });
  it('names the members a group is waiting on rather than blaming the build', () => {
    // A sender key is wrapped to every member, so somebody with no published
    // key is not a slow reader — they are a member no key can reach. The old
    // copy said group conversations were not encrypted yet, which was a fact
    // about the release and gave the sender nothing to act on.
    const roster = [enrolled('me', 'me'), { id: 'u2', username: 'ada', public_key: null }];
    expect(runtimeSendDecision(allowed, ready, true, 'group', 3, roster))
      .toEqual({ allowed: false, supported: true, reason: groupEnrollmentReason(['ada']) });
  });
  it('treats an unloaded roster as a wait, not a refusal about the room', () => {
    expect(runtimeSendDecision(allowed, ready, true, 'group', 3, []))
      .toEqual({ allowed: false, supported: true, reason: GROUP_ROSTER_UNLOADED_REASON });
  });
  it('answers a group’s own refusal ahead of a 1:1 encryption rung', () => {
    // The server marks a group channel `encrypted`, so the shared ladder would
    // otherwise answer "Set up encryption before sending this direct message" —
    // a sentence about a 1:1 that points at a page which cannot enrol somebody
    // else.
    const notEnrolled = { allowed: false, supported: true, reason: 'Set up encryption before sending this direct message.' };
    const roster = [enrolled('me', 'me'), { id: 'u2', username: 'ada', public_key: null }];
    expect(runtimeSendDecision(notEnrolled, { ...ready, encryption: 'setup' }, true, 'group', 3, roster).reason)
      .toBe(groupEnrollmentReason(['ada']));
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
