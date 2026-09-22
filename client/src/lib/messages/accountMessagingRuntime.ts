import { createStore } from 'zustand/vanilla';
import axios from 'axios';
import { createKeysApi } from '../../api/keys';
import { uploadOpaqueCiphertext } from '../../api/files';
import { prepareEncryptedAttachments } from './attachments/attachmentProducer';
import { stageAttachments } from './attachments/attachmentStaging';
import type { ForwardedFromRequest, Message, MessageE2eePayload, SendMessageRequest } from '../../types';
import { useChannelStore } from '../../stores/channelStore';
import { useAccountStore } from '../../stores/accountStore';
import { useAuthStore } from '../../stores/authStore';
import { useServerListStore } from '../../stores/serverListStore';
import { registerSessionReset } from '../../stores/sessionReset';
import { getAccountChannelView } from '../channelView';
import { openAccountVault } from '../crypto/accountVaultSession';
import { openDeviceAccountVault } from '../crypto/deviceAccountVault';
import { createAccountPrekeyEnrollment, PrekeyEnrollmentError } from '../crypto/prekeyEnrollment';
import { MissingPrivatePrekeyError } from '../crypto/sessionManager';
import { DmE2eeError } from '../dmCipher';
import { registerIdentityTrustVault, releaseIdentityTrustVault } from '../crypto/identityTrust';
import { getDatabaseHistoryEpoch, subscribeDatabaseHistory } from '../databaseHistory';
import { logVoiceDiagnostic } from '../desktopDiagnostics';
import { DatabaseHistoryExpiredError } from '../operationContext';
import { accountScopeServerIds, getServerAccountScope, getServerUser } from '../serverIdentity';
import { accountScopeKey, LOCAL_SERVER_ID, type AccountScope } from '../serverScope';
import { createAccountDeliveredMutations } from './accountDeliveredMutations';
import { DeliveredMutations, DELETED_MESSAGES_NAMESPACE, type DeliveredMessageTarget, type DeliveredMutation } from './deliveredMutations';
import { createDeliveredDeletionTransport } from './deliveredMutationTransport';
import { DurableDelivery, createDeliveryTransport, createDeliveryDiscardTransport, createDeliveryResolutionTransport, DELIVERY_RECEIPTS_NAMESPACE, type DeliveryReceipt } from './durableDelivery';
import { createDeliveryEditTransport, createEditResolutionTransport } from './durableEdit';
import { createDurableDm } from './durableDm';
import { createDurableGroup } from './durableGroup';
import { createChannelApi } from '../../api/channels';
import type { GroupMember } from '../crypto/groupSenderKeys';
import { enqueueMessageIntent, isPreparedSend, listQueuedSends, type DurableIntent, type QueuedSend } from './durableOutbox';
import { assertLegacySignalReviewed, approveNewSignalSession, LegacySignalRecoveryError } from './legacySignalRecovery';
import { migrateLegacyMessageDrafts, RECOVERY_NAMESPACE, type RecoveryDraft } from './legacyRecovery';
import { archiveLocalMessagingHistory, bindMessagingHistory, type VaultHistoryState } from './runtimeHistory';
import { acceptEncryptedDraft } from './encryptedDraftSubmission';
import { EncryptedDraftController } from './encryptedDraftController';
import { assertSignalMessageId } from '../crypto/signalSessions';
import type { VaultTransaction } from '../crypto/accountVault';
import { createMessageRecoveryTransport, MessageRecoveryGapError, recoverChannelMessages, RECOVERY_ARCHIVE_NAMESPACE, RECOVERY_CURSOR_NAMESPACE, RECOVERY_STATE_NAMESPACE,
  stageLiveRecoveryMutation, withMessageRecoveryLock, type LiveRecoveryMutation, type RecoveryArchive, type RecoveryCursor, type RecoveryPage, type StoredRecoveryState } from './messageRecovery';

/**
 * A 4xx the server will keep answering the same way for the same request.
 *
 * 409 is excluded: that is the gap signal, which has its own handling. 429 is
 * excluded: a rate limit is temporary and must not durably block a channel.
 */
function isRecoveryRefusal(status: number | undefined): boolean {
  return status !== undefined && status >= 400 && status < 500 && status !== 409 && status !== 429;
}

/** No open is in flight, or its history could not be read. Never a real epoch. */
const NO_OPEN_EPOCH = Symbol('no-open-epoch');

export interface MessageDraft { revision: string; content: string }
/** Files destined for an encrypted conversation, with this server's size ceiling. */
export interface EncryptedAttachmentSubmission { files: readonly File[]; maxCiphertextBytes: number }
export interface RuntimeQueueRow { source: 'local' | 'identity'; record: QueuedSend }
export interface RuntimeMutationRow { source: 'local' | 'identity'; record: DeliveredMutation }
export type RuntimeMessageEvent = { kind: 'create' | 'edit'; message: Message } | { kind: 'delete'; channelId: string; messageId: string }
  | { kind: 'encryption-locked' | 'encryption-ready' }
  | { kind: 'authoritative'; channelId: string; present: Message[]; hidden: string[]; pending?: Message[] };
export interface MessagingSnapshot {
  storage: 'idle' | 'opening' | 'ready' | 'awaiting-handshake' | 'review' | 'error';
  encryption: 'setup' | 'locked' | 'enrolling' | 'ready' | 'recovery';
  error: string | null;
  encryptionError: string | null;
  encryptionRecovery?: { kind: 'legacy-prekeys' } | { kind: 'device-reenrollment' } | { kind: 'legacy-session'; channelId: string };
  previousEpoch: string | null;
  draftGeneration: number;
  queue: RuntimeQueueRow[];
  mutations: RuntimeMutationRow[];
  recovery: RecoveryDraft[];
  synchronization: 'awaiting-handshake' | 'recovering' | 'ready';
  channelErrors?: Record<string, string>;
}
type DeviceSession = Awaited<ReturnType<typeof openDeviceAccountVault>>;
type IdentitySession = Awaited<ReturnType<typeof openAccountVault>>;
type Lane = { session: DeviceSession | IdentitySession; driver: DurableDelivery; mutations: DeliveredMutations };
const draftsNamespace = 'messages.drafts';
const errorText = (error: unknown) => {
  const message = error instanceof Error ? error.message.trim() : '';
  if (message) return message;
  // An AEAD open that does not authenticate throws a `DOMException` named
  // OperationError whose `message` is the EMPTY STRING, and every surface that
  // reports encryption trouble — the composer's recovery notice, the per-channel
  // error map — gates on the text being non-empty. An empty message therefore
  // recorded the failure and then silenced it: a ciphertext altered in transit
  // rendered as an ordinary undecrypted placeholder with nothing said about it.
  // No error ever reaches a surface as the empty string.
  if (error instanceof Error && error.name === 'OperationError') {
    return 'A message in this conversation did not decrypt: its ciphertext failed authentication, so it may have been altered or sent with a key this device does not hold.';
  }
  return 'Encrypted messaging is unavailable.';
};
const pendingMessage = (message: Message): Message => ({ ...message, content: 'Loading message…', e2ee: null, message_revision: undefined });

