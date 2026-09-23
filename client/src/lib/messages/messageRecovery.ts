import type { Message } from '../../types';
import type { AccountVault, VaultTransaction } from '../crypto/accountVault';
import type { OperationContext } from '../operationContext';
import { accountScopeKey } from '../serverScope';

export const RECOVERY_CURSOR_NAMESPACE = 'messages.recovery-cursors';
export const RECOVERY_ARCHIVE_NAMESPACE = 'messages.recovery-envelopes';
export const RECOVERY_STATE_NAMESPACE = 'messages.authoritative-state';
export interface RecoveryArchive {
  id: string; channel_id: string; author: { id: string }; content: '';
  e2ee: Omit<NonNullable<Message['e2ee']>, 'header'> & { header?: string | null }; nonce?: string | null;
  timestamp?: string; edited_timestamp?: string | null; flags?: number | null;
}
export type RecoveryState = { message_id: string; state: 'deleted'; revision: string }
  | { message_id: string; state: 'present'; revision: string; message: Message };
export interface RecoveryPage {
  database_history_epoch: string; channel_id: string; after: string; through: string; floor: string;
  next: string; complete: boolean; projection_head: string;
  changes: Array<{ revision: string; kind: 'create' | 'update' | 'delete'; message_id: string; archived_message: RecoveryArchive | null }>;
  states: RecoveryState[];
}
export interface RecoveryCursor { cursor: string; through: string | null; complete: boolean }
export interface StoredRecoveryState { observedAt: string; value: RecoveryState }
export interface RecoveryRequest { channelId: string; after: string; through?: string; knownIds: string[] }
export class MessageRecoveryGapError extends Error {
  constructor(readonly floor: string, readonly head: string, readonly reason: 'before_migration' | 'retention') {
    super('This server no longer retains a complete message history for these encryption sessions. Review recovery before sending.');
  }
}
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid message recovery response.');
  return value as Record<string, unknown>;
};
const revision = (value: unknown): string => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > 9223372036854775807n) throw new Error('Invalid message recovery revision.');
  return value;
};
const SYSTEM_ACCOUNT_ID = /^-[1-9][0-9]*$/;
const id = (value: unknown): string => {
  const result = revision(value); if (result === '0') throw new Error('Invalid message recovery ID.'); return result;
};
function validateMessage(value: unknown, channelId: string, messageId: string, archived: boolean) {
  const message = record(value);
  if (message.id !== messageId || message.channel_id !== channelId) throw new Error('Message recovery returned a foreign message.');
  const authorId = record(message.author).id;
  // Deleted accounts and the instance's own system accounts (Auto-Moderator,
  // Sports) carry negative ids: a current public projection, never a ratchet
  // sender, so nothing about them is bound to an encryption session.
  const systemAuthor = !archived && typeof authorId === 'string' && SYSTEM_ACCOUNT_ID.test(authorId);
  if (!systemAuthor) {
    if (archived || message.e2ee != null || typeof authorId !== 'string' || !authorId.startsWith('anon:')) {
      id(authorId);
    } else {
      const anonymous = record(message.anonymous);
      if (anonymous.is_anonymous !== true || anonymous.can_deanonymize !== false || typeof anonymous.alias !== 'string' || !anonymous.alias
        || authorId !== `anon:${channelId}:${anonymous.alias}`) throw new Error('Invalid anonymous message recovery author.');
    }
  }
  if (message.content !== null && typeof message.content !== 'string') throw new Error('Invalid message recovery body.');
  if (archived && message.content !== '') throw new Error('Archived recovery envelopes must not carry plaintext.');
  if (archived || message.e2ee != null) {
    const e2ee = record(message.e2ee);
    if (!Number.isSafeInteger(e2ee.version) || Number(e2ee.version) < 1 || typeof e2ee.nonce !== 'string' || !e2ee.nonce
      || typeof e2ee.ciphertext !== 'string' || !e2ee.ciphertext || (e2ee.header != null && typeof e2ee.header !== 'string')) throw new Error('Invalid message recovery envelope.');
  }
}
/** Bind every page, revision and per-ID state before allowing it into encrypted storage. */
export function readRecoveryPage(value: unknown, request: RecoveryRequest, epoch: string): RecoveryPage {
  const page = record(value);
  if (page.database_history_epoch !== epoch || page.channel_id !== request.channelId || page.after !== request.after
    || (request.through !== undefined && page.through !== request.through)) throw new Error('Message recovery belongs to a different account history or cursor.');
  const after = BigInt(revision(page.after)); const through = BigInt(revision(page.through));
  const floor = BigInt(revision(page.floor)); const next = BigInt(revision(page.next)); const head = BigInt(revision(page.projection_head));
  if (after < floor || after > next || next > through || through > head || typeof page.complete !== 'boolean'
    || page.complete !== (next === through) || (!page.complete && next === after)
    || !Array.isArray(page.changes) || page.changes.length > 100 || !Array.isArray(page.states) || page.states.length > 200) throw new Error('Invalid message recovery page bounds.');
  const required = new Set(request.knownIds); let previous = after;
  for (const value of page.changes) {
    const change = record(value); const order = BigInt(revision(change.revision)); const messageId = id(change.message_id);
    if (order !== previous + 1n || order > next || !['create', 'update', 'delete'].includes(String(change.kind))) throw new Error('Invalid message recovery change order.');
    if (change.kind === 'delete' && change.archived_message !== null) throw new Error('A deletion must not contain an archived body.');
    if (change.archived_message !== null) validateMessage(change.archived_message, request.channelId, messageId, true);
    required.add(messageId); previous = order;
  }
  if (previous !== next) throw new Error('Message recovery omitted committed mutations.');
  const seen = new Set<string>();
  for (const value of page.states) {
    const state = record(value); const messageId = id(state.message_id); const order = BigInt(revision(state.revision));
    if (seen.has(messageId) || !required.has(messageId) || order > head) throw new Error('Invalid message recovery state identity.');
    if (state.state === 'present') {
      validateMessage(state.message, request.channelId, messageId, false);
      if (record(state.message).message_revision !== state.revision) throw new Error('Message recovery body revision mismatch.');
    } else if (state.state !== 'deleted' || order !== head || state.message !== undefined) throw new Error('Invalid message recovery deletion state.');
    seen.add(messageId);
  }
  if (seen.size !== required.size) throw new Error('Message recovery omitted authoritative target states.');
  return page as unknown as RecoveryPage;
}
export function createMessageRecoveryTransport(context: OperationContext, signal?: AbortSignal) {
  return async (request: RecoveryRequest): Promise<RecoveryPage> => {
    context.assertCurrent(); const epoch = context.historyEpoch;
    if (!epoch) throw new Error('Message recovery requires an authenticated database history.');
    const response = await context.request({ method: 'GET', signal, url: `/channels/${encodeURIComponent(request.channelId)}/messages/recovery`,
      params: { after: request.after, through: request.through, limit: 100, known_ids: request.knownIds.join(',') },
      timeout: 30_000, validateStatus: status => status === 200 || status === 409 });
    context.assertCurrent();
    if (response.status === 409) {
      const gap = record(response.data);
      if (gap.code !== 'MESSAGE_RECOVERY_GAP' || gap.database_history_epoch !== epoch || gap.channel_id !== request.channelId || gap.after !== request.after
        || !['before_migration', 'retention'].includes(String(gap.reason)) || BigInt(revision(gap.floor)) <= BigInt(request.after)
        || BigInt(revision(gap.head)) < BigInt(gap.floor as string)) throw new Error('Invalid message recovery gap response.');
      throw new MessageRecoveryGapError(gap.floor as string, gap.head as string, gap.reason as 'before_migration' | 'retention');
    }
    if (response.status !== 200) throw new Error('The server did not confirm message recovery.');
    return readRecoveryPage(response.data, request, epoch);
  };
}
function envelopeIdentity(payload: RecoveryArchive['e2ee'] | Message['e2ee']) {
  return payload ? [payload.version, payload.nonce, payload.ciphertext, payload.header ?? null] : null;
}
function archiveIdentity(value: { revision: string; message: RecoveryArchive }) {
  const message = value.message;
  return [value.revision, message.id, message.channel_id, message.author.id, message.nonce ?? null, envelopeIdentity(message.e2ee)];
}
function bodyIdentity(state: RecoveryState) {
  if (state.state === 'deleted') return ['deleted', state.message_id, state.revision];
  const message = state.message;
  // Profile, reaction and pin metadata can change without a body revision.
  return ['present', state.message_id, state.revision, message.e2ee ? '' : message.content, envelopeIdentity(message.e2ee), message.nonce ?? null];
}
/** Archive and authoritative state commit with the cursor; interrupted pages never advance it. */
export async function stageRecoveryPage(tx: VaultTransaction, page: RecoveryPage) {
  for (const change of page.changes) {
    if (!change.archived_message) continue;
    const key = JSON.stringify([page.channel_id, change.revision]);
    const previous = await tx.get<{ revision: string; message: RecoveryArchive }>(RECOVERY_ARCHIVE_NAMESPACE, key);
    const value = { revision: change.revision, message: change.archived_message };
    if (previous && JSON.stringify(archiveIdentity(previous)) !== JSON.stringify(archiveIdentity(value))) throw new Error('An immutable archived envelope changed.');
    if (!previous) tx.put(RECOVERY_ARCHIVE_NAMESPACE, key, value);
  }
  for (const value of page.states) {
    const key = JSON.stringify([page.channel_id, value.message_id]);
    const previous = await tx.get<StoredRecoveryState>(RECOVERY_STATE_NAMESPACE, key);
    if (previous && BigInt(previous.observedAt) > BigInt(page.projection_head)) continue;
    if (previous?.value.state === 'deleted' && value.state === 'present') throw new Error('A deleted message cannot be recreated in the same database history.');
    if (previous && previous.observedAt === page.projection_head && JSON.stringify(bodyIdentity(previous.value)) !== JSON.stringify(bodyIdentity(value))) throw new Error('Conflicting authoritative message states at the same revision.');
    tx.put(RECOVERY_STATE_NAMESPACE, key, { observedAt: page.projection_head, value } satisfies StoredRecoveryState);
  }
}
export type LiveRecoveryMutation = { kind: 'create' | 'update'; message: Message }
  | { kind: 'delete'; channelId: string; messageId: string; revision: string };

