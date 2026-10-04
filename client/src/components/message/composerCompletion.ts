/**
 * Completion in the message box (docs/index-spec.md §4.12; WP IX-12): what is
 * being completed at the caret, and the emoji shortcodes `:` offers.
 *
 *   @name     people and roles in the server
 *   #name     the server's channels
 *   :name     emoji: the server's own first, then the common shortcodes below
 *
 * Slash commands are a separate popover (`SlashCommandPopup`): they own the
 * whole draft, not a word in it.
 */

export type CompletionKind = 'mention' | 'channel' | 'emoji';

export interface CompletionQuery {
  kind: CompletionKind;
  /** What was typed after the trigger. */
  query: string;
  /** Index of the trigger character in the draft. */
  start: number;
}

/** At most this many rows show (§4.12: "max 6 rows"); the list scrolls past it. */
export const COMPLETION_ROWS = 6;

/**
 * The completion the caret is in, if any. `@` completes anywhere (an address
 * can follow punctuation); `#` and `:` only at the start of a word, so a URL
 * fragment or a time ("9:30") never opens a list. `:` waits for two letters.
 */
export function completionAt(text: string, caret: number): CompletionQuery | null {
  const before = text.slice(0, Math.max(0, caret));
  const mention = /@(\w*)$/.exec(before);
  if (mention) return { kind: 'mention', query: mention[1], start: before.length - mention[0].length };
  const channel = /(^|\s)#([\w-]*)$/.exec(before);
  if (channel) return { kind: 'channel', query: channel[2], start: before.length - channel[2].length - 1 };
  const emoji = /(^|\s):([\w+-]{2,})$/.exec(before);
  if (emoji) return { kind: 'emoji', query: emoji[2], start: before.length - emoji[2].length - 1 };
  return null;
}

/**
 * Replace the completion at `start` (through the caret) with `token` and a
 * space. Returns the new draft and where the caret goes.
 */
export function applyCompletion(text: string, caret: number, start: number, token: string): { text: string; caret: number } {
  const next = `${text.slice(0, start)}${token} ${text.slice(caret)}`;
  return { text: next, caret: start + token.length + 1 };
}

/**
 * The common shortcodes, the names people already type. Unicode emoji have no
 * names in the picker's data; these are the ones a `:` reaches.
 */
