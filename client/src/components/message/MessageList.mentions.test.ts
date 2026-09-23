import { describe, expect, it } from 'vitest';
import { messageMentionsUser } from './MessageList';
import type { Message } from '../../types';
import { MessageType } from '../../types';

function msg(partial: Partial<Message> & Pick<Message, 'content' | 'mention_everyone' | 'author'>): Message {
  return {
    id: 'm1',
    channel_id: 'ch1',
    tts: false,
    pinned: false,
    type: MessageType.Default,
    attachments: [],
    reactions: [],
    ...partial,
  };
}

describe('messageMentionsUser', () => {
  it('returns false for own messages', () => {
    expect(
      messageMentionsUser(
        msg({
          content: '<@me>',
          mention_everyone: false,
          author: { id: 'me', username: 'me', discriminator: '0' },
        }),
        'me',
      ),
    ).toBe(false);
  });

  it('detects @everyone', () => {
    expect(
      messageMentionsUser(
        msg({
          content: 'hi',
          mention_everyone: true,
          author: { id: 'other', username: 'o', discriminator: '0' },
        }),
        'me',
      ),
    ).toBe(true);
  });

  it('detects <@id> and <@!id> mentions', () => {
    expect(
      messageMentionsUser(
        msg({
          content: 'hey <@me> look',
          mention_everyone: false,
          author: { id: 'other', username: 'o', discriminator: '0' },
        }),
        'me',
      ),
    ).toBe(true);
    expect(
      messageMentionsUser(
        msg({
          content: 'hey <@!me> look',
          mention_everyone: false,
          author: { id: 'other', username: 'o', discriminator: '0' },
        }),
        'me',
      ),
    ).toBe(true);
  });

  it('ignores unrelated content', () => {
    expect(
      messageMentionsUser(
        msg({
          content: 'hey <@someone-else>',
          mention_everyone: false,
          author: { id: 'other', username: 'o', discriminator: '0' },
        }),
        'me',
      ),
    ).toBe(false);
  });

  it('reaches the reader through a role they hold, and only that role', () => {
    const roleMention = msg({
      content: 'heads up <@&42> the tokens landed',
      mention_everyone: false,
      author: { id: 'other', username: 'o', discriminator: '0' },
    });
    expect(messageMentionsUser(roleMention, 'me', new Set(['42']))).toBe(true);
    expect(messageMentionsUser(roleMention, 'me', new Set(['7']))).toBe(false);
    expect(messageMentionsUser(roleMention, 'me')).toBe(false);
  });
});