/** A transport position never proves channel continuity; only the next exact body revision does. */
export async function stageLiveRecoveryMutation(tx: VaultTransaction, mutation: LiveRecoveryMutation,
  stage?: (tx: VaultTransaction, page: RecoveryPage) => Promise<void>): Promise<'accepted' | 'duplicate' | 'gap'> {
  const channelId = mutation.kind === 'delete' ? mutation.channelId : mutation.message.channel_id;
  const messageId = mutation.kind === 'delete' ? mutation.messageId : mutation.message.id;
  const order = revision(mutation.kind === 'delete' ? mutation.revision : mutation.message.message_revision);
  id(channelId); id(messageId);
  const cursor = await tx.get<RecoveryCursor>(RECOVERY_CURSOR_NAMESPACE, channelId);
  if (!cursor?.complete) return 'gap';
  if (BigInt(order) <= BigInt(cursor.cursor)) return 'duplicate';
  if (BigInt(order) !== BigInt(cursor.cursor) + 1n) return 'gap';
  let archive: RecoveryArchive | null = null;
  let state: RecoveryState;
  if (mutation.kind === 'delete') state = { message_id: messageId, state: 'deleted', revision: order };
  else {
    validateMessage(mutation.message, channelId, messageId, false);
    state = { message_id: messageId, state: 'present', revision: order, message: mutation.message };
    if (mutation.message.e2ee) {
      const message = mutation.message;
      // Public authors can be reassigned to the deleted-user projection. Only
      // the server's immutable archive can supply the original ratchet sender.
      if (message.author.id === '-1') return 'gap';
      archive = { id: messageId, channel_id: channelId, author: { id: message.author.id }, content: '', e2ee: message.e2ee!,
        nonce: message.nonce, timestamp: message.timestamp ?? message.created_at, edited_timestamp: message.edited_timestamp ?? message.edited_at, flags: message.flags };
    }
  }
  const page: RecoveryPage = { database_history_epoch: '', channel_id: channelId, after: cursor.cursor, through: order,
    floor: cursor.cursor, next: order, complete: true, projection_head: order,
    changes: [{ kind: mutation.kind, revision: order, message_id: messageId, archived_message: archive }], states: [state] };
  await stageRecoveryPage(tx, page); await stage?.(tx, page);
  tx.put(RECOVERY_CURSOR_NAMESPACE, channelId, { cursor: order, through: null, complete: true } satisfies RecoveryCursor);
  return 'accepted';
}