export const EMOJI_SHORTCODES: ReadonlyArray<readonly [string, string]> = [
  ['smile', '\u{1F604}'],
  ['grin', '\u{1F601}'],
  ['joy', '\u{1F602}'],
  ['rofl', '\u{1F923}'],
  ['slight_smile', '\u{1F642}'],
  ['upside_down', '\u{1F643}'],
  ['wink', '\u{1F609}'],
  ['blush', '\u{1F60A}'],
  ['heart_eyes', '\u{1F60D}'],
  ['star_struck', '\u{1F929}'],
  ['kiss', '\u{1F618}'],
  ['yum', '\u{1F60B}'],
  ['stuck_out_tongue', '\u{1F61B}'],
  ['thinking', '\u{1F914}'],
  ['shush', '\u{1F92B}'],
  ['neutral', '\u{1F610}'],
  ['expressionless', '\u{1F611}'],
  ['smirk', '\u{1F60F}'],
  ['unamused', '\u{1F612}'],
  ['eye_roll', '\u{1F644}'],
  ['grimace', '\u{1F62C}'],
  ['relieved', '\u{1F60C}'],
  ['pensive', '\u{1F614}'],
  ['sleepy', '\u{1F62A}'],
  ['sleeping', '\u{1F634}'],
  ['mask', '\u{1F637}'],
  ['nauseated', '\u{1F922}'],
  ['hot', '\u{1F975}'],
  ['cold', '\u{1F976}'],
  ['dizzy_face', '\u{1F635}'],
  ['exploding_head', '\u{1F92F}'],
  ['cowboy', '\u{1F920}'],
  ['party', '\u{1F973}'],
  ['sunglasses', '\u{1F60E}'],
  ['nerd', '\u{1F913}'],
  ['confused', '\u{1F615}'],
  ['worried', '\u{1F61F}'],
  ['frown', '\u{1F641}'],
  ['open_mouth', '\u{1F62E}'],
  ['astonished', '\u{1F632}'],
  ['flushed', '\u{1F633}'],
  ['pleading', '\u{1F97A}'],
  ['cry', '\u{1F622}'],
  ['sob', '\u{1F62D}'],
  ['scream', '\u{1F631}'],
  ['weary', '\u{1F629}'],
  ['yawn', '\u{1F971}'],
  ['triumph', '\u{1F624}'],
  ['rage', '\u{1F621}'],
  ['angry', '\u{1F620}'],
  ['skull', '\u{1F480}'],
  ['poop', '\u{1F4A9}'],
  ['clown', '\u{1F921}'],
  ['ghost', '\u{1F47B}'],
  ['alien', '\u{1F47D}'],
  ['robot', '\u{1F916}'],
  ['wave', '\u{1F44B}'],
  ['ok_hand', '\u{1F44C}'],
  ['v', '\u{270C}\u{FE0F}'],
  ['crossed_fingers', '\u{1F91E}'],
  ['call_me', '\u{1F919}'],
  ['point_up', '\u{261D}\u{FE0F}'],
  ['thumbsup', '\u{1F44D}'],
  ['thumbsdown', '\u{1F44E}'],
  ['fist', '\u{270A}'],
  ['punch', '\u{1F44A}'],
  ['clap', '\u{1F44F}'],
  ['raised_hands', '\u{1F64C}'],
  ['heart_hands', '\u{1FAF6}'],
  ['handshake', '\u{1F91D}'],
  ['pray', '\u{1F64F}'],
  ['muscle', '\u{1F4AA}'],
  ['eyes', '\u{1F440}'],
  ['heart', '\u{2764}\u{FE0F}'],
  ['orange_heart', '\u{1F9E1}'],
  ['yellow_heart', '\u{1F49B}'],
  ['green_heart', '\u{1F49A}'],
  ['blue_heart', '\u{1F499}'],
  ['black_heart', '\u{1F5A4}'],
  ['broken_heart', '\u{1F494}'],
  ['sparkling_heart', '\u{1F496}'],
  ['hundred', '\u{1F4AF}'],
  ['fire', '\u{1F525}'],
  ['sparkles', '\u{2728}'],
  ['star', '\u{2B50}'],
  ['zap', '\u{26A1}'],
  ['boom', '\u{1F4A5}'],
  ['tada', '\u{1F389}'],
  ['confetti', '\u{1F38A}'],
  ['balloon', '\u{1F388}'],
  ['gift', '\u{1F381}'],
  ['trophy', '\u{1F3C6}'],
  ['medal', '\u{1F3C5}'],
  ['crown', '\u{1F451}'],
  ['gem', '\u{1F48E}'],
  ['moneybag', '\u{1F4B0}'],
  ['rocket', '\u{1F680}'],
  ['video_game', '\u{1F3AE}'],
  ['dart', '\u{1F3AF}'],
  ['musical_note', '\u{1F3B5}'],
  ['headphones', '\u{1F3A7}'],
  ['popcorn', '\u{1F37F}'],
  ['pizza', '\u{1F355}'],
  ['coffee', '\u{2615}'],
  ['beer', '\u{1F37A}'],
  ['beers', '\u{1F37B}'],
  ['wine', '\u{1F377}'],
  ['cake', '\u{1F370}'],
  ['sun', '\u{2600}\u{FE0F}'],
  ['moon', '\u{1F319}'],
  ['rainbow', '\u{1F308}'],
  ['snowflake', '\u{2744}\u{FE0F}'],
  ['dog', '\u{1F436}'],
  ['cat', '\u{1F431}'],
  ['check', '\u{2705}'],
  ['x', '\u{274C}'],
  ['warning', '\u{26A0}\u{FE0F}'],
  ['question', '\u{2753}'],
  ['exclamation', '\u{2757}'],
  ['white_check_mark', '\u{2705}'],
  ['plus1', '\u{1F44D}'],
];

/** Shortcodes matching `query`: names that start with it first, then names that contain it. */
export function matchShortcodes(query: string, limit = 12): Array<{ name: string; emoji: string }> {
  const q = query.toLowerCase();
  if (!q) return [];
  const starts: Array<{ name: string; emoji: string }> = [];
  const contains: Array<{ name: string; emoji: string }> = [];
  for (const [name, emoji] of EMOJI_SHORTCODES) {
    if (name.startsWith(q)) starts.push({ name, emoji });
    else if (name.includes(q)) contains.push({ name, emoji });
  }
  // The shortest name that starts with it is the likeliest ("fi" is fire).
  starts.sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name));
  return [...starts, ...contains].slice(0, limit);
}

/** The channel types a `#` reaches: text, announcements, forums. Never voice. */
const LINKABLE_CHANNEL_TYPES = new Set([0, 5, 7]);

export function isLinkableChannel(channel: { type?: number; channel_type?: number }): boolean {
  return LINKABLE_CHANNEL_TYPES.has(channel.channel_type ?? channel.type ?? -1);
}

/**
 * "Slow mode: 12s" (§4.12): the per-person interval, in the largest whole unit
 * that says it (12s, 5m, 2h). Null when there is none.
 */
export function slowModeLabel(seconds: number | null | undefined): string | null {
  if (!seconds || seconds <= 0) return null;
  if (seconds < 60) return `Slow mode: ${seconds}s`;
  if (seconds < 3600) {
    const minutes = Math.round(seconds / 60);
    return `Slow mode: ${minutes}m`;
  }
  const hours = Math.round(seconds / 3600);
  return `Slow mode: ${hours}h`;
}