/** One runtime owns account data; selecting another server does not retarget it. */
export class AccountMessagingRuntime {
  readonly store = createStore<MessagingSnapshot>(() => ({ storage: 'idle', encryption: 'locked', error: null, encryptionError: null, previousEpoch: null, draftGeneration: 0, queue: [], mutations: [], recovery: [], synchronization: 'awaiting-handshake' }));
  private readonly initialLease = crypto.randomUUID();
  private local: Lane | null = null;
  private identity: (Lane & { session: IdentitySession; dm: ReturnType<typeof createDurableDm>; group: ReturnType<typeof createDurableGroup> }) | null = null;
  private localOpening: Promise<void> | null = null;
  /** The history the in-flight local open was started against. */
  private localOpeningEpoch: string | null | typeof NO_OPEN_EPOCH = NO_OPEN_EPOCH;
  private identityOpening: Promise<void> | null = null;
  private generation = 0;
  private disposed = false;
  private readonly listeners = new Set<(event: RuntimeMessageEvent) => void>();
  private readonly seenReceipts = new Set<string>();
  private readonly draftControllers = new Map<string, EncryptedDraftController>();
  private readonly pendingDeletions = new Map<string, { channelId: string; messageId: string }>();
  private handshakeAccepted = false;
  private handshakeGeneration = 0;
  private recoveryAbort = new AbortController();
  private readonly recoveredChannels = new Set<string>();
  private readonly recoveryFailures = new Map<string, Error>();
  /**
   * Channels whose saved recovery position this runtime has already thrown
   * away once. One discard per channel per runtime: a second refusal is the
   * server's answer about the channel, not this device's stale bookmark.
   */
  private readonly discardedRecoveryCursors = new Set<string>();
  private readonly receiveFailures = new Map<string, Error>();
  private readonly knownMessageReaders = new Set<() => Message[]>();
  private readonly channelRecoveries = new Map<string, Promise<void>>();
  private inboxProcessing: { identity: NonNullable<AccountMessagingRuntime['identity']>; promise: Promise<void> } | null = null;
  private inboxRequested = false;
  private readonly changes: BroadcastChannel | null;
  constructor(readonly scope: AccountScope) {
    this.changes = typeof BroadcastChannel === 'function' ? new BroadcastChannel(`paracord:messaging:${accountScopeKey(scope)}`) : null;
    if (this.changes) this.changes.onmessage = () => { void this.refresh().catch(() => {}); this.local?.driver.wake(); this.local?.mutations.wake(); this.identity?.driver.wake(); this.identity?.mutations.wake(); };
  }
  private assertCurrent() {
    if (this.disposed || accountScopeKey(getServerAccountScope(this.scope.serverId) ?? { serverId: '', userId: '' }) !== accountScopeKey(this.scope)) throw new Error('This account messaging session ended.');
  }
  registerKnownMessages(read: () => Message[]) { this.knownMessageReaders.add(read); return () => this.knownMessageReaders.delete(read); }
  /** Capture before the first await; account sessions survive transport replacement. */
  captureGatewayLease() {
    const generation = this.handshakeGeneration; const signal = this.recoveryAbort.signal;
    return { signal, assertCurrent: () => { signal.throwIfAborted(); this.assertCurrent(); if (generation !== this.handshakeGeneration) throw new Error('Message recovery lost its connection ownership.'); } };
  }
  private assertDeliveryReady(channelId?: string) {
    this.assertCurrent();
    if (!this.handshakeAccepted || this.store.getState().synchronization !== 'ready') throw new Error('Wait for this account’s authenticated message recovery before sending.');
    if (channelId) {
      const failure = this.recoveryFailures.get(channelId) ?? this.receiveFailures.get(channelId); if (failure) throw failure;
      if (!this.recoveredChannels.has(channelId)) throw new Error('Wait for this conversation’s message recovery before sending.');
    }
  }
  // Through `errorText`, never `error.message`: a failed AEAD open carries the
  // empty string, and an empty per-channel error reads as no error at all.
  private updateChannelErrors() { this.store.setState({ channelErrors: Object.fromEntries([...this.recoveryFailures, ...this.receiveFailures].map(([id, error]) => [id, errorText(error)])) }); }
  /** Stop accepted network work immediately; a fresh handshake owns replacement drivers. */
  pauseForRecovery() {
    if (this.disposed) return;
    this.handshakeAccepted = false; this.handshakeGeneration++;
    this.recoveryAbort.abort(new Error('The authenticated message connection changed.')); this.recoveryAbort = new AbortController();
    this.recoveredChannels.clear(); this.channelRecoveries.clear();
    if (this.local) {
      const { session } = this.local; this.local.driver.stop(); this.local.mutations.stop();
      if (!session.signal.aborted) this.local = this.lane(session);
    }
    if (this.identity) {
      const { session, dm, group } = this.identity; this.identity.driver.stop(); this.identity.mutations.stop();
      if (!session.signal.aborted) this.identity = { ...this.lane(session, dm, group), session, dm, group };
    }
    this.store.setState({ synchronization: 'awaiting-handshake' });
  }
  private startDrivers() {
    if (!this.handshakeAccepted || this.store.getState().synchronization !== 'ready' || this.store.getState().storage !== 'ready') return;
    this.local?.driver.start(); this.local?.mutations.start();
    this.identity?.driver.start(); this.identity?.mutations.start();
  }
  private recoveryLifetime(session: DeviceSession) {
    const generation = this.handshakeGeneration;
    const signal = AbortSignal.any([session.signal, this.recoveryAbort.signal]);
    return { signal, assertCurrent: () => { signal.throwIfAborted(); session.assertCurrent(); this.assertCurrent(); if (generation !== this.handshakeGeneration) throw new Error('Message recovery lost its connection ownership.'); } };
  }
  private async knownMessages() {
    const channels = new Map<string, Set<string>>();
    const add = (channelId: string, messageId?: string) => { let ids = channels.get(channelId); if (!ids) { ids = new Set(); channels.set(channelId, ids); } if (messageId) ids.add(messageId); };
    for (const read of this.knownMessageReaders) for (const message of read()) add(message.channel_id, message.id);
    for (const lane of [this.local, this.identity]) {
      if (!lane || lane.session.signal.aborted) continue;
      for (const row of await listQueuedSends(lane.session.vault)) add(row.channelId);
      const mutations = await lane.mutations.snapshot();
      for (const row of mutations.mutations) add(row.target.channelId, row.target.messageId);
      for (const row of mutations.receipts) add(row.target.channelId, row.target.messageId);
      for (const { value } of await lane.session.vault.transact(tx => tx.list<DeliveryReceipt>(DELIVERY_RECEIPTS_NAMESPACE))) if (value.result.kind === 'message') add(value.channelId, value.result.message.id);
    }
    if (this.local) await this.local.session.vault.transact(async tx => {
      for (const { id } of await tx.list(RECOVERY_CURSOR_NAMESPACE)) add(id);
      for (const { id } of await tx.list('messages.recovery-blocks')) add(id);
      for (const { value } of await tx.list<StoredRecoveryState>(RECOVERY_STATE_NAMESPACE)) if (value.value.state === 'present') add(value.value.message.channel_id, value.value.message_id);
      for (const { value } of await tx.list<Message>('messages.encrypted-inbox')) add(value.channel_id, value.id);
    });
    return channels;
  }
  /** READY/RESUMED completes only after a bounded, durable authority fence. */
  async acceptHandshake(): Promise<void> {
    this.pauseForRecovery(); const ownership = this.captureGatewayLease(); await this.startLocal(); ownership.assertCurrent();
    const local = this.local; if (!local) throw new Error('Encrypted local message storage is unavailable.');
    const lifetime = this.recoveryLifetime(local.session as DeviceSession);
    if (!local.session.context.historyEpoch) throw new Error('Message recovery requires an authenticated server history.');
    this.store.setState({ synchronization: 'recovering' });
    if (this.store.getState().storage === 'review') {
      // Old-history records remain archived for explicit review. No old sender
      // or ratchet work can start against the authenticated replacement history.
      this.handshakeAccepted = true; this.store.setState({ synchronization: 'ready' }); return;
    }
    try {
      const known = await this.knownMessages(); lifetime.assertCurrent();
      for (const [channelId, ids] of known) await this.recoverChannel(channelId, [...ids]);
      lifetime.assertCurrent(); this.handshakeAccepted = true;
      this.store.setState({ synchronization: 'ready' });
      // Enrollment problems do not prevent ordinary channels from completing
      // authenticated recovery with their independent encrypted device vault.
      await this.enroll().catch(() => {}); lifetime.assertCurrent();
      await this.processEncryptedInbox(); lifetime.assertCurrent();
      // Authority is published while the handshake is still fenced. Readers
      // correctly refuse to decrypt then; once recovery commits, retry visible
      // ciphertext even when the identity stayed unlocked across reconnect.
      if (this.identity) for (const listener of this.listeners) listener({ kind: 'encryption-ready' });
      this.startDrivers(); await this.refresh();
    } catch (error) {
      lifetime.assertCurrent();
      // A handshake that failed is not a handshake in progress. Leaving
      // `synchronization` on 'recovering' is what turned one failure into a
      // permanently unusable account: nothing polls that state, the composer
      // stays disabled, and `MessagingRecoveryNotice` renders nothing for it —
      // so the user was given neither an explanation nor a control. The honest
      // state is 'awaiting-handshake', which the notice does explain and which
      // the next READY/RESUMED retries from.
      this.store.setState({ synchronization: 'awaiting-handshake', error: errorText(error) });
      const failed = '[messages] This account\u2019s authenticated message recovery did not complete.';
      console.warn(failed, error);
      logVoiceDiagnostic(failed, { error: errorText(error) });
      throw error;
    }
  }
  private async stageRecoveredDeletions(tx: VaultTransaction, page: RecoveryPage) {
    for (const state of page.states) {
      const canonical = await tx.get<StoredRecoveryState>(RECOVERY_STATE_NAMESPACE, JSON.stringify([page.channel_id, state.message_id]));
      if (canonical?.value.state === 'deleted') await this.local!.mutations.observeDeletedInTransaction(tx, { channelId: page.channel_id, messageId: state.message_id });
    }
  }
  private async publishChannelAuthority(channelId: string) {
    const ownership = this.captureGatewayLease();
    const local = this.local; if (!local) return;
    const result = await local.session.vault.transact(async tx => {
      const cursor = await tx.get<RecoveryCursor>(RECOVERY_CURSOR_NAMESPACE, channelId);
      if (this.recoveryFailures.has(channelId)) {
        const hidden = [...this.knownMessageReaders].flatMap(read => read().filter(message => message.channel_id === channelId).map(message => message.id));
        return { kind: 'authoritative' as const, channelId, present: [], hidden };
      }
      if (!cursor?.complete) return null;
      const present: Message[] = []; const hidden: string[] = []; const pending: Message[] = [];
      for (const { id, value: { value } } of await tx.list<StoredRecoveryState>(RECOVERY_STATE_NAMESPACE)) {
        if ((JSON.parse(id) as string[])[0] !== channelId) continue;
        if (value.state === 'deleted') hidden.push(value.message_id);
        else if (BigInt(value.revision) > BigInt(cursor.cursor)) pending.push(pendingMessage(value.message));
        else present.push(value.message);
      }
      return { kind: 'authoritative' as const, channelId, present, hidden, pending };
    });
    ownership.assertCurrent(); local.session.assertCurrent(); if (result) for (const listener of this.listeners) listener(result);
  }
  /**
   * Deliberately throw away this device's saved recovery position for
   * `channelId` and try the conversation again from the start. Answers whether
   * that worked.
   *
   * A cursor is the one part of a recovery request this device chose, so it is
   * the one part a refusal can be about — and a refused cursor is durable: it
   * is re-read from the vault on every handshake, so the same request is
   * re-sent, refused and rethrown for as long as the profile exists. Discarding
   * it costs an extra page fetch and is announced in the log; keeping it costs
   * the account.
   */
  private async retryFromDiscardedCursor(
    channelId: string,
    status: number,
    local: { session: DeviceSession },
    options: Parameters<typeof recoverChannelMessages>[0],
  ): Promise<boolean> {
    if (this.discardedRecoveryCursors.has(channelId)) return false;
    this.discardedRecoveryCursors.add(channelId);
    const discarded = await local.session.vault.transact(async tx => {
      const stored = await tx.get<RecoveryCursor>(RECOVERY_CURSOR_NAMESPACE, channelId);
      if (stored) tx.remove(RECOVERY_CURSOR_NAMESPACE, channelId);
      return stored ?? null;
    });
    // Never silent: discarding a recovery position is a decision about this
    // device's saved state, so it goes to the console *and* to the diagnostics
    // log the user can retrieve, where it survives the session.
    const announcement =
      `[messages] The server answered HTTP ${status} to this device's saved recovery position for channel ${channelId}` +
      (discarded ? ` (cursor ${discarded.cursor}, complete=${discarded.complete})` : ' (no saved position)') +
      '. Discarding it and recovering this conversation from the start.';
    console.warn(announcement);
    logVoiceDiagnostic(announcement);
    try {
      await recoverChannelMessages({ ...options, through: undefined });
      return true;
    } catch (retryError) {
      // An ownership or lifetime change is not this channel's failure.
      options.lifetime.assertCurrent();
      const gaveUp = `[messages] Recovering channel ${channelId} from the start also failed; this conversation is blocked for review.`;
      console.warn(gaveUp, retryError);
      logVoiceDiagnostic(gaveUp, { error: errorText(retryError) });
      return false;
    }
  }

