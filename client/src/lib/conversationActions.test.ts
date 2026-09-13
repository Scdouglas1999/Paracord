import { describe, expect, it } from 'vitest';
import { CONVERSATION_ACTIONS, readConversationCapabilities, resolveConversationActions, type ConversationCapabilities, type ConversationPlatform } from './conversationActions';
const platform: ConversationPlatform = { secureContext: true, files: true, microphone: true, screenShare: true };
function caps(encrypted = false): ConversationCapabilities {
  return { version: 1, channel_id: 'channel', user_id: 'account', encrypted, own_identity_enrolled: true, peers_ready: true,
    actions: Object.fromEntries(CONVERSATION_ACTIONS.map(action => [action, { supported: true, allowed: true, reason: null }])) as ConversationCapabilities['actions'] };
}
describe('conversation action decisions', () => {
  it('keeps every action unavailable until an owned server response is known', () => {
    for (const action of Object.values(resolveConversationActions(null, platform, 'ready'))) expect(action.allowed).toBe(false);
    expect(() => readConversationCapabilities(caps(), 'other-channel', 'account')).toThrow(/different conversation/);
    expect(() => readConversationCapabilities(caps(), 'channel', 'other-account')).toThrow(/different conversation/);
  });
  it('rejects an incomplete or contradictory capability contract', () => {
    expect(() => readConversationCapabilities({ ...caps(), version: 2 }, 'channel', 'account')).toThrow();
    const server = caps(); server.actions.poll = { supported: false, allowed: true, reason: null };
    expect(() => readConversationCapabilities(server, 'channel', 'account')).toThrow(/invalid action/);
  });
  it('never overrides server permission or feature denial with platform or encryption readiness', () => {
    const server = caps(); server.actions.poll = { supported: false, allowed: false, reason: 'Encrypted polls are not supported.' };
    server.actions.attach = { supported: true, allowed: false, reason: 'No attachment permission.' };
    const actions = resolveConversationActions(server, platform, 'ready');
    expect(actions.poll).toEqual(server.actions.poll); expect(actions.attach).toEqual(server.actions.attach);
    expect(actions.send.allowed).toBe(true);
  });
  it.each(['setup', 'unlock', 'identity_mismatch'] as const)('blocks encrypted sending for %s while retaining server support', readiness => {
    const actions = resolveConversationActions(caps(true), platform, readiness);
    expect(actions.send).toMatchObject({ allowed: false, supported: true });
    expect(actions.send.reason).toBeTruthy();
  });
  it('distinguishes recipient setup from local unlock and blocks unfinished encrypted producers', () => {
    const server = caps(true); server.peers_ready = false;
    const actions = resolveConversationActions(server, platform, 'ready');
    expect(actions.send.reason).toContain('recipient');
    // Attaching is produced by the encrypted attachment path, so it is gated on
    // the same recipient readiness as sending rather than being unsupported.
    expect(actions.attach).toMatchObject({ allowed: false, supported: true });
    expect(actions.attach.reason).toContain('recipient');
    // Encrypted scheduling has no producer yet and stays unsupported.
    expect(actions.schedule).toMatchObject({ allowed: false, supported: false });
    server.peers_ready = true;
    expect(resolveConversationActions(server, platform, 'ready').attach.allowed).toBe(true);
    expect(resolveConversationActions(server, platform, 'ready', { encryptedAttachments: false, encryptedScheduling: false }).attach)
      .toMatchObject({ allowed: false, supported: false });
    expect(resolveConversationActions(server, platform, 'ready', { encryptedAttachments: true, encryptedScheduling: true }).schedule.allowed).toBe(true);
  });
  it('applies secure-context and device support to media and uploads', () => {
    const insecure = resolveConversationActions(caps(), { ...platform, secureContext: false }, 'ready');
    expect(insecure.voice.reason).toContain('HTTPS'); expect(insecure.send.allowed).toBe(true);
    const unsupported = resolveConversationActions(caps(), { ...platform, files: false, screenShare: false }, 'ready');
    expect(unsupported.attach.allowed).toBe(false); expect(unsupported.screen_share.allowed).toBe(false); expect(unsupported.voice.allowed).toBe(true);
  });
});
