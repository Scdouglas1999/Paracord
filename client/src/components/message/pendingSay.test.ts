import { describe, expect, it } from 'vitest';
import { MessageType, type Message } from '../../types';
import { createPendingSay, isPendingMessageId, matchArrivals, pendingMessageId } from './pendingSay';

const me = { id: '42', username: 'sean', discriminator: '1' };
const them = { id: '51', username: 'vincent', discriminator: '1' };

function message(id: string, content: string, author = me): Message {
  return {
    id,
    channel_id: 'c1',
    author,
    content,
    created_at: '2026-10-01T21:12:00-05:00',
    tts: false,
    mention_everyone: false,
    pinned: false,
    type: MessageType.Default,
    attachments: [],
    reactions: [],
  };
}

function pending(nonce: string, text: string, known: string[], at = 1) {
  return createPendingSay({ nonce, channelId: 'c1', text, author: me, knownIds: known, now: at });
}

describe('a pending send', () => {
  it('is a stand-in row with an id no delivered message can have', () => {
    const say = pending('n1', 'hello', ['1']);
    expect(say.message.id).toBe(pendingMessageId('n1'));
    expect(isPendingMessageId(say.message.id)).toBe(true);
    expect(isPendingMessageId('364229500600320001')).toBe(false);
    expect(say.message).toMatchObject({ channel_id: 'c1', content: 'hello', author: me, type: MessageType.Default });
    expect(say.baseline.has('1')).toBe(true);
  });

  it('is a reply when it is sent as one, so the row it lands on has the room the chip needs', () => {
    const say = createPendingSay({ nonce: 'n1', channelId: 'c1', text: 'yes', author: me, replyToId: '77', knownIds: [], now: 1 });
    expect(say.message.type).toBe(MessageType.Reply);
    expect(say.message.reference_id).toBe('77');
  });
});

describe('which delivered message answers which send', () => {
  it('is the new message of yours that says what the send said', () => {
    const say = pending('n1', 'hello', ['1']);
    const arrived = message('2', 'hello');
    const matched = matchArrivals([message('1', 'hello'), arrived], [say], me.id);
    // The old "hello" is on the baseline: it answers nothing.
    expect(matched.get('n1')).toBe(arrived);
  });

  it('ignores other people, other words, and messages that were already there', () => {
    const say = pending('n1', 'hello', ['1']);
    expect(matchArrivals([message('1', 'hello'), message('2', 'hello', them)], [say], me.id).size).toBe(0);
    // Words differ but it is the only new message of yours: the order is the fallback
    // (a server that rewrote the text on the way).
    expect(matchArrivals([message('1', 'x'), message('2', 'HELLO')], [say], me.id).get('n1')?.id).toBe('2');
    expect(matchArrivals([message('1', 'x')], [say], me.id).size).toBe(0);
    expect(matchArrivals([message('2', 'hello')], [say], undefined).size).toBe(0);
  });

  it('gives each send its own message, by the words first and the order after', () => {
    const first = pending('n1', 'first', ['1'], 1);
    const second = pending('n2', 'second', ['1'], 2);
    const a = message('2', 'second');
    const b = message('3', 'first');
    const matched = matchArrivals([message('1', 'x'), a, b], [first, second], me.id);
    expect(matched.get('n1')).toBe(b);
    expect(matched.get('n2')).toBe(a);
    // One message answers one send: with only the first delivered, the second still waits.
    const alone = matchArrivals([message('1', 'x'), b], [first, second], me.id);
    expect(alone.get('n1')).toBe(b);
    expect(alone.has('n2')).toBe(false);
  });

  it('never gives one message to two sends', () => {
    const first = pending('n1', 'same', ['1'], 1);
    const second = pending('n2', 'same', ['1'], 2);
    const matched = matchArrivals([message('1', 'x'), message('2', 'same')], [first, second], me.id);
    expect(matched.get('n1')?.id).toBe('2');
    expect(matched.has('n2')).toBe(false);
  });
});
