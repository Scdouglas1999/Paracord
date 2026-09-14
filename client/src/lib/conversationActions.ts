export const CONVERSATION_ACTIONS = ['send', 'poll', 'schedule', 'attach', 'summary', 'voice', 'video', 'screen_share'] as const;
export type ConversationAction = typeof CONVERSATION_ACTIONS[number];
export interface ActionDecision { supported: boolean; allowed: boolean; reason: string | null }
export interface ConversationCapabilities {
  version: 1;
  channel_id: string;
  user_id: string;
  encrypted: boolean;
  own_identity_enrolled: boolean;
  peers_ready: boolean;
  actions: Record<ConversationAction, ActionDecision>;
}
export interface ConversationPlatform {
  secureContext: boolean;
  files: boolean;
  microphone: boolean;
  screenShare: boolean;
}
export type EncryptionReadiness = 'ready' | 'setup' | 'unlock' | 'identity_mismatch';
export interface ClientConversationFeatures { encryptedAttachments: boolean; encryptedScheduling: boolean }
// Enable these only when their corresponding encrypted producer is integrated.
// `encryptedAttachments` is on because the client-side producer exists: files
// for an encrypted conversation are encrypted per-file on this device and the
// server only ever receives opaque ciphertext (see
// `lib/messages/attachments/`). Group DMs are still refused, by the runtime
// decision in `lib/messages/messagingReadiness.ts`, because their message
// encryption itself has not been migrated yet.
export const CLIENT_CONVERSATION_FEATURES: ClientConversationFeatures = { encryptedAttachments: true, encryptedScheduling: false };

export function readConversationCapabilities(value: unknown, channelId: string, userId: string): ConversationCapabilities {
  const caps = value as ConversationCapabilities | null;
  if (!caps || caps.version !== 1 || caps.channel_id !== channelId || caps.user_id !== userId
    || typeof caps.encrypted !== 'boolean' || typeof caps.own_identity_enrolled !== 'boolean' || typeof caps.peers_ready !== 'boolean') {
    throw new Error('The instance returned capabilities for an unsupported contract or a different conversation.');
  }
  for (const action of CONVERSATION_ACTIONS) {
    const decision = caps.actions?.[action];
    if (!decision || typeof decision.supported !== 'boolean' || typeof decision.allowed !== 'boolean'
      || (decision.reason !== null && typeof decision.reason !== 'string')
      || (decision.allowed && (!decision.supported || decision.reason !== null))
      || (!decision.allowed && !decision.reason)) throw new Error('The instance returned an invalid action decision.');
  }
  return caps;
}

/**
 * What to do with an action while the instance's answer is missing.
 *
 * `blocked` is right while the probe is still in the air: we genuinely do not
 * know yet, and it lasts a moment. `permissive` is right once the probe has
 * *failed* — a capability check that lost a race with a token refresh is not a
 * permission decision, and a composer that stays dead until the window happens
 * to regain focus is the worst possible reading of one. Let the person type and
 * send; the instance refuses it in the one place that is authoritative.
 */
export type UnresolvedCapabilityPolicy = 'blocked' | 'permissive';

/** Device-level gating that holds whatever the instance says about the room. */
function applyPlatformLimits(
  action: ConversationAction,
  decision: ActionDecision,
  platform: ConversationPlatform,
  blocked: (reason: string, supported?: boolean) => ActionDecision,
): ActionDecision {
  let next = decision;
  if (next.allowed && action === 'attach' && !platform.files) next = blocked('File uploads are not supported by this device.', false);
  if (next.allowed && ['voice', 'video', 'screen_share'].includes(action)) {
    if (!platform.secureContext) next = blocked('Open Paracord over HTTPS or in the desktop app to make a call.');
    else if (!platform.microphone) next = blocked('This device does not support microphone access.', false);
    else if (action === 'screen_share' && !platform.screenShare) next = blocked('Screen sharing is not supported by this device.', false);
  }
  return next;
}

export function resolveConversationActions(
  server: ConversationCapabilities | null,
  platform: ConversationPlatform,
  encryption: EncryptionReadiness,
  features: ClientConversationFeatures = CLIENT_CONVERSATION_FEATURES,
  unavailable = 'Checking conversation actions…',
  unresolved: UnresolvedCapabilityPolicy = 'blocked',
): Record<ConversationAction, ActionDecision> {
  const result = {} as Record<ConversationAction, ActionDecision>;
  const blocked = (reason: string, supported = true): ActionDecision => ({ supported, allowed: false, reason });
  for (const action of CONVERSATION_ACTIONS) {
    let decision = server ? { ...server.actions[action] }
      : unresolved === 'permissive' ? { supported: true, allowed: true, reason: null }
      : blocked(unavailable);
    if (!server) {
      result[action] = applyPlatformLimits(action, decision, platform, blocked);
      continue;
    }
    if (decision.allowed && server) {
      if (server.encrypted && action === 'attach' && !features.encryptedAttachments) {
        decision = blocked('Encrypted file attachments are not available in this client yet.', false);
      } else if (server.encrypted && action === 'schedule' && !features.encryptedScheduling) {
        decision = blocked('Encrypted message scheduling is not available in this client yet.', false);
      } else if (server.encrypted && ['send', 'attach', 'schedule'].includes(action)) {
        if (!platform.secureContext) decision = blocked('Open Paracord over HTTPS or in the desktop app to use encryption.');
        else if (!server.own_identity_enrolled || encryption === 'setup') decision = blocked('Set up encryption before sending this direct message.');
        // A device holding no identity, or a different one, cannot "unlock"
        // its way out: there is nothing here to unlock. Say what is true, and
        // the composer offers the one page that resolves both shapes of it.
        else if (encryption === 'identity_mismatch') decision = blocked('This device does not hold the encryption identity enrolled for this account.');
        else if (encryption === 'unlock') decision = blocked('Unlock your encryption identity before sending this direct message.');
        else if (!server.peers_ready) decision = blocked('The recipient needs to finish encryption setup before you can send a message.');
      }
      decision = applyPlatformLimits(action, decision, platform, blocked);
    }
    result[action] = decision;
  }
  return result;
}
