import { MessageType, type Message, type MessageAuthor } from '../../types';

/**
 * A message that has left the composer and has not been answered for yet.
 *
 * The send flight (`lib/motion/sendFlight.ts`) needs a place to land the moment
 * the key goes down, and the timeline has no optimistic row: the runtime
 * publishes a message only once the authoritative recovery feed has vouched for
 * it. So the timeline holds a view-local stand-in. It is NEVER in the message
 * store — nothing that reads the store (unread counts, previews, read state,
 * the Stage's chat ribbon, search) can see it, and a pending row can never be
 * marked read, reacted to, replied to or deleted. It is only appended to the
 * rows the list draws, in the slot the delivered message will take, so the
 * delivered row replaces it in the same render.
 */
export interface PendingSay {
  nonce: string;
  /** What was typed, trimmed: what the composer sent. */
  text: string;
  /** When the key went down. */
  at: number;
  /** The ids on the timeline when it began; an arrival is a message not in here. */
  baseline: ReadonlySet<string>;
  /** The stand-in row. */
  message: Message;
}

/** The stand-in's id. Real ids are snowflakes, so this can never collide. */
const PENDING_PREFIX = 'sending:';

export function pendingMessageId(nonce: string): string {
  return `${PENDING_PREFIX}${nonce}`;
}

export function isPendingMessageId(id: string): boolean {
  return id.startsWith(PENDING_PREFIX);
}

export interface PendingSayInput {
  nonce: string;
  channelId: string;
  text: string;
  author: MessageAuthor;
  replyToId?: string | null;
  knownIds: Iterable<string>;
  now: number;
}

export function createPendingSay({ nonce, channelId, text, author, replyToId, knownIds, now }: PendingSayInput): PendingSay {
  const stamp = new Date(now).toISOString();
  const message: Message = {
    id: pendingMessageId(nonce),
    channel_id: channelId,
    author,
    content: text,
    created_at: stamp,
    timestamp: stamp,
    tts: false,
    mention_everyone: false,
    pinned: false,
    type: replyToId ? MessageType.Reply : MessageType.Default,
    attachments: [],
    reactions: [],
    ...(replyToId ? { reference_id: replyToId } : {}),
  };
  return { nonce, text, at: now, baseline: new Set(knownIds), message };
}

/**
 * Which delivered message answers which pending send.
 *
 * An arrival is a message by you that was not on the timeline when the send
 * began. The text it carries is the best witness (the same words come back),
 * and the order is the fallback for a server that rewrote them. Each message
 * answers at most one send, and each send takes at most one message.
 */
export function matchArrivals(
  messages: readonly Message[],
  pendings: readonly PendingSay[],
  me: string | null | undefined,
): Map<string, Message> {
  const matched = new Map<string, Message>();
  if (!me || pendings.length === 0) return matched;
  const taken = new Set<string>();
  const candidatesFor = (pending: PendingSay) =>
    messages.filter((message) => message.author?.id === me && !pending.baseline.has(message.id) && !taken.has(message.id));

  // The words first: a send finds the message that says what it said.
  for (const pending of pendings) {
    const found = candidatesFor(pending).find((message) => (message.content ?? '').trim() === pending.text);
    if (!found) continue;
    matched.set(pending.nonce, found);
    taken.add(found.id);
  }
  // Then the order, for whatever the server changed on the way.
  for (const pending of pendings) {
    if (matched.has(pending.nonce)) continue;
    const found = candidatesFor(pending)[0];
    if (!found) continue;
    matched.set(pending.nonce, found);
    taken.add(found.id);
  }
  return matched;
}
