/**
 * The product says "server", "channel" and "instance".
 *
 * A server is the community you belong to; a channel is the thing inside it;
 * an instance is the host somebody runs. The API, the routes and the code still
 * say `guild` — that is a wire word and it is fine. What is not fine is a
 * SECOND user-facing name for the same object: the shell used to say "building"
 * and "room" while the Connect screen said "server" for the host, so a reader
 * had to guess which of two things a sentence meant, and did.
 *
 * This test reads the source and fails on the retired words in anything a
 * person can read — string literals and JSX text — with an allow-list for each
 * word's other, legitimate meanings (a gap, the space bar, room to breathe).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Files whose strings are not user-facing copy. */
const SKIP = [
  '.test.',
  '/test/',
  '/api/generated/',
  '/types/',
  'bip39-wordlist.ts',
  'vocabulary.test.ts',
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    if (SKIP.some((skip) => full.includes(skip))) continue;
    out.push(full);
  }
  return out;
}

/**
 * Source with every comment removed — a comment may say whatever it likes.
 *
 * Lexed rather than regexed: `accept="image/*"` is a string, not the start of a
 * block comment, and a regex that thinks otherwise swallows the labels after it.
 */
function withoutComments(source: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < source.length; ) {
    const c = source[i];
    if (quote) {
      if (c === '\\') { out += source.slice(i, i + 2); i += 2; continue; }
      if (c === quote) quote = null;
      out += c; i += 1; continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; out += c; i += 1; continue; }
    if (c === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      i = end < 0 ? source.length : end;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    out += c; i += 1;
  }
  return out;
}

/**
 * Every string literal and every run of JSX text. Deliberately rough: it over-
 * collects (a class list is a string too, and a `=>` … `<` in plain TypeScript
 * looks like JSX text), so the words below are matched in a shape that an
 * identifier cannot wear — see {@link word}.
 *
 * `${…}` spans are dropped rather than kept: the code inside one is an
 * expression, not copy, and `${room.name}` is not the product saying "room".
 */
function readableStrings(source: string): string[] {
  const strings: string[] = [];
  const literal = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  for (const match of source.matchAll(literal)) {
    strings.push(withoutInterpolations(match[1] ?? match[2] ?? match[3] ?? ''));
  }
  const jsxText = />([^<>{}]*[A-Za-z][^<>{}]*)</g;
  for (const match of source.matchAll(jsxText)) {
    if (isCode(match[1])) continue;
    strings.push(match[1]);
  }
  return strings;
}

/**
 * A `=>` in plain TypeScript opens a run that ends at the next `<`, so the
 * crude JSX sweep above also collects code: `[building, channelId],\n );`.
 * Prose does not carry a semicolon or an `=` — `&rsquo;` is the one exception,
 * and entities are removed before the question is asked.
 */