  private async recoverChannel(channelId: string, knownIds: string[] = [], through?: string): Promise<void> {
    const ownership = this.captureGatewayLease();
    const prior = this.channelRecoveries.get(channelId);
    if (prior) await prior;
    ownership.assertCurrent();
    const local = this.local; if (!local) throw new Error('Encrypted local message storage is unavailable.');
    const lifetime = this.recoveryLifetime(local.session as DeviceSession);
    const run = (async () => {
      const fetchPage = createMessageRecoveryTransport(local.session.context, lifetime.signal);
      const options = { vault: local.session.vault, lifetime, channelId, knownIds, through, fetchPage, stage: (tx: VaultTransaction, page: RecoveryPage) => this.stageRecoveredDeletions(tx, page) };
      try {
        let cursor = await recoverChannelMessages(options);
        // A crashed run owns its original fence; bridge a newer live target in
        // one additional fixed run, never chase the server's moving head.
        if (through && BigInt(cursor) < BigInt(through)) cursor = await recoverChannelMessages(options);
        if (through && BigInt(cursor) < BigInt(through)) throw new Error('Message recovery did not reach the authenticated event.');
        this.recoveryFailures.delete(channelId); this.recoveredChannels.add(channelId);
      } catch (error) {
        lifetime.assertCurrent();
        const channel = getAccountChannelView(this.scope).channelsById[channelId];
        const plain = !!channel && ((channel.channel_type ?? channel.type) !== 1 && (channel.channel_type ?? channel.type) !== 3 || !!channel.guild_id);
        if (error instanceof MessageRecoveryGapError && plain) {
          await recoverChannelMessages({ ...options, through: undefined, plaintextSnapshotAt: error.head });
          this.recoveryFailures.delete(channelId); this.recoveredChannels.add(channelId);
        } else if (error instanceof MessageRecoveryGapError) {
          await local.session.vault.transact(async tx => tx.put('messages.recovery-blocks', channelId, { floor: error.floor, head: error.head, reason: error.reason }));
          this.recoveryFailures.set(channelId, error); this.store.setState({ encryptionError: error.message });
        } else if (axios.isAxiosError(error) && [403, 404].includes(error.response?.status ?? 0)) {
          const unavailable = new Error('This conversation’s history is unavailable to this account. Saved messages remain retained for recovery review.');
          await local.session.vault.transact(async tx => tx.put('messages.recovery-blocks', channelId, { reason: 'unavailable', status: error.response!.status }));
          this.recoveryFailures.set(channelId, unavailable); this.store.setState({ error: unavailable.message });
        } else if (axios.isAxiosError(error) && isRecoveryRefusal(error.response?.status)) {
          // The server refuses this recovery *request*. 403 and 404 were the
          // only refusals this contained; every other 4xx — a 400 above all —
          // was rethrown, which aborts `acceptHandshake`'s channel loop, leaves
          // `synchronization` on 'recovering' and disables sending for the
          // WHOLE ACCOUNT because of one conversation. Desktop 3.0.0 sent every
          // recovery request with no query string (the native adapter dropped
          // `config.params`), so every profile that ran it took exactly this
          // 400, and the channel set is rebuilt from the durable cursor rows on
          // every handshake — so the failure came back after each relaunch.
          const status = error.response!.status;
          if (await this.retryFromDiscardedCursor(channelId, status, local, options)) {
            this.recoveryFailures.delete(channelId); this.recoveredChannels.add(channelId);
          } else {
            const refused = new Error('This conversation’s history could not be recovered from this server. Saved messages remain retained for recovery review.');
            await local.session.vault.transact(async tx => tx.put('messages.recovery-blocks', channelId, { reason: 'refused', status }));
            this.recoveryFailures.set(channelId, refused); this.store.setState({ error: refused.message });
          }
        } else throw error;
      }
      if (this.recoveredChannels.has(channelId)) await local.session.vault.transact(async tx => { lifetime.assertCurrent(); tx.remove('messages.recovery-blocks', channelId); });
      this.updateChannelErrors();
      lifetime.assertCurrent(); await this.publishChannelAuthority(channelId);
    })();
    this.channelRecoveries.set(channelId, run);
    try { await run; } finally { if (this.channelRecoveries.get(channelId) === run) this.channelRecoveries.delete(channelId); }
  }
  async prepareChannelHistory(channelId: string, knownIds: string[] = []) {
    const ownership = this.captureGatewayLease(); await this.startLocal(); ownership.assertCurrent();
    if (!this.handshakeAccepted) throw new Error('Wait for this account’s authenticated message recovery.');
    if (this.store.getState().storage === 'review') return;
    if (!this.recoveredChannels.has(channelId)) await this.recoverChannel(channelId, knownIds);
    const error = this.recoveryFailures.get(channelId); if (error) throw error;
    await this.processEncryptedInbox(); ownership.assertCurrent();
  }
  /** Gate live body projection on exact channel continuity and durable archives. */
  async acceptGatewayMutation(input: { kind: 'create' | 'update' | 'delete'; channelId: string; messageId: string; revision?: string; message?: Message; recoveryRequired?: boolean }): Promise<Message | null> {
    const ownership = this.captureGatewayLease(); await this.startLocal(); ownership.assertCurrent(); const local = this.local;
    if (!local || !this.handshakeAccepted) throw new Error('The message event preceded authenticated recovery.');
    if (this.store.getState().storage === 'review') {
      if (input.kind === 'delete') await this.observeDeleted(input.channelId, input.messageId);
      else if (input.message?.e2ee) await this.ingestEncryptedMessage(input.message);
      return input.message ?? null;
    }
    const lifetime = this.recoveryLifetime(local.session as DeviceSession);
    let accepted: 'accepted' | 'duplicate' | 'gap' = 'gap';
    if (!input.recoveryRequired && input.revision && (input.kind === 'delete' || input.message)) {
      const mutation: LiveRecoveryMutation = input.kind === 'delete' ? { kind: 'delete', channelId: input.channelId, messageId: input.messageId, revision: input.revision }
        : { kind: input.kind, message: { ...input.message!, message_revision: input.revision } };
      accepted = await withMessageRecoveryLock(local.session.vault, lifetime, input.channelId, () => local.session.vault.transact(tx => stageLiveRecoveryMutation(tx, mutation, (tx, page) => this.stageRecoveredDeletions(tx, page))));
    }
    if (accepted === 'gap') await this.recoverChannel(input.channelId, [input.messageId], input.recoveryRequired ? undefined : input.revision);
    else this.recoveredChannels.add(input.channelId);
    lifetime.assertCurrent();
    await this.processEncryptedInbox();
    if (this.identity) await this.synchronizeLocalDeletions(this.identity.session, this.identity.dm, this.identity.mutations);
    await this.publishChannelAuthority(input.channelId);
    const current = await local.session.vault.transact(async tx => {
      const state = await tx.get<StoredRecoveryState>(RECOVERY_STATE_NAMESPACE, JSON.stringify([input.channelId, input.messageId]));
      const cursor = await tx.get<RecoveryCursor>(RECOVERY_CURSOR_NAMESPACE, input.channelId);
      return state?.value.state === 'present' && cursor?.complete
        ? BigInt(state.value.revision) <= BigInt(cursor.cursor) ? state.value.message : pendingMessage(state.value.message) : null;
    });
    lifetime.assertCurrent(); return current;
  }
  subscribeMessages(listener: (event: RuntimeMessageEvent) => void) {
    this.listeners.add(listener); void this.refresh().catch(() => {});
    return () => this.listeners.delete(listener);
  }
  private publish(key: string, event: RuntimeMessageEvent) {
    this.assertCurrent();
    if (!this.listeners.size || this.seenReceipts.has(key)) return;
    this.seenReceipts.add(key);
    for (const listener of this.listeners) listener(event);
  }
  private async markExistingReceipts(session: DeviceSession | IdentitySession, source: 'local' | 'identity') {
    // Historical receipts are delivery evidence, not instructions to insert a
    // message into the current HTTP history window after a reload or unlock.
    const receipts = await session.vault.transact(tx => tx.list<DeliveryReceipt>(DELIVERY_RECEIPTS_NAMESPACE));
    session.assertCurrent();
    for (const { id } of receipts) this.seenReceipts.add(`${source}:create:${id}`);
  }
  private lane(session: DeviceSession | IdentitySession, dm?: ReturnType<typeof createDurableDm>,
    group?: ReturnType<typeof createDurableGroup>): Lane {
    const { vault, context } = session;
    const changed = () => { this.changes?.postMessage('changed'); void this.refresh().catch(error => { if (!session.signal.aborted) this.store.setState({ error: errorText(error) }); }); };
    const plainRequest = (intent: DurableIntent): SendMessageRequest => {
      const request: SendMessageRequest = { nonce: intent.nonce, content: intent.draft.content,
        referenced_message_id: intent.intent.referencedMessageId, attachment_ids: intent.intent.attachmentIds, sticker_ids: intent.intent.stickerIds };
      if (intent.intent.forwardedFrom) request.forwarded_from = intent.intent.forwardedFrom;
      return request;
    };
    const driver = new DurableDelivery({ vault, lifetime: session,
      beforeAttempt: async () => { this.assertDeliveryReady(); if (dm) await this.synchronizeLocalDeletions(session as IdentitySession, dm, mutations); },
      send: async (record, signal) => {
        this.assertDeliveryReady(record.channelId);
        if (dm) { await this.synchronizeLocalDeletions(session as IdentitySession, dm, mutations); await dm.assertPreparedDeliveryAllowed(record.channelId); }
        return createDeliveryTransport(context)(record, signal);
      }, discard: createDeliveryDiscardTransport(context),
      // A prepared record no longer carries its encryption kind, so the lane
      // that sealed it is identified by the binding it wrote. Group first: the
      // 1:1 lane treats a missing binding as an error rather than a miss.
      reconcileRemoved: dm || group
        ? async (tx, removed) => {
          if (group && await group.ownsSend(tx, removed.nonce)) return group.reconcileRemoved(tx, removed);
          return dm?.reconcileRemoved(tx, removed);
        }
        : undefined,
      acknowledgeSend: dm || group
        ? async (tx, record, message) => {
          if (group && await group.ownsSend(tx, record.nonce)) return group.acknowledgeSend(tx, record.nonce, message);
          return dm?.acknowledgeSend(tx, record.nonce, message);
        }
        : undefined,
      beforeIntentPrepare: dm || group
        ? async intent => {
          if (intent.intent.encryption.kind === 'dm') await dm?.uploadStagedAttachments(intent.id);
          if (intent.intent.encryption.kind === 'group' && group) {
            // Distribution is an HTTP round trip, so it happens here rather
            // than inside the transaction that seals the body.
            await group.uploadStagedAttachments(intent.id);
            await this.distributeGroupKey(group, intent.channelId);
          }
        }
        : undefined,
      prepareIntent: async (tx, intent) => {
        this.assertDeliveryReady(intent.channelId);
        if (intent.intent.encryption.kind === 'dm') {
          if (!dm) throw new Error('Unlock this conversation’s encrypted account before delivery.');
          return dm.prepareIntent(tx, intent);
        }
        if (intent.intent.encryption.kind === 'group') {
          if (!group) throw new Error('Unlock this conversation’s encrypted account before delivery.');
          const live = this.conversation(intent.channelId);
          if (live.kind !== 'group') throw new Error('This conversation is no longer a group conversation.');
          return group.prepareIntent(tx, intent, live);
        }
        return plainRequest(intent);
      },
      edit: { resolveSend: createDeliveryResolutionTransport(context), resolveEdit: createEditResolutionTransport(context), send: createDeliveryEditTransport(context),
        prepare: dm || group
          ? (async (tx, original, messageId, editNonce, content) => {
            if (group && await group.ownsSend(tx, original.nonce)) return group.prepareEdit(tx, original, messageId, editNonce, content);
            if (!dm) throw new Error('Unlock this conversation’s encrypted account before editing.');
            return dm.prepareEdit(tx, original, messageId, editNonce, content);
          })
          : (async (_tx, original, messageId, editNonce, content) => ({ channelId: original.channelId, messageId, editNonce, serializedRequest: JSON.stringify({ content, edit_nonce: editNonce }) })),
        restore: dm || group
          ? (async (tx, original, content) => {
            if (group && await group.ownsSend(tx, original.nonce)) return group.restoreIntent(tx, original, content);
            if (!dm) throw new Error('Unlock this conversation’s encrypted account before editing.');
            return dm.restoreIntent(tx, original, content);
          })
          : (async (_tx, original, content) => {
          const { serializedRequest, mutation: _mutation, ...retained } = original;
          const request = JSON.parse(serializedRequest) as SendMessageRequest; const nonce = crypto.randomUUID();
          return { ...retained, id: nonce, nonce, revision: crypto.randomUUID(), draft: { content }, status: 'pending', attempts: 0, error: null,
            intent: { encryption: { kind: 'plain' }, referencedMessageId: request.referenced_message_id, attachmentIds: request.attachment_ids, stickerIds: request.sticker_ids } };
        }),
      }, onChange: changed, onError: error => this.store.setState({ error: errorText(error) }),
    });
    const mutations = dm
      ? createAccountDeliveredMutations(session as IdentitySession, { onChange: changed, onError: error => this.store.setState({ encryptionError: errorText(error) }),
        beforeAttempt: async target => { this.assertDeliveryReady(target.channelId); await this.synchronizeLocalDeletions(session as IdentitySession, dm, mutations); } })
      : new DeliveredMutations({ vault, lifetime: session,
        beforeAttempt: async target => { this.assertDeliveryReady(target.channelId); },
        prepareEdit: async (_tx, target, editNonce, content) => ({ channelId: target.channelId, messageId: target.messageId, editNonce, serializedRequest: JSON.stringify({ content, edit_nonce: editNonce }) }),
        edit: createDeliveryEditTransport(context), resolveEdit: createEditResolutionTransport(context), deletion: createDeliveredDeletionTransport(context),
        onChange: changed, onError: error => this.store.setState({ error: errorText(error) }),
      });
    return { session, driver, mutations };
  }
  async startLocal(retry = true): Promise<void> {
    this.assertCurrent();
    if (this.local && !this.local.session.signal.aborted) return;
    if (this.localOpening) {
      // An open cancelled by this account's own first authenticated history is
      // not a storage failure: the replacement history owns a fresh open.
      // The cancellation usually arrives through `invalidateLocal`, which moves
      // the generation — but that listener is only wired once a session exists,
      // so a history accepted WHILE the vault is still opening (every first
      // login, where READY carries the account's first epoch) cancels the open
      // with the generation untouched.
      //
      // Recognise the cancellation by the authoritative fact — the history the
      // open was started against is no longer the account's — and not only by
      // the error that surfaced. An abort lands wherever the open happens to be
      // and is reported by whatever that step throws: a cancelled IndexedDB key
      // write, a vault closed under a transaction, a rejected request. Judging
      // it by the error class alone left every step but one reporting a storage
      // failure, which rejected READY and reconnected the gateway over a history
      // nothing was holding.
      const pending = this.localOpening; const generation = this.generation;
      const openedAgainst = this.localOpeningEpoch;
      try { await pending; } catch (error) {
        const ownHistory = error instanceof DatabaseHistoryExpiredError
          || (openedAgainst !== NO_OPEN_EPOCH && this.readHistoryEpoch() !== openedAgainst);
        if (!retry || this.disposed || (this.generation === generation && !ownHistory)) throw error;
      }
      if (this.local && !this.local.session.signal.aborted) return;
      if (!retry || this.disposed) return;
      return this.startLocal(false);
    }
    const generation = this.generation;
    this.localOpeningEpoch = this.readHistoryEpoch();
    this.store.setState({ storage: 'opening', error: null });
    const run = (async () => {
      let session: DeviceSession | undefined;
      try {
        session = await openDeviceAccountVault(this.scope); this.assertCurrent();
        if (generation !== this.generation) throw new Error('The messaging history changed while storage was opening.');
        const history = await bindMessagingHistory(session.vault, session.context.historyEpoch, this.initialLease);
        let recoveryError: string | null = null;
        try { await migrateLegacyMessageDrafts(session.vault); } catch (error) { recoveryError = errorText(error); }
        session.assertCurrent();
        await this.markExistingReceipts(session, 'local');
        this.local = this.lane(session);
        this.store.setState({ storage: history.kind, previousEpoch: history.kind === 'review' ? history.previousEpoch : null,
          error: history.kind === 'review' ? 'The server database history changed. Review saved messages before sending into this history.' : recoveryError });
        if (history.kind === 'ready' && this.handshakeAccepted) this.startDrivers();
        session.signal.addEventListener('abort', () => this.invalidateLocal(session!.signal.reason), { once: true });
        await this.refresh();
      } catch (error) {
        session?.dispose();
        if (!this.disposed && generation === this.generation) this.store.setState({ storage: 'error', error: errorText(error) });
        throw error;
      }
    })();
    this.localOpening = run.finally(() => { if (this.localOpening === wrapped) { this.localOpening = null; this.localOpeningEpoch = NO_OPEN_EPOCH; } });
    const wrapped = this.localOpening; return wrapped;
  }
  /** The account's stored history, or a sentinel when it cannot be read. */
  private readHistoryEpoch(): string | null | typeof NO_OPEN_EPOCH {
    try { return getDatabaseHistoryEpoch(this.scope); } catch { return NO_OPEN_EPOCH; }
  }
  private invalidateLocal(reason: unknown) {
    if (reason instanceof DatabaseHistoryExpiredError) {
      this.pendingDeletions.clear();
      if (this.store.getState().storage !== 'awaiting-handshake') for (const controller of this.draftControllers.values()) controller.pauseForHistoryReview();
    } else {
      for (const controller of this.draftControllers.values()) controller.dispose(); this.draftControllers.clear();
    }
    this.generation++;
    this.handshakeAccepted = false; this.handshakeGeneration++; this.recoveredChannels.clear(); this.recoveryFailures.clear(); this.receiveFailures.clear();
    this.local?.driver.stop(); this.local?.mutations.stop(); this.local = null;
    this.clearIdentity(); this.seenReceipts.clear();
    if (!this.disposed) this.store.setState({ storage: 'idle', queue: [], mutations: [], recovery: [], synchronization: 'awaiting-handshake' });
  }
  private clearIdentity() {
    const identity = this.identity; this.identity = null;
    // Peer verification lives in this vault. Releasing it turns every trust
    // question into "unknown until unlocked" instead of a silent "unverified".
    if (identity) releaseIdentityTrustVault(this.scope, identity.session.vault);
    identity?.driver.stop(); identity?.mutations.stop(); identity?.session.dispose();
    const setup = !getServerUser(this.scope.serverId)?.public_key;
    if (identity) for (const listener of this.listeners) listener({ kind: 'encryption-locked' });
    if (!this.disposed) this.store.setState(state => ({ encryption: setup ? 'setup' : 'locked', encryptionRecovery: undefined, queue: state.queue.filter(row => row.source !== 'identity'), mutations: state.mutations.filter(row => row.source !== 'identity') }));
  }
  async enroll({ initializeWithUnownedLegacy = false, replacePublishedBundle = false }: { initializeWithUnownedLegacy?: boolean; replacePublishedBundle?: boolean } = {}): Promise<void> {
    this.assertCurrent(); await this.startLocal();
    if (this.store.getState().storage !== 'ready') return;
    for (const [id, target] of this.pendingDeletions) {
      await this.local!.mutations.observeDeleted(target); this.pendingDeletions.delete(id);
    }
    if (!useAccountStore.getState().isUnlocked || !getServerUser(this.scope.serverId)?.public_key) { this.clearIdentity(); return; }
    if (this.identityOpening) return this.identityOpening;
    if (this.identity && !this.identity.session.signal.aborted) { await this.processEncryptedInbox(); return; }
    const generation = this.generation;
    const run = (async () => {
      let session: IdentitySession | undefined;
      this.store.setState({ encryption: 'enrolling', encryptionError: null, encryptionRecovery: undefined });
      try {
        session = await openAccountVault(this.scope);
        const history: VaultHistoryState = await bindMessagingHistory(session.vault, session.context.historyEpoch, this.initialLease);
        if (history.kind !== 'ready') throw new Error('Saved encryption keys belong to an older or unknown database history. Restore and verify the complete encrypted state before sending.');
        await createAccountPrekeyEnrollment(session).ensure({ initializeWithUnownedLegacy, replacePublishedBundle });
        session.assertCurrent(); this.assertCurrent();
        if (generation !== this.generation) throw new Error('The messaging history changed during enrollment.');
        const identityContext = session.context;
        const uploadCiphertext = (input: { channelId: string; objectName: string; ciphertext: Uint8Array }) =>
          // Encrypted attachment seam: opaque ciphertext uploads are bound to the
          // same verified server account that will carry the message.
          uploadOpaqueCiphertext(identityContext.request, input.channelId, input.objectName, input.ciphertext);
        const dm = createDurableDm(session.vault, session.privateKey, createKeysApi(() => session!.context.api), uploadCiphertext);
        const group = createDurableGroup(session.vault, session.privateKey,
          createChannelApi(() => session!.context.api), uploadCiphertext);
        await this.markExistingReceipts(session, 'identity');
        this.identity = { ...this.lane(session, dm, group), session, dm, group };
        registerIdentityTrustVault(this.scope, session.vault);
        if (this.handshakeAccepted) {
          for (const [channelId, ids] of await this.knownMessages()) if (!this.recoveredChannels.has(channelId)) await this.recoverChannel(channelId, [...ids]);
        }
        await this.synchronizeLocalDeletions(session, dm, this.identity.mutations);
        session.signal.addEventListener('abort', () => { if (this.identity?.session === session) this.clearIdentity(); }, { once: true });
        await this.processEncryptedInbox(); session.assertCurrent();
        this.store.setState({ encryption: 'ready' });
        this.startDrivers();
        for (const listener of this.listeners) listener({ kind: 'encryption-ready' });
        window.dispatchEvent(new CustomEvent('paracord:conversation-capabilities-changed', { detail: this.scope }));
        await this.refresh();
      } catch (error) {
        session?.dispose(); if (!this.disposed && generation === this.generation) this.store.setState({ encryption: 'recovery', encryptionError: errorText(error),
          encryptionRecovery: error instanceof PrekeyEnrollmentError && error.code === 'UNOWNED_LEGACY_KEYS' ? { kind: 'legacy-prekeys' }
            : error instanceof PrekeyEnrollmentError && error.code === 'DEVICE_NOT_ENROLLED' ? { kind: 'device-reenrollment' } : undefined });
        throw error;
      }
    })();
    this.identityOpening = run.finally(() => { if (this.identityOpening === wrapped) this.identityOpening = null; });
    const wrapped = this.identityOpening; return wrapped;
  }
  /** A delete recorded by a locked peer window must fence this identity's sender. */
  private async synchronizeLocalDeletions(session: IdentitySession, dm: ReturnType<typeof createDurableDm>, mutations: DeliveredMutations) {
    const local = this.local;
    if (!local || this.store.getState().storage !== 'ready') throw new Error('Review this account’s local message history before delivery.');
    const deleted = (await local.mutations.snapshot()).deleted;
    const applied = new Set((await session.vault.transact(tx => tx.list('messages.applied-local-deletions'))).map(row => row.id));
    for (const id of deleted) {
      if (applied.has(id)) continue;
      const [channelId, messageId] = JSON.parse(id) as [string, string];
      await dm.markExternalRemoval(channelId);
      await mutations.observeDeleted({ channelId, messageId });
      await session.vault.transact(async tx => tx.put('messages.applied-local-deletions', id, { messageId }));
    }
    local.session.assertCurrent(); session.assertCurrent();
  }
  async reconcile() {
    if (this.disposed) return;
    if (!useAccountStore.getState().isUnlocked) this.clearIdentity();
    await this.startLocal(); await this.enroll();
    this.local?.driver.wake(); this.local?.mutations.wake(); this.identity?.driver.wake(); this.identity?.mutations.wake();
  }
  /**
   * Publish this account's group key for the roster as it stands *now*.
   *
   * The server refuses a publish whose membership version has moved, which is
   * the whole point — it is what stops a key being wrapped to somebody who has
   * already left. A refusal is not terminal here: this account's view is simply
   * behind, so the roster is refetched and the error rethrown, and the delivery
   * driver's next attempt mints against the membership it then sees.
   */
  private async distributeGroupKey(group: ReturnType<typeof createDurableGroup>, channelId: string) {
    const attempt = async () => {
      const live = this.conversation(channelId);
      if (live.kind !== 'group') throw new Error('This conversation is no longer a group conversation.');
      await group.distribute(channelId, live.members, live.membersVersion);
    };
    try {
      await attempt();
    } catch (error) {
      if (!axios.isAxiosError(error) || error.response?.status !== 409) throw error;
      await useChannelStore.getState().fetchDmChannels(this.scope);
      this.assertCurrent();
      window.dispatchEvent(new CustomEvent('paracord:conversation-capabilities-changed', { detail: this.scope }));
      await attempt();
    }
  }
  private async requireLocal(allowBeforeHandshake = false) {
    await this.startLocal(); this.assertCurrent();
    const state = this.store.getState();
    if (!this.local || (state.storage !== 'ready' && !(allowBeforeHandshake && state.storage === 'awaiting-handshake'))) throw new Error(state.error ?? 'Wait for this server’s authenticated connection before sending.');
    this.local.session.assertCurrent(); return this.local;
  }
  private async requireIdentity() {
    await this.enroll();
    if (!this.identity) throw new Error(this.store.getState().encryptionError ?? 'Set up and unlock the identity enrolled for this server account.');
    this.identity.session.assertCurrent(); return this.identity;
  }
  private conversation(channelId: string) {
    const channel = getAccountChannelView(this.scope).channelsById[channelId];
    if (!channel) throw new Error('Load this conversation before sending.');
    const type = channel.channel_type ?? channel.type;
    if (!channel.guild_id && type === 3) {
      // Every member must have published an identity key: a sender key is
      // wrapped to each of them, and one unenrolled member means a message
      // nobody could have written to them. Naming who is missing is the only
      // way the sender can act on it.
      const roster = channel.recipients ?? [];
      if (roster.length === 0) throw new Error('This group’s membership has not loaded yet. Reopen the conversation before sending.');
      const unenrolled = roster.filter(member => !member.public_key);
      if (unenrolled.length > 0) {
        const names = unenrolled.map(member => member.username || member.id).join(', ');
        throw new Error(`Everyone in a group conversation needs encryption set up before it can carry a message. Waiting on: ${names}.`);
      }
      const members: GroupMember[] = roster.map(member => ({ id: member.id, publicKey: member.public_key! }));
      if (!members.some(member => member.id === this.scope.userId)) {
        throw new Error('This account is not a member of the group conversation it is writing to.');
      }
      // The server's name for this exact roster. Publishing a sender key
      // without it is refused, which is what keeps a key from being wrapped to
      // a membership that has already moved.
      const membersVersion = channel.members_version;
      if (!membersVersion) throw new Error('This group’s membership has not loaded yet. Reopen the conversation before sending.');
      return { kind: 'group' as const, members, membersVersion };
    }
    if (!channel.guild_id && type === 1) {
      const peer = channel.recipient;
      if (!peer?.id || !peer.public_key) throw new Error('The recipient needs to finish encryption setup.');
      return { kind: 'dm' as const, peer: { id: peer.id, publicKey: peer.public_key } };
    }
    return { kind: 'plain' as const };
  }
  private async receiveConversation(channelId: string, refreshIdentity = false) {
    const channel = getAccountChannelView(this.scope).channelsById[channelId];
    const type = channel ? channel.channel_type ?? channel.type : null;
    const staleGroup = type === 3 && (refreshIdentity || !channel!.recipients?.length
      || channel!.recipients.some(member => !member.public_key));
    if (!channel || (type === 1 && (refreshIdentity || !channel.recipient?.public_key)) || staleGroup) {
      // An incoming first DM can precede CHANNEL_CREATE or the peer's identity
      // projection. Refresh only this authenticated account's DM metadata.
      await useChannelStore.getState().fetchDmChannels(this.scope);
      this.assertCurrent();
      window.dispatchEvent(new CustomEvent('paracord:conversation-capabilities-changed', { detail: this.scope }));
    }
    return this.conversation(channelId);
  }
  /**
   * Queue a message.
   *
   * `attachments` is the encrypted producer's entry point: the files are
   * encrypted here, each under its own key, and their ciphertext is committed to
   * this account's vault in the same transaction as the queued draft. The server
   * reference, the real name and the key only ever meet inside the encrypted
   * body built at preparation time. A plaintext `attachmentIds` upload is still
   * how guild channels work, and is refused for an encrypted conversation.
   */
  async send(channelId: string, content: string, referencedMessageId?: string, attachmentIds?: string[], stickerIds?: string[], draft?: MessageDraft,
    attachments?: EncryptedAttachmentSubmission, forwardedFrom?: ForwardedFromRequest) {
    await this.prepareChannelHistory(channelId); this.assertDeliveryReady(channelId);
    this.assertCurrent(); const encryption = await this.receiveConversation(channelId, true);
    const lane = encryption.kind === 'plain' ? await this.requireLocal() : await this.requireIdentity();
    if (encryption.kind === 'dm' || encryption.kind === 'group') {
      if (attachmentIds?.length) throw new Error('An encrypted conversation cannot reference a plaintext upload.');
      if (stickerIds?.length) throw new Error('Encrypted stickers require an encrypted sticker producer.');
      if (encryption.kind === 'dm') await this.checkLegacySession(lane.session as IdentitySession, channelId, encryption.peer);
    } else if (attachments?.files.length) {
      throw new Error('This conversation is not encrypted; attach files through the ordinary upload path.');
    }
    lane.session.assertCurrent();
    const prepared = attachments?.files.length
      ? await prepareEncryptedAttachments(attachments.files, { maxCiphertextBytes: attachments.maxCiphertextBytes })
      : [];
    this.assertCurrent(); lane.session.assertCurrent();
    const stage = prepared.length
      ? (tx: VaultTransaction, messageId: string) => { stageAttachments(tx, messageId, channelId, prepared); }
      : undefined;
    const intent = { encryption, referencedMessageId, attachmentIds, stickerIds, forwardedFrom };
    if (draft) {
      if (draft.content.trim() !== content.trim()) throw new Error('The submitted draft no longer matches this message.');
      const local = await this.requireLocal();
      await acceptEncryptedDraft(local.session.vault, lane.session.vault, encryption.kind === 'plain' ? 'local' : 'identity', channelId, draft, intent, stage);
    } else await enqueueMessageIntent(lane.session.vault, channelId, content.trim(), intent, stage);
    await this.refresh(); lane.driver.wake();
  }
  async decrypt(channelId: string, payload: MessageE2eePayload, messageId: string, authorId: string) {
    const ownership = this.captureGatewayLease();
    await this.prepareChannelHistory(channelId, [messageId]);
    const encryption = await this.receiveConversation(channelId);
    if (encryption.kind === 'plain') throw new Error('This conversation has no supported encrypted message reader.');
    const lane = await this.requireIdentity();
    if (encryption.kind === 'group') {
      const keys = new Map(encryption.members.map(member => [member.id, member.publicKey]));
      const content = await lane.group.decrypt(channelId, encryption.members, payload, messageId, authorId,
        userId => keys.get(userId) ?? null);
      ownership.assertCurrent(); return content;
    }
    await this.checkLegacySession(lane.session, channelId, encryption.peer);
    const content = await lane.dm.decrypt(channelId, encryption.peer, payload, messageId);
    ownership.assertCurrent(); return content;
  }
  /** Preserve a generation starter even when a later delete arrives before unlock. */
  async ingestEncryptedMessage(message: Message) {
    if (!message.e2ee) return;
    assertSignalMessageId(message.id);
    await this.startLocal(); const local = this.local;
    if (!local) throw new Error('Encrypted message storage is unavailable.');
    const epoch = local.session.context.historyEpoch;
    if (!epoch) throw new Error('An authenticated server history is required to retain encrypted messages.');
    const namespace = this.store.getState().storage === 'review' ? `messages.held-inbox:${epoch}` : 'messages.encrypted-inbox';
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([message.channel_id, message.id, message.e2ee])));
    const id = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
    await local.session.vault.transact(async tx => tx.put(namespace, id, { ...message, content: '' }));
    local.session.assertCurrent();
    if (this.handshakeAccepted && namespace === 'messages.encrypted-inbox' && !this.recoveredChannels.has(message.channel_id)) await this.recoverChannel(message.channel_id, [message.id]);
    if (this.identity && !this.identity.session.signal.aborted) await this.processEncryptedInbox();
  }
  private async processEncryptedInbox(): Promise<void> {
    const local = this.local; const identity = this.identity;
    if (!local || !identity || !this.handshakeAccepted) return;
    const previous = this.inboxProcessing;
    if (previous) {
      if (previous.identity === identity) { this.inboxRequested = true; return previous.promise; }
      // An aborted history must finish before the replacement drains its inbox.
      await previous.promise.catch(() => {});
      return this.processEncryptedInbox();
    }
    const run = (async () => {
      do {
        this.inboxRequested = false;
        local.session.assertCurrent(); identity.session.assertCurrent();
        const rows = await local.session.vault.transact(async tx => [
          ...(await tx.list<{ revision: string; message: RecoveryArchive }>(RECOVERY_ARCHIVE_NAMESPACE)).map(({ id, value }) => ({ id, value: value.message as Message, revision: value.revision, namespace: RECOVERY_ARCHIVE_NAMESPACE })),
          ...(await tx.list<Message>('messages.encrypted-inbox')).map(row => ({ ...row, revision: null, namespace: 'messages.encrypted-inbox' })),
        ]);
        rows.sort((a, b) => a.value.channel_id.localeCompare(b.value.channel_id)
          || (a.revision && b.revision ? (BigInt(a.revision) < BigInt(b.revision) ? -1 : 1) : a.revision ? -1 : b.revision ? 1 : a.value.id.length - b.value.id.length || a.value.id.localeCompare(b.value.id)));
        const failed = new Set<string>();
        for (const { id, value, namespace } of rows) {
          if (failed.has(value.channel_id) || this.recoveryFailures.has(value.channel_id) || !this.recoveredChannels.has(value.channel_id)) continue;
          try {
            identity.session.assertCurrent();
            const encryption = await this.receiveConversation(value.channel_id);
            if (encryption.kind === 'plain' || !value.e2ee) continue;
            if (encryption.kind === 'group') {
              if (!encryption.members.some(member => member.id === value.author.id)) throw new Error('The archived sender is not a member of this group conversation.');
              const keys = new Map(encryption.members.map(member => [member.id, member.publicKey]));
              await identity.group.decrypt(value.channel_id, encryption.members, value.e2ee, value.id, value.author.id,
                userId => keys.get(userId) ?? null);
              if (value.author.id === this.scope.userId && value.nonce) await identity.session.vault.transact(tx => identity.group.acknowledgeSend(tx, value.nonce!, value));
              identity.session.assertCurrent();
              await local.session.vault.transact(async tx => tx.remove(namespace, id));
              this.receiveFailures.delete(value.channel_id);
              continue;
            }
            if (value.author.id !== this.scope.userId && value.author.id !== encryption.peer.id) throw new Error('The archived sender does not match this verified encrypted conversation.');
            await this.checkLegacySession(identity.session, value.channel_id, encryption.peer);
            await identity.dm.decrypt(value.channel_id, encryption.peer, value.e2ee, value.id);
            if (value.author.id === this.scope.userId && value.nonce) await identity.session.vault.transact(tx => identity.dm.acknowledgeSend(tx, value.nonce!, value));
            identity.session.assertCurrent();
            await local.session.vault.transact(async tx => tx.remove(namespace, id));
            this.receiveFailures.delete(value.channel_id);
          } catch (error) {
            identity.session.assertCurrent(); local.session.assertCurrent();
            // A message sealed to a key this device never held reads
            // "[Encrypted message]" and nothing more. It is the documented cost
            // of setting up new keys after a recovery-phrase restore, not
            // evidence that anything is wrong, so it must not fence the
            // conversation the way a failed authentication does — otherwise a
            // restored device could never send again, and anyone able to post
            // ciphertext could silence a conversation by naming a prekey id
            // nobody has. The envelope stays durable in case a backup is
            // imported later.
            if (error instanceof MissingPrivatePrekeyError) continue;
            // The account's OWN outbound copy, on a device that has no plaintext
            // for it. Ordinarily `durableDm.decrypt` answers one of these from
            // the plaintext it cached when it sent it, and the inbound path is
            // never reached; a device restored from the recovery phrase has no
            // such cache, so the copy goes through the peer reader — whose first
            // act is to refuse a header identity key that is not the peer's.
            // That header carries THIS account's identity key, by construction,
            // so the refusal is right and means only "not readable here". It is
            // the same fact as MissingPrivatePrekeyError above and must not fence
            // the conversation: before this, anyone who had ever sent a message
            // could restore their identity and then never send again.
            if (value.author.id === this.scope.userId
              && error instanceof DmE2eeError && error.code === 'PEER_IDENTITY_MISMATCH') continue;
            // The encrypted envelope remains durable for a later recovery attempt.
            this.store.setState({ encryptionError: errorText(error) });
            this.receiveFailures.set(value.channel_id, error instanceof Error ? error : new Error(errorText(error)));
            failed.add(value.channel_id);
          }
        }
      } while (this.inboxRequested);
      identity.session.assertCurrent(); local.session.assertCurrent();
      this.updateChannelErrors();
      if (!(await local.session.vault.transact(async tx => [...await tx.list('messages.encrypted-inbox'), ...await tx.list(RECOVERY_ARCHIVE_NAMESPACE)])).length
        && !this.store.getState().encryptionRecovery && !this.recoveryFailures.size) this.store.setState({ encryptionError: null });
    })();
    const current = { identity, promise: run.finally(() => { if (this.inboxProcessing === current) this.inboxProcessing = null; }) };
    this.inboxProcessing = current; return current.promise;
  }
  private async checkLegacySession(session: IdentitySession, channelId: string, peer: { id: string; publicKey: string }) {
    try { await assertLegacySignalReviewed(session.vault, session.privateKey, channelId, peer); }
    catch (error) {
      session.assertCurrent();
      if (error instanceof LegacySignalRecoveryError) this.store.setState({ encryptionError: error.message, encryptionRecovery: { kind: 'legacy-session', channelId } });
      throw error;
    }
  }
  async acknowledgeOwnMessage(message: Message) {
    if (message.author.id !== this.scope.userId || !message.nonce || !message.e2ee) return;
    const lane = await this.requireIdentity();
    await lane.session.vault.transact(tx => lane.dm.acknowledgeSend(tx, message.nonce!, message));
  }
  async filterDeletedMessages(messages: Message[]) {
    const ownership = this.captureGatewayLease(); await this.startLocal(); ownership.assertCurrent(); const lane = this.local;
    if (!lane) throw new Error('Encrypted message storage is unavailable.');
    const review = this.store.getState().storage === 'review';
    // Old-history tombstones must not hide a reused ID in restored server data.
    const deleted = new Set(review
      ? (await lane.session.vault.transact(tx => tx.list(`messages.held-deletions:${lane.session.context.historyEpoch}`))).map(row => row.id)
      : (await lane.mutations.snapshot()).deleted);
    if (!review && this.identity) for (const id of (await this.identity.mutations.snapshot()).deleted) deleted.add(id);
    for (const id of this.pendingDeletions.keys()) deleted.add(id);
    lane.session.assertCurrent();
    if (!review) {
      if (!this.handshakeAccepted) throw new Error('Wait for this account’s authenticated message recovery.');
      const known = new Set((await lane.session.vault.transact(tx => tx.list(RECOVERY_STATE_NAMESPACE))).map(row => row.id));
      const unknown = new Map<string, string[]>();
      for (const message of messages) if (!known.has(JSON.stringify([message.channel_id, message.id]))) {
        const ids = unknown.get(message.channel_id) ?? []; ids.push(message.id); unknown.set(message.channel_id, ids);
      }
      for (const [channelId, ids] of unknown) {
        const cursor = await lane.session.vault.transact(tx => tx.get<RecoveryCursor>(RECOVERY_CURSOR_NAMESPACE, channelId));
        await this.recoverChannel(channelId, ids, cursor?.complete ? cursor.cursor : undefined);
      }
      const heads = new Map<string, string>();
      for (const message of messages) if (message.message_revision && (!heads.has(message.channel_id) || BigInt(message.message_revision) > BigInt(heads.get(message.channel_id)!))) heads.set(message.channel_id, message.message_revision);
      for (const [channelId, head] of heads) {
        const cursor = await lane.session.vault.transact(tx => tx.get<RecoveryCursor>(RECOVERY_CURSOR_NAMESPACE, channelId));
        if (!cursor?.complete || BigInt(cursor.cursor) < BigInt(head)) await this.recoverChannel(channelId, messages.filter(message => message.channel_id === channelId).map(message => message.id), head);
      }
    }
    const authority = review ? new Map<string, StoredRecoveryState>() : new Map((await lane.session.vault.transact(tx => tx.list<StoredRecoveryState>(RECOVERY_STATE_NAMESPACE))).map(row => [row.id, row.value]));
    const cursors = review ? new Map<string, RecoveryCursor>() : new Map((await lane.session.vault.transact(tx => tx.list<RecoveryCursor>(RECOVERY_CURSOR_NAMESPACE))).map(row => [row.id, row.value]));
    ownership.assertCurrent(); lane.session.assertCurrent();
    return messages.flatMap(message => {
      const id = JSON.stringify([message.channel_id, message.id]); const canonical = authority.get(id)?.value;
      if (deleted.has(id) || canonical?.state === 'deleted' || this.recoveryFailures.has(message.channel_id)) return [];
      if (canonical?.state === 'present') {
        const cursor = cursors.get(message.channel_id);
        if (!cursor?.complete) return [];
        if (BigInt(canonical.revision) > BigInt(cursor.cursor)) return [pendingMessage(canonical.message)];
        if (!message.message_revision || BigInt(canonical.revision) > BigInt(message.message_revision)) return [canonical.message];
      }
      return [message];
    });
  }
  /** Authenticated, account-owned gateway deletion; persist before projecting it. */
  async observeDeleted(channelId: string, messageId: string) {
    const deletionId = JSON.stringify([channelId, messageId]);
    this.pendingDeletions.set(deletionId, { channelId, messageId });
    const identity = this.identity;
    identity?.driver.stop();
    let local: Lane;
    try {
      await this.startLocal();
      if (!this.local) throw new Error('Encrypted deletion storage is unavailable.');
      local = this.local;
    }
    catch (error) { this.clearIdentity(); throw error; }
    if (this.store.getState().storage === 'review') {
      const epoch = local.session.context.historyEpoch;
      if (!epoch) throw new Error('An authenticated server history is required to retain deletions.');
      await local.session.vault.transact(async tx => tx.put(`messages.held-deletions:${epoch}`, deletionId, { observedAt: Date.now() }));
      this.pendingDeletions.delete(deletionId); return;
    }
    let identityGuardCommitted = false;
    try {
      await local.mutations.observeDeleted({ channelId, messageId });
      this.pendingDeletions.delete(deletionId);
      if (identity) {
        await identity.dm.markExternalRemoval(channelId);
        identityGuardCommitted = true;
        await identity.mutations.observeDeleted({ channelId, messageId });
        const id = JSON.stringify([channelId, messageId]);
        await identity.session.vault.transact(async tx => tx.put('messages.applied-local-deletions', id, { messageId }));
        try {
          const encryption = this.conversation(channelId);
          if (encryption.kind === 'dm') await identity.dm.reconcileExternalRemoval(channelId, encryption.peer);
        } catch (error) { this.store.setState({ encryptionError: errorText(error) }); }
      }
    } finally {
      if (identity && this.identity === identity && !identity.session.signal.aborted) {
        if (identityGuardCommitted) {
          identity.mutations.stop();
          this.identity = { ...this.lane(identity.session, identity.dm, identity.group), session: identity.session, dm: identity.dm, group: identity.group };
          this.startDrivers();
        } else {
          this.clearIdentity(); this.store.setState({ encryption: 'recovery', encryptionError: 'The deleted message could not be recorded safely. Recover encrypted storage before continuing.' });
        }
      }
    }
    local.session.assertCurrent(); this.publish(`external-delete:${channelId}:${messageId}`, { kind: 'delete', channelId, messageId });
    await this.refresh();
  }
  async editMessage(message: Message, content: string) {
    await this.prepareChannelHistory(message.channel_id, [message.id]); this.assertDeliveryReady(message.channel_id);
    const encryption = await this.receiveConversation(message.channel_id, true);
    const lane = encryption.kind === 'dm' ? await this.requireIdentity() : await this.requireLocal();
    if (encryption.kind === 'dm') await this.checkLegacySession(lane.session as IdentitySession, message.channel_id, encryption.peer);
    const queued = (await listQueuedSends(lane.session.vault)).find(row => row.nonce === message.nonce);
    if (queued) {
      if (isPreparedSend(queued)) await lane.driver.editPrepared(queued.id, queued.mutation?.kind === 'edit' ? queued.mutation.next?.editNonce ?? queued.mutation.editNonce : queued.nonce, content);
      else await lane.driver.editDraft(queued.id, queued.revision, content);
      return;
    }
    const target: DeliveredMessageTarget = { channelId: message.channel_id, messageId: message.id, authorId: message.author.id, encryption };
    const existing = (await lane.mutations.snapshot()).mutations.find(row => row.target.messageId === message.id && row.target.channelId === message.channel_id);
    await lane.mutations.edit(target, content, existing?.revision ?? null);
  }
  async deleteMessage(message: Message) {
    await this.prepareChannelHistory(message.channel_id, [message.id]); this.assertDeliveryReady(message.channel_id);
    const encryption = this.conversation(message.channel_id);
    const lane = encryption.kind === 'plain' ? await this.requireLocal() : await this.requireIdentity();
    const queued = (await listQueuedSends(lane.session.vault)).find(row => row.nonce === message.nonce);
    if (queued) { if (isPreparedSend(queued)) await lane.driver.discardPrepared(queued.id); else await lane.driver.discardDraft(queued.id, queued.revision); return; }
    const target: DeliveredMessageTarget = { channelId: message.channel_id, messageId: message.id, authorId: message.author.id, encryption };
    const existing = (await lane.mutations.snapshot()).mutations.find(row => row.target.messageId === message.id && row.target.channelId === message.channel_id);
    await lane.mutations.delete(target, existing?.revision ?? null);
  }
  async readDraft(channelId: string): Promise<MessageDraft | null> {
    const lane = await this.requireLocal(true);
    try { await migrateLegacyMessageDrafts(lane.session.vault, channelId); } catch (error) { this.store.setState({ error: errorText(error) }); }
    await this.refresh();
    return lane.session.vault.transact(tx => tx.get<MessageDraft>(draftsNamespace, channelId));
  }
  async writeDraft(channelId: string, draft: MessageDraft) {
    const lane = await this.requireLocal(true); await lane.session.vault.transact(async tx => tx.put(draftsNamespace, channelId, draft));
  }
  draftController(channelId: string) {
    let controller = this.draftControllers.get(channelId);
    if (!controller) {
      controller = new EncryptedDraftController({ read: () => this.readDraft(channelId),
        write: async (draft, expectedRevision) => {
          const lane = await this.requireLocal(true);
          await lane.session.vault.transact(async tx => {
            const current = await tx.get<MessageDraft>(draftsNamespace, channelId);
            if (current?.revision === draft.revision && current.content === draft.content) return;
            const accepted = !current && expectedRevision ? await tx.get<{ accepted: boolean }>('messages.submissions', JSON.stringify([channelId, expectedRevision])) : null;
            if ((current?.revision ?? null) !== expectedRevision && !accepted?.accepted) throw new Error('This conversation’s saved draft changed in another window. Review it before replacing it.');
            tx.put(draftsNamespace, channelId, draft);
          });
        }, clear: revision => this.clearDraft(channelId, revision) });
      this.draftControllers.set(channelId, controller);
    }
    return controller;
  }
  async clearDraft(channelId: string, revision: string) {
    const lane = await this.requireLocal(true); await lane.session.vault.transact(async tx => { if ((await tx.get<MessageDraft>(draftsNamespace, channelId))?.revision === revision) tx.remove(draftsNamespace, channelId); });
  }
  async preservePreviousHistoryForReview() {
    await this.startLocal(); const lane = this.local;
    if (!lane || this.store.getState().storage !== 'review') throw new Error('There is no previous local history awaiting review.');
    lane.session.assertCurrent();
    const epoch = lane.session.context.historyEpoch;
    if (!epoch) throw new Error('Wait for this server’s authenticated connection before reviewing saved history.');
    await lane.session.vault.transact(async tx => {
      for (const [channelId, controller] of this.draftControllers) {
        const draft = controller.store.getState().draft;
        if (!draft.content) continue;
        const id = JSON.stringify(['open-composer', channelId, draft.revision]);
        tx.put(RECOVERY_NAMESPACE, id, { id, channelId, content: draft.content, createdAt: new Date().toISOString(), source: 'open-composer',
          reason: 'Retained from an open composer when the server history changed. Review before copying into a fresh draft.' } satisfies RecoveryDraft);
      }
    });
    await archiveLocalMessagingHistory(lane.session.vault, epoch, this.store.getState().previousEpoch);
    lane.session.assertCurrent(); this.seenReceipts.clear();
    for (const controller of this.draftControllers.values()) controller.dispose(); this.draftControllers.clear();
    this.store.setState(state => ({ storage: 'ready', previousEpoch: null, error: null, draftGeneration: state.draftGeneration + 1 }));
    this.recoveredChannels.clear(); await this.acceptHandshake(); await this.refresh();
    void this.enroll().catch(() => {});
  }
  async copyRecoveryDraft(id: string, channelId: string, expectedDraftRevision: string | null) {
    const lane = await this.requireLocal();
    const draft = await lane.session.vault.transact(async tx => {
      const recovery = await tx.get<RecoveryDraft>(RECOVERY_NAMESPACE, id);
      if (!recovery || (recovery.channelId && recovery.channelId !== channelId)) throw new Error('This recovery draft belongs to another conversation.');
      const current = await tx.get<MessageDraft>(draftsNamespace, channelId);
      if ((current?.revision ?? null) !== expectedDraftRevision) throw new Error('Your draft changed. Review it before copying recovered text.');
      const next = { revision: crypto.randomUUID(), content: recovery.content };
      tx.put(draftsNamespace, channelId, next); return next;
    });
    return draft;
  }
  async reviewLegacySession(channelId: string) {
    const conversation = this.conversation(channelId); if (conversation.kind !== 'dm') return;
    const lane = await this.requireIdentity(); await approveNewSignalSession(lane.session.vault, channelId, conversation.peer);
    this.store.setState({ encryptionError: null, encryptionRecovery: undefined });
    await this.processEncryptedInbox();
    for (const listener of this.listeners) listener({ kind: 'encryption-ready' });
  }
  async queueAction(row: RuntimeQueueRow, action: 'retry' | 'discard' | 'edit', content?: string) {
    const lane = row.source === 'identity' ? await this.requireIdentity() : await this.requireLocal();
    const { record } = row;
    if (action === 'retry') await lane.driver.retry(record.id);
    else if (isPreparedSend(record)) {
      if (action === 'discard') await lane.driver.discardPrepared(record.id);
      else await lane.driver.editPrepared(record.id, record.mutation?.kind === 'edit' ? record.mutation.next?.editNonce ?? record.mutation.editNonce : record.nonce, content ?? '');
    } else if (action === 'discard') await lane.driver.discardDraft(record.id, record.revision);
    else await lane.driver.editDraft(record.id, record.revision, content ?? '');
    await this.refresh();
  }
  async retryMutation(row: RuntimeMutationRow) {
    const lane = row.source === 'identity' ? await this.requireIdentity() : await this.requireLocal();
    await lane.mutations.retry(row.record.id, row.record.revision); await this.refresh();
  }
  async refresh() {
    const ownership = this.captureGatewayLease();
    const generation = this.generation; const queue: RuntimeQueueRow[] = []; const mutations: RuntimeMutationRow[] = []; const recovery: RecoveryDraft[] = [];
    const deleted = new Set(this.local ? (await this.local.mutations.snapshot()).deleted : []);
    for (const source of ['local', 'identity'] as const) {
      const lane = this[source]; if (!lane || lane.session.signal.aborted) continue;
      for (const record of await listQueuedSends(lane.session.vault)) queue.push({ source, record });
      const mutationState = await lane.mutations.snapshot();
      if (source === 'identity' && this.local) {
        const missing = mutationState.deleted.filter(id => !deleted.has(id));
        if (missing.length) await this.local.session.vault.transact(async tx => {
          for (const id of missing) if (!await tx.get(DELETED_MESSAGES_NAMESPACE, id)) tx.put(DELETED_MESSAGES_NAMESPACE, id, { observedAt: Date.now() });
        });
        for (const id of missing) deleted.add(id);
      }
      for (const record of mutationState.mutations) mutations.push({ source, record });
      for (const { value } of await lane.session.vault.transact(tx => tx.list<RecoveryDraft>(RECOVERY_NAMESPACE))) recovery.push(value);
      if (this.store.getState().storage === 'ready' && this.handshakeAccepted && this.store.getState().synchronization === 'ready') {
        ownership.assertCurrent();
        for (const { id, value } of await lane.session.vault.transact(tx => tx.list<DeliveryReceipt>(DELIVERY_RECEIPTS_NAMESPACE))) {
          lane.session.assertCurrent();
          if (value.result.kind === 'message' && !deleted.has(JSON.stringify([value.channelId, value.result.message.id]))
            && !mutationState.deleted.includes(JSON.stringify([value.channelId, value.result.message.id])) && !this.seenReceipts.has(`${source}:create:${id}`)) {
            const [message] = await this.filterDeletedMessages([value.result.message]);
            ownership.assertCurrent(); if (message) this.publish(`${source}:create:${id}`, { kind: 'create', message });
          }
        }
        for (const receipt of mutationState.receipts) {
          lane.session.assertCurrent();
          if (this.seenReceipts.has(`${source}:mutation:${receipt.revision}`)) continue;
          if (receipt.result.kind === 'message') {
            const [message] = await this.filterDeletedMessages([receipt.result.message]);
            ownership.assertCurrent(); if (message) this.publish(`${source}:mutation:${receipt.revision}`, { kind: 'edit', message });
          } else { ownership.assertCurrent(); this.publish(`${source}:mutation:${receipt.revision}`, { kind: 'delete', channelId: receipt.target.channelId, messageId: receipt.target.messageId }); }
        }
      }
    }
    if (!this.disposed && generation === this.generation) this.store.setState({ queue, mutations, recovery });
  }
  dispose() {
    if (this.disposed) return; this.disposed = true;
    this.local?.driver.stop(); this.local?.mutations.stop(); this.local?.session.dispose(); this.local = null;
    this.clearIdentity(); this.listeners.clear(); this.seenReceipts.clear();
    for (const controller of this.draftControllers.values()) controller.dispose(); this.draftControllers.clear();
    this.pendingDeletions.clear(); this.changes?.close();
    this.recoveryAbort.abort(); this.knownMessageReaders.clear();
    this.store.setState({ storage: 'idle', encryption: 'locked', queue: [], mutations: [], recovery: [], error: null, encryptionError: null, previousEpoch: null });
  }
}

