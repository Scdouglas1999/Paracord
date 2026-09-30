/**
 * An event named in a message is `<event:ID>`, resolved against the
 * conversation's server (the way `<#id>` names a channel and `<@&id>` a role).
 *
 * A message that is nothing but events is an event share, and reads as a plan
 * card. An event named inside a sentence stays a chip in that sentence
 * (`lib/markdown.ts` draws it), so "@Sean is <event:7002> still on?" keeps its
 * words.
 */

const ONLY_EVENTS = /^\s*(?:<event:\d+>\s*)+$/;
const EVENT_TOKEN = /<event:(\d+)>/g;

/** The event ids of a message that is only events, in order; empty for any other message. */
export function eventCardIds(content: string | null | undefined): string[] {
  if (!content || !ONLY_EVENTS.test(content)) return [];
  return [...new Set([...content.matchAll(EVENT_TOKEN)].map((match) => match[1]))];
}
