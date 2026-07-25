/**
 * Mention helpers shared by the gateway dispatch path and the message feed.
 *
 * `mention_everyone` is typed as a required boolean, but no Paracord server
 * actually emits the field — `build_message_json` never sets it. Reading it
 * directly therefore evaluated to `undefined` on every real message, which is
 * why @everyone highlighting and @everyone mention badges never fired for
 * anyone. Derive the value from the content whenever the field is absent.
 *
 * An explicit `false` from a server that *does* compute the flag is still
 * honoured: that server may have deliberately stripped the ping because the
 * author lacked MENTION_EVERYONE, and the client must not override it.
 */

/**
 * `@everyone` as a standalone token. The leading class rejects `foo@everyone`
 * (an address, not a ping) while still allowing punctuation like `(@everyone)`;
 * the trailing lookahead rejects `@everyoneelse`.
 */
const EVERYONE_TOKEN_RE = /(?:^|[^\w@])@everyone(?![\w-])/;

export function contentMentionsEveryone(content: unknown): boolean {
  if (typeof content !== 'string' || content.length === 0) return false;
  return EVERYONE_TOKEN_RE.test(content);
}

/** Resolve a message's effective @everyone state, field-first then content. */
export function mentionsEveryone(msg: {
  mention_everyone?: boolean | null;
  content?: string | null;
}): boolean {
  if (typeof msg.mention_everyone === 'boolean') return msg.mention_everyone;
  return contentMentionsEveryone(msg.content);
}
