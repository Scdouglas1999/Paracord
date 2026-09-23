import { describe, expect, it } from 'vitest';
import {
  composeDmForwardBody,
  forwardAttribution,
  forwardBlockedReason,
  forwardQuote,
  messageBubbleText,
  splitDmForwardBody,
} from './forwardedMessage';
import type { Attachment, ForwardedFrom } from '../types';

const serverForward: ForwardedFrom = {
  channel_id: '2',
  message_id: '3',
  guild_id: '1',
  author_name: 'Yara Haddad',
  channel_name: 'design',
  sent_at: '2026-09-22T18:20:00Z',
  content: 'moodboard for the lobby',
};

describe('forwarded messages', () => {
  it('keeps a note and an encrypted quote apart inside one body', () => {
    const body = composeDmForwardBody('  for you  ', 'the original words');
    expect(splitDmForwardBody(body)).toEqual({ note: 'for you', quote: 'the original words' });
    expect(splitDmForwardBody(composeDmForwardBody('', 'only a quote'))).toEqual({ note: '', quote: 'only a quote' });
  });

  it('shows the note in the bubble and the quote on the card', () => {
    const dmForward = { ...serverForward, guild_id: null, content: null };
    const content = composeDmForwardBody('note', 'quoted');
    expect(messageBubbleText({ content, forwarded_from: dmForward })).toBe('note');
    expect(forwardQuote({ content, forwarded_from: dmForward })).toBe('quoted');
    // A server forward keeps its quote on the server; the bubble is the note as sent.
    expect(messageBubbleText({ content: 'note', forwarded_from: serverForward })).toBe('note');
    expect(forwardQuote({ content: 'note', forwarded_from: serverForward })).toBe('moodboard for the lobby');
  });

  it('names where, who and when', () => {
    expect(forwardAttribution(serverForward)).toMatch(/^Forwarded from #design · Yara Haddad · \d/);
    expect(forwardAttribution({ ...serverForward, guild_id: null, sent_at: undefined }))
      .toBe('Forwarded from Direct message · Yara Haddad');
  });

  it('says why a message cannot be forwarded', () => {
    const file = { id: '9', filename: 'a.png' } as Attachment;
    expect(forwardBlockedReason({ attachments: [file] }, { sourceIsDm: true, unreadable: false }))
      .toBe('Attachments from an end-to-end encrypted conversation cannot be forwarded.');
    expect(forwardBlockedReason({ attachments: [file] }, { sourceIsDm: false, unreadable: false })).toBeNull();
    expect(forwardBlockedReason({ attachments: [] }, { sourceIsDm: true, unreadable: true }))
      .toMatch(/cannot be read on this device/);
  });
});
