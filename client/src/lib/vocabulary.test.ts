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

/*
 * Presence and activity are said in plain words (2026-09-22: "Styling yes,
 * terminology is kind of silly"). The light STYLING stays — a live thing may
 * glow — but the copy says online, here, live and empty, never the metaphor
 * (docs/server-home-spec.md, "Plain words").
 */

/** "Lights on", "has their lights on", "Lights off" — the status is Online. */
const LIGHTS_ON = /(^|[^A-Za-z])lights? (on|off)(?![A-Za-z])/i;

/**
 * "reading" as a presence word: "5 reading", "the 3 people reading", "Mara is
 * reading #general", "reading this". A count or a name that was interpolated in
 * front of it leaves a leading hole (`${count} reading` sweeps as " reading").
 * "Reading the last few hours…" or "Error reading a file" is the verb, and none
 * of these shapes catch it.
 */
const READING = new RegExp(
  [
    /(^|[^A-Za-z])(\d+|people|person|are|is|was|were)\s+reading(?![A-Za-z])/i.source,
    /^\s+reading(?![A-Za-z])/.source,
    /(^|[^A-Za-z])reading (this|now)(?![A-Za-z])/i.source,
  ].join('|'),
  'i',
);

/**
 * A channel or a call is live, active or empty, never "lit": "never lit",
 * "last lit", "lit up", "2 channels lit".
 */
const LIT = /(^|[^A-Za-z])(never lit|last lit|lit up|lights up|(channels?|rooms?|calls?) lit)(?![A-Za-z])/i;

/** "Dark · nobody in", "general is dark" — an empty channel is empty. */
const DARK = /(^|[^A-Za-z])(Dark ·|is dark(?![A-Za-z]))/;

/** The design-token page describing the styling itself, where dark is a colour. */
const DARK_ALLOWED = [/not light is dark, matte/];

/**
 * Files the plain-words sweep does not read yet: the server home rewrite
 * (feat/server-home) replaces every file in this directory with its own copy
 * in plain words. Delete this list when that branch lands.
 */
const PLAIN_WORDS_PENDING = ['/components/rooms/lobby/'];

function sweep(
  rule: RegExp,
  allowed: readonly RegExp[],
  skip: readonly string[] = [],
): string[] {
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    if (skip.some((part) => file.includes(part))) continue;
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
  // "Instance" is the right word for the person who RUNS one. It is not a word
  // somebody who was sent an invite should have to look up, so the first screen
  // a newcomer sees talks about the thing they were sent and the thing they are
  // joining. (2026-09-20: install and first run must need no glossary.)
  it('asks a newcomer for an invite link, in words they already have', () => {
    const copy = copyOf('pages/ServerConnectPage.tsx');
    expect(copy).toContain('Join a server');
    expect(copy).toContain('Invite link');
    expect(copy).not.toContain('Connect to an instance');
    expect(copy).not.toContain('Probing');
    expect(copy).not.toContain('portable link');
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

describe('presence and activity are plain words', () => {
  it('never says "lights on" or "lights off"', () => {
    expect(sweep(LIGHTS_ON, [], PLAIN_WORDS_PENDING)).toEqual([]);
  });

  it('never says "reading" to mean somebody is here', () => {
    expect(sweep(READING, [], PLAIN_WORDS_PENDING)).toEqual([]);
  });

  it('never says a channel is lit, or was', () => {
    expect(sweep(LIT, [], PLAIN_WORDS_PENDING)).toEqual([]);
  });

  it('never says "Dark ·" or that a channel "is dark"', () => {
    expect(sweep(DARK, DARK_ALLOWED, PLAIN_WORDS_PENDING)).toEqual([]);
  });

  it('catches "reading" as presence and leaves the verb alone', () => {
    for (const presence of [
      '5 reading',
      ' reading', // `${count} reading`, after its hole is swept out
      'Say something to the 3 people reading',
      'Say something to the 1 person reading',
      'Mara and Ren are reading build-log',
      'Ren · lights on · reading this',
    ]) {
      expect(READING.test(presence), presence).toBe(true);
    }
    for (const verb of [
      'Reading the last few hours…',
      'loading/reading a file',
      'Error reading file',
      'Failed while reading the backup',
      'reading', // a bare token: a chip tone, a class suffix
    ]) {
      expect(READING.test(verb), verb).toBe(false);
    }
  });

  it('calls the status you set on yourself Online, and invisible stays invisible', () => {
    const plate = copyOf('components/layout/sidebar/AccountPlate.tsx');
    expect(plate).toContain('Online');
    expect(plate).toContain('Invisible');
    expect(copyOf('lib/presence.ts')).toContain('Online');
  });
});