const runtimes = new Map<string, AccountMessagingRuntime>();
export function getAccountMessagingRuntime(scope: AccountScope) {
  const key = accountScopeKey(scope); let runtime = runtimes.get(key);
  if (!runtime) { runtime = new AccountMessagingRuntime(Object.freeze({ ...scope })); runtimes.set(key, runtime); }
  return runtime;
}
/** A newly created runtime is paused too, including token-only hydration. */
export function pauseAccountMessagingForRecovery(scope: AccountScope) { getAccountMessagingRuntime(scope).pauseForRecovery(); }
export function resetAccountMessagingRuntimes() { for (const runtime of runtimes.values()) runtime.dispose(); runtimes.clear(); }
/**
 * Keep one runtime per signed-in account, and throw away only the ones whose
 * account really is gone.
 *
 * This runs on every change to the auth store, the server list and the account
 * store, and it used to dispose a runtime whenever `getServerAccountScope`
 * could not answer. That question is not only asked about accounts that ended:
 * a server entry reads as "no account" for as long as its token is momentarily
 * absent — through `hydrateTokens`, through a credential being re-verified,
 * through a refresh that clears before it sets — while the entry, the session
 * and the open realtime stream all still stand.
 *
 * Disposing there did real damage. The next `getAccountMessagingRuntime` built
 * a *replacement* runtime, and a replacement has never accepted a handshake —
 * only READY does that, and READY had already been and gone. So the first
 * ordinary message to arrive afterwards threw "The message event preceded
 * authenticated recovery", the gateway read that as a durable storage failure
 * and destroyed a perfectly healthy transport. Then the replacement session's
 * READY re-handshook, the same transient disposed it again, and the next
 * message reconnected again: one reconnect per message, for as long as people
 * were talking, which is the user's "constant reconnecting to server".
 *
 * An account is gone when its server entry is gone from the list, when the
 * entry now names a *different* account, or when the home session has signed
 * out. A scope that cannot be read this instant is none of those.
 */