/** One fixed fence per run; newer projection heads never make the loop unbounded. */
export async function recoverChannelMessages(options: {
  vault: AccountVault; lifetime: { signal: AbortSignal; assertCurrent(): void }; channelId: string;
  /** Only unencrypted channels may use a server-proven head to audit known IDs without ratchet history. */
  plaintextSnapshotAt?: string;
  /** An authenticated live revision can select a fixed upper fence for a detected gap. */
  through?: string;
  knownIds: string[]; fetchPage(request: RecoveryRequest): Promise<RecoveryPage>;
  stage?: (tx: VaultTransaction, page: RecoveryPage) => Promise<void>;
}) {
  const { vault, lifetime, channelId } = options; id(channelId);
  const known = [...new Set(options.knownIds.map(id))];
  return withMessageRecoveryLock(vault, lifetime, channelId, async () => {
    lifetime.assertCurrent();
    const stored = await vault.transact(tx => tx.get<RecoveryCursor>(RECOVERY_CURSOR_NAMESPACE, channelId));
    let committedCursor = stored?.cursor ?? '0';
    const baseline = options.plaintextSnapshotAt === undefined ? undefined : revision(options.plaintextSnapshotAt);
    let cursor = baseline && BigInt(baseline) > BigInt(committedCursor) ? baseline : committedCursor;
    let through = baseline ? cursor : (stored?.complete ? options.through : stored?.through ?? options.through);
    if (through !== undefined && BigInt(through) < BigInt(cursor)) through = cursor;
    const firstIds = known.slice(0, 100);
    let page: RecoveryPage;
    do {
      const request = { channelId, after: cursor, through, knownIds: firstIds };
      page = await options.fetchPage(request); lifetime.assertCurrent();
      await vault.transact(async tx => {
        lifetime.assertCurrent();
        const current = await tx.get<RecoveryCursor>(RECOVERY_CURSOR_NAMESPACE, channelId);
        if ((current?.cursor ?? '0') !== committedCursor) throw new Error('Another window advanced message recovery.');
        await stageRecoveryPage(tx, page); await options.stage?.(tx, page); lifetime.assertCurrent();
        tx.put(RECOVERY_CURSOR_NAMESPACE, channelId, { cursor: page.next, through: page.through, complete: false } satisfies RecoveryCursor);
      });
      cursor = page.next; committedCursor = cursor; through = page.through;
    } while (!page.complete);
    for (let offset = 100; offset < known.length; offset += 100) {
      const audit = await options.fetchPage({ channelId, after: cursor, through, knownIds: known.slice(offset, offset + 100) }); lifetime.assertCurrent();
      await vault.transact(async tx => {
        if ((await tx.get<RecoveryCursor>(RECOVERY_CURSOR_NAMESPACE, channelId))?.cursor !== cursor) throw new Error('Another window advanced message recovery.');
        await stageRecoveryPage(tx, audit); await options.stage?.(tx, audit); lifetime.assertCurrent();
      });
    }
    await vault.transact(async tx => {
      lifetime.assertCurrent();
      if ((await tx.get<RecoveryCursor>(RECOVERY_CURSOR_NAMESPACE, channelId))?.cursor !== cursor) throw new Error('Another window advanced message recovery.');
      tx.put(RECOVERY_CURSOR_NAMESPACE, channelId, { cursor, through: null, complete: true } satisfies RecoveryCursor);
    });
    lifetime.assertCurrent(); return cursor;
  });
}

/** Always take the channel lock before opening a vault transaction. */
export async function withMessageRecoveryLock<T>(vault: AccountVault, lifetime: { signal: AbortSignal; assertCurrent(): void }, channelId: string, run: () => Promise<T>): Promise<T> {
  id(channelId);
  return await navigator.locks.request(`paracord:message-recovery:${accountScopeKey(vault.scope)}:${channelId}`, { mode: 'exclusive', signal: lifetime.signal }, async () => {
    lifetime.assertCurrent(); const result = await run(); lifetime.assertCurrent(); return result;
  });
}
