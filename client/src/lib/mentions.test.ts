import { describe, expect, it } from 'vitest';
import { contentMentionsEveryone, mentionsEveryone } from './mentions';

/**
 * `mention_everyone` is typed as a required boolean but no Paracord server
 * emits it — `build_message_json` never sets the field. Reading it directly
 * therefore evaluated to `undefined` for every real message, which is why
 * @everyone never highlighted and never produced a mention badge.
 */
describe('contentMentionsEveryone', () => {
  it('matches a standalone @everyone token', () => {
    expect(contentMentionsEveryone('@everyone')).toBe(true);
    expect(contentMentionsEveryone('hey @everyone!')).toBe(true);
    expect(contentMentionsEveryone('(@everyone)')).toBe(true);
    expect(contentMentionsEveryone('line one\n@everyone')).toBe(true);
  });

  it('does not match when @everyone is part of a longer token', () => {
    expect(contentMentionsEveryone('foo@everyone')).toBe(false);
    expect(contentMentionsEveryone('@everyoneelse')).toBe(false);
    expect(contentMentionsEveryone('@everyone-ish')).toBe(false);
  });

  it('is safe on non-string content', () => {
    expect(contentMentionsEveryone(null)).toBe(false);
    expect(contentMentionsEveryone(undefined)).toBe(false);
    expect(contentMentionsEveryone('')).toBe(false);
    expect(contentMentionsEveryone(42)).toBe(false);
  });
});

describe('mentionsEveryone', () => {
  it('derives from content when the server omits the field', () => {
    // This is the shape every real Paracord message has.
    expect(mentionsEveryone({ content: 'ship it @everyone' })).toBe(true);
    expect(mentionsEveryone({ content: 'ship it' })).toBe(false);
  });

  it('honours an explicit boolean from a server that does compute it', () => {
    // A server may deliberately strip the ping when the author lacks
    // MENTION_EVERYONE; the client must not override that decision.
    expect(mentionsEveryone({ mention_everyone: false, content: '@everyone' })).toBe(false);
    expect(mentionsEveryone({ mention_everyone: true, content: 'no token here' })).toBe(true);
  });

  it('treats null like an absent field', () => {
    expect(mentionsEveryone({ mention_everyone: null, content: '@everyone' })).toBe(true);
  });
});