export function reconcileAccountMessaging() {
  const listed = new Set(accountScopeServerIds(useServerListStore.getState().servers.map(server => server.id)));
  for (const [key, runtime] of runtimes) {
    const current = getServerAccountScope(runtime.scope.serverId);
    const signedOut = runtime.scope.serverId === LOCAL_SERVER_ID && !useAuthStore.getState().token;
    if (!listed.has(runtime.scope.serverId) || (current && accountScopeKey(current) !== key) || signedOut) { runtime.dispose(); runtimes.delete(key); }
    else if (current) void runtime.reconcile().catch(() => {});
  }
}
let stopLifecycle: (() => void) | null = null;
export function startAccountMessagingLifecycle() {
  if (stopLifecycle) return stopLifecycle;
  const start = () => {
    for (const id of accountScopeServerIds(useServerListStore.getState().servers.map(server => server.id))) {
      const scope = getServerAccountScope(id); if (scope) getAccountMessagingRuntime(scope);
    }
    reconcileAccountMessaging();
  };
  const historyChanged = () => {
    // Finish old-history opens before starting a replacement. Otherwise the
    // handshake can coalesce onto a doomed opening promise and strand drafts.
    void Promise.allSettled([...runtimes.values()].map(runtime => runtime.startLocal())).then(start);
  };
  const unsubscribers = [useAuthStore.subscribe(start), useServerListStore.subscribe(start), useAccountStore.subscribe(start), subscribeDatabaseHistory(historyChanged)];
  window.addEventListener('online', start); start();
  stopLifecycle = () => { unsubscribers.forEach(unsubscribe => unsubscribe()); window.removeEventListener('online', start); stopLifecycle = null; resetAccountMessagingRuntimes(); };
  return stopLifecycle;
}
registerSessionReset('account-messaging-runtime', resetAccountMessagingRuntimes);