function isCode(run: string): boolean {
  return /[;=]/.test(run.replace(/&(?:[a-zA-Z]+|#\d+);/g, ''));
}

/** A template literal's `${…}` holes are code, not words. */
function withoutInterpolations(value: string): string {
  return value.replace(/\$\{[^}]*\}/g, ' ');
}

/**
 * A console line, not copy: every one of ours opens with a bracketed tag
 * (`[voice] …`, `[gateway] …`) and goes to a developer's terminal, where the
 * LiveKit `Room` it names is the right word for the object it is about.
 */
function isConsoleLine(value: string): boolean {
  return /^\[[a-z][a-z-]*\]\s/.test(value.trim());
}

/** A Tailwind class list is a string, but nobody reads it. */
function isClassList(value: string): boolean {
  const words = value.trim().split(/\s+/);
  return (
    words.length > 0
    && words.every((word) => /^[a-z0-9:[\]()_./+-]+$/.test(word) && /[-:[]/.test(word))
  );
}

/**
 * One banned noun, in the only shape a reader would recognise as that word.
 *
 * An identifier wears the word too — `building.name`, `useRoomMenu`,
 * `./BuildingPlate`, `group/room`, `data-motion-shared="tokens-room"` — and
 * renaming identifiers was explicitly out of scope, so the match refuses any
 * neighbour that makes the word part of a longer name or a path: a letter, a
 * digit, `_`, `$`, `/`, `-`, or a `.` that is followed by more identifier. A
 * full stop that ends a sentence still counts, because "manage this building."
 * is the product saying it.
 */
function word(noun: string): RegExp {
  return new RegExp(
    `(^|[^A-Za-z0-9_.$/-])(${noun})(?![A-Za-z0-9_$/-])(?!\\.[A-Za-z_$])`,
  );
}

/** The community. It is a server now; it was never a building. */
const BUILDING = word('[Bb]uildings?');

/** The thing inside it. It is a channel — text or voice — never a room. */
const ROOM = word('[Rr]ooms?');

/** The third name the settings screens used to use. */
const PLACE = word('[Ss]paces?');

/** The wire word for a server. It belongs in the API, not on a label. */
const GUILD = word('[Gg]uilds?');

/** Where the banned nouns are still the right words. */
const BUILDING_ALLOWED: readonly RegExp[] = [];

const ROOM_ALLOWED = [
  /room to breathe/i, // the gap around a message, not the place
  /^rooms?$/, // a bare token: a tour step id, a voice-level source
  /aria-label="Live rooms"/, // a retired label kept in a selector for old bundles
];

const PLACE_ALLOWED = [
  /separated by spaces/i,
  /symbol or space/i,
  /or space\./i,
  /spacebar/i,
  /no spaces\)/i, // "Name (lowercase, no spaces)" — the character, not the place
  /^space$/, // the key name, normalised for keybinds — lowercase, exactly
];

const GUILD_ALLOWED = [
  /^GUILDS?$/, // a gateway intent, as the bot API spells it
  /^guilds?$/, // a bare token: a tab id, a request key, a tour step
  /\{guild\}/, // a moderation-template placeholder the server substitutes
  /guild list is not an array/, // a wire-contract failure, quoting the wire
  /guild core contract mismatch/,
  /guild invalid created_at/,
];

/**
 * Presence is light (§1.5), and §6.9 names "Online" as a thing the product
 * never says. The words live in `lib/presence` — "Lights on", "Away", "Lights
 * off" — and a surface that writes its own is a surface that will drift.
 */
const PRESENCE = /(^|[^A-Za-z-])(Online|Offline)(?![A-Za-z-])/;

/** Where the banned presence words are still the right ones. */
const PRESENCE_ALLOWED = [
  /^offline$/i, // a status id on the wire, not a label
  /offline-first/i,
];

function sweep(
  rule: RegExp,
  allowed: readonly RegExp[],
): string[] {
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const source = withoutComments(readFileSync(file, 'utf8'));
    for (const value of readableStrings(source)) {
      if (!rule.test(value)) continue;
      if (isClassList(value)) continue;
      if (isConsoleLine(value)) continue;
      // A JSX text run can swallow a comment; a comment may say what it likes.
      if (value.includes('//') || value.includes('/*')) continue;
      if (allowed.some((ok) => ok.test(value.trim()))) continue;
      offenders.push(`${file.slice(SRC.length + 1)}: ${value.trim().slice(0, 90)}`);
    }
  }
  return offenders;
}

/** Read one file's copy, for the positive checks below. */
function copyOf(relative: string): string {
  return readableStrings(withoutComments(readFileSync(join(SRC, relative), 'utf8'))).join('\n');
}

describe('the community is a server', () => {
  it('never says "building"', () => {
    expect(sweep(BUILDING, BUILDING_ALLOWED)).toEqual([]);
  });

  it('never says "space" where it means a server', () => {
    expect(sweep(PLACE, PLACE_ALLOWED)).toEqual([]);
  });

  it('never says "guild" at a person', () => {
    expect(sweep(GUILD, GUILD_ALLOWED)).toEqual([]);
  });

  it('names it a server where you make or join one', () => {
    const copy = copyOf('components/guild/CreateGuildModal.tsx');
    expect(copy).toContain('Create a server');
    expect(copy).toContain('Join a server');
    expect(copy).toContain('Server name');
  });
});

describe('the thing inside a server is a channel', () => {
  it('never says "room"', () => {
    expect(sweep(ROOM, ROOM_ALLOWED)).toEqual([]);
  });

  it('calls the two kinds text channels and voice channels', () => {
    const copy = copyOf('lib/features/channelGroups.ts');
    expect(copy).toContain('Text channels');
    expect(copy).toContain('Voice channels');
  });

  it('joins a voice channel by joining voice, not by entering a room', () => {
    const copy = copyOf('pages/guild/VoiceLobby.tsx');
    expect(copy).toContain('Join voice');
  });
});

describe('the host you run is an instance', () => {
  it('connects to an instance, not to a server', () => {
    const copy = copyOf('pages/ServerConnectPage.tsx');
    expect(copy).toContain('Connect to an instance');
    expect(copy).toContain('Instance address or invite link');
    expect(copy).toContain('Add instance');
    expect(copy).toContain('Your instances');
  });

  it('claims an instance, and names the first server inside it', () => {
    const copy = copyOf('pages/InstanceSetupPage.tsx');
    expect(copy).toContain('Set up your Paracord instance');
    expect(copy).toContain('Instance name');
    expect(copy).toContain('First server name');
    expect(copy).toContain('Claim this instance');
  });

  it('administers an instance, not a server', () => {
    expect(copyOf('pages/AdminPage.tsx')).toContain('Instance administration');
    expect(copyOf('pages/admin/SettingsPanel.tsx')).toContain('Instance settings');
  });
});

describe('presence is light, not a status word', () => {
  it('never says "Online" or "Offline" at a person', () => {
    expect(sweep(PRESENCE, PRESENCE_ALLOWED)).toEqual([]);
  });
});
