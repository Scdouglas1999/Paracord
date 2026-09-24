import { describe, expect, it } from 'vitest';
import type { Message } from '../../../types';
import { composeDmForwardBody, forwardAttribution, forwardQuote, messageBubbleText, sealedForwardFor } from '../../forwardedMessage';
import {
  ENCRYPTED_BODY_PREFIX, EncryptedBodyError, decodeEncryptedBody, encodeEncryptedBody, encodeMessageBody,
  type SealedForward,
} from './attachmentEnvelope';
import { applyDecryptedBody } from './messageBodyProjection';

const forward: SealedForward = {
  channelId: '1100000000000000001',
  messageId: '1100000000000000002',
  authorId: '1100000000000000003',
  authorName: 'Yara Haddad',
  sentAt: '2026-09-22T18:20:00.000Z',
};

const encrypted = (overrides: Partial<Message> = {}): Message => ({
  id: '5555', channel_id: '42', content: '', attachments: [],
  author: { id: '7', username: 'mira', display_name: 'Mira', discriminator: '0' },
  e2ee: { version: 2, nonce: 'n', ciphertext: 'c', header: '{}' },
  ...overrides,
} as unknown as Message);

/**
 * What a 3.2 client does with a decrypted body, as shipped: a sentinel body
 * must be version 1 with a string `text` and an `attachments` array, and every
 * other field is ignored.
 */
function decodeAs32(plaintext: string): { text: string; attachments: unknown[] } {
  if (!plaintext.startsWith(ENCRYPTED_BODY_PREFIX)) return { text: plaintext, attachments: [] };
  const body = JSON.parse(plaintext.slice(ENCRYPTED_BODY_PREFIX.length)) as Record<string, unknown>;
  if (body.v !== 1) throw new Error('Update Paracord to open it.');
  if (typeof body.text !== 'string' || !Array.isArray(body.attachments)) throw new Error('could not be read');
  return { text: body.text, attachments: body.attachments };
}

describe('forward attribution sealed inside the encrypted body', () => {
  it('round-trips the attribution with the text', () => {
    const text = composeDmForwardBody('for you', 'the original words');
    const decoded = decodeEncryptedBody(encodeMessageBody(text, [], forward));
    expect(decoded.text).toBe(text);
    expect(decoded.forward).toEqual(forward);
    expect(decoded.attachments).toEqual([]);
  });

  it('keeps an ordinary message the bare text it always was', () => {
    expect(encodeMessageBody('hello')).toBe('hello');
    expect(decodeEncryptedBody('hello').forward).toBeUndefined();
  });

  it('stays readable by a 3.2 client, which shows the note and the quote', () => {
    const text = composeDmForwardBody('look at this', 'the original words');
    const as32 = decodeAs32(encodeMessageBody(text, [], forward));
    expect(as32.attachments).toEqual([]);
    // 3.2 has no attribution for this message, so it shows the whole body.
    const bubble = messageBubbleText({ content: as32.text, forwarded_from: null });
    expect(bubble).toContain('look at this');
    expect(bubble).toContain('the original words');
  });

  it('refuses a malformed attribution instead of showing it', () => {
    const bad = ENCRYPTED_BODY_PREFIX + JSON.stringify({
      v: 1, text: 'x', attachments: [], forward: { channelId: 'not-a-snowflake', messageId: '1' },
    });
    expect(() => decodeEncryptedBody(bad)).toThrow(EncryptedBodyError);
    const nul = ENCRYPTED_BODY_PREFIX + JSON.stringify({
      v: 1, text: 'x', attachments: [], forward: { ...forward, authorName: 'a\u0000b' },
    });
    expect(() => decodeEncryptedBody(nul)).toThrow(EncryptedBodyError);
    expect(() => encodeEncryptedBody({ text: 'x', attachments: [], forward: { ...forward, messageId: '' } }))
      .toThrow(EncryptedBodyError);
  });

  it('renders the same Forwarded header from the decrypted body', () => {
    const text = composeDmForwardBody('note', 'quoted words');
    const projected = applyDecryptedBody(encrypted(), encodeMessageBody(text, [], forward));
    expect(projected.forwarded_from).toMatchObject({
      channel_id: forward.channelId, message_id: forward.messageId, guild_id: null,
      author_name: 'Yara Haddad', content: null, sealed: forward,
    });
    expect(messageBubbleText(projected)).toBe('note');
    expect(forwardQuote(projected)).toBe('quoted words');
    expect(forwardAttribution(projected.forwarded_from!)).toMatch(/^Forwarded from Direct message · Yara Haddad · \d/);
  });

  it('still renders a forward a 3.2 client made, whose attribution the server holds', () => {
    const serverAttribution = {
      channel_id: '9', message_id: '10', guild_id: null, author_name: 'Jonas', channel_name: 'Direct message', content: null,
    };
    const text = composeDmForwardBody('', 'what jonas said');
    const projected = applyDecryptedBody(encrypted({ forwarded_from: serverAttribution }), text);
    expect(projected.forwarded_from).toEqual(serverAttribution);
    expect(forwardQuote(projected)).toBe('what jonas said');
  });

  it('only a decrypted body can mark an attribution as sealed', () => {
    const injected = { channel_id: '9', message_id: '10', content: null, sealed: forward };
    const projected = applyDecryptedBody(encrypted({ forwarded_from: injected }), 'plain words');
    expect(projected.forwarded_from?.sealed).toBeUndefined();
  });

  it('attributes a direct message to its author and time', () => {
    const source = encrypted({ id: '1100000000000000009', channel_id: '1100000000000000008', content: 'meet at six', created_at: '2026-09-20T10:00:00Z' });
    expect(sealedForwardFor(source)).toEqual({
      quote: 'meet at six',
      forward: {
        channelId: '1100000000000000008', messageId: '1100000000000000009',
        authorId: '7', authorName: 'Mira', sentAt: '2026-09-20T10:00:00Z',
      },
    });
  });

  it('forwarding a forward with no note points at the original', () => {
    const sealedSource = applyDecryptedBody(encrypted(), encodeMessageBody(composeDmForwardBody('', 'first words'), [], forward));
    expect(sealedForwardFor(sealedSource)).toEqual({ quote: 'first words', forward });

    const fromServer = encrypted({
      content: '',
      forwarded_from: {
        channel_id: '2', message_id: '3', guild_id: '1', channel_name: 'design',
        author_id: '4', author_name: 'Yara Haddad', sent_at: '2026-09-22T18:20:00Z', content: 'moodboard',
      },
    });
    expect(sealedForwardFor(fromServer)).toEqual({
      quote: 'moodboard',
      forward: {
        channelId: '2', messageId: '3', guildId: '1', channelName: 'design',
        authorId: '4', authorName: 'Yara Haddad', sentAt: '2026-09-22T18:20:00Z',
      },
    });

    // With a note of its own, the wrapper is what gets forwarded.
    const withNote = applyDecryptedBody(encrypted({ id: '1100000000000000011', channel_id: '1100000000000000012' }),
      encodeMessageBody(composeDmForwardBody('my note', 'first words'), [], forward));
    const again = sealedForwardFor(withNote);
    expect(again.quote).toBe('my note');
    expect(again.forward.messageId).toBe('1100000000000000011');
  });
});
