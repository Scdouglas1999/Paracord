import { describe, expect, it } from 'vitest';

import type { ConversationSubject } from './types';
import { buildWelcome, greetingFor, joinerActions, nextGameNight, sharedLine, startLine, type WelcomeFacts } from './welcomeModel';

const CHANNEL: ConversationSubject = { kind: 'channel', guildId: 'g1', channelId: 'c1', channelName: 'general' };
const DM: ConversationSubject = { kind: 'dm', channelId: 'd1', title: 'Jeremy', isGroup: false };
const GROUP: ConversationSubject = { kind: 'dm', channelId: 'd2', title: 'Launch crew', isGroup: true, participants: 4 };

const facts = (over: Partial<WelcomeFacts> = {}): WelcomeFacts => ({
  subject: CHANNEL,
  serverName: 'Fuel',
  description: null,
  firstChannel: true,
  serverEmpty: true,
  joiner: false,
  canInvite: true,
  canPlan: true,
  canSend: true,
  hasRoles: false,
  ...over,
});

describe('the welcome (§4.13)', () => {
  it('a new server says "<Server> is ready" with the three cards in the spec’s order', () => {
    expect(buildWelcome(facts())).toEqual({
      variant: 'server',
      title: 'Fuel is ready',
      line: 'Three good ways to start it.',
      actions: ['invite', 'plan', 'hello'],
    });
  });

  it('leaves out the cards a person lacks permission for, and counts what is left', () => {
    expect(buildWelcome(facts({ canInvite: false }))).toMatchObject({ actions: ['plan', 'hello'], line: 'Two good ways to start it.' });
    expect(buildWelcome(facts({ canInvite: false, canPlan: false }))).toMatchObject({ actions: ['hello'], line: 'One good way to start it.' });
    expect(buildWelcome(facts({ canInvite: false, canPlan: false, canSend: false }))).toMatchObject({ actions: [], line: 'Nothing here yet.' });
  });

  it('is the server’s welcome only in its first channel while the whole server is empty', () => {
    expect(buildWelcome(facts({ firstChannel: false })).variant).toBe('channel');
    expect(buildWelcome(facts({ serverEmpty: false })).variant).toBe('channel');
  });

  it('any other empty channel says "<channel> is ready", its topic or "Nothing here yet.", and the cards that fit', () => {
    const plain = buildWelcome(facts({ firstChannel: false, canInvite: false }));
    expect(plain).toEqual({ variant: 'channel', title: 'general is ready', line: 'Nothing here yet.', actions: ['hello', 'plan'] });
    const topical = buildWelcome(
      facts({ firstChannel: false, subject: { ...CHANNEL, channelName: 'plans', topic: '  Game nights and meetups ' }, canPlan: false }),
    );
    expect(topical).toMatchObject({ title: 'plans is ready', line: 'Game nights and meetups', actions: ['hello'] });
  });

  it('a joiner is welcomed with the server’s description and Say hello, See who’s here, Pick roles', () => {
    const joiner = buildWelcome(facts({ joiner: true, serverName: 'Game Night', description: 'Haz 5 runs from 9.', hasRoles: true }));
    expect(joiner).toEqual({
      variant: 'joiner',
      title: 'Welcome to Game Night',
      line: 'Haz 5 runs from 9.',
      actions: ['hello', 'people', 'roles'],
    });
    expect(buildWelcome(facts({ joiner: true, canSend: false })).actions).toEqual(['people']);
    expect(buildWelcome(facts({ joiner: true })).line).toBe('Say hi when you’re ready.');
    expect(joinerActions({ canSend: true, hasRoles: false })).toEqual(['hello', 'people']);
  });

  it('a new message shows the person, and says "You’re friends" or what you share', () => {
    expect(buildWelcome(facts({ subject: DM, relationship: { friends: true, sharedServers: [] } }))).toEqual({
      variant: 'dm',
      title: 'Jeremy',
      line: 'You’re friends',
      actions: ['hello'],
    });
    expect(buildWelcome(facts({ subject: DM, relationship: { friends: false, sharedServers: ['Game Night'] } })).line).toBe('You share Game Night');
    expect(buildWelcome(facts({ subject: DM, relationship: { friends: false, sharedServers: [] } })).line).toBe('Direct message');
    expect(buildWelcome(facts({ subject: DM, canSend: false })).actions).toEqual([]);
  });

  it('a group says how many are in it, or who it is waiting on', () => {
    expect(buildWelcome(facts({ subject: GROUP }))).toEqual({ variant: 'group', title: 'Launch crew', line: 'Group · 4 people', actions: ['hello'] });
    const waiting = buildWelcome(facts({ subject: GROUP, waitingOn: ['ada', 'bo'] }));
    expect(waiting.title).toBe('Waiting on everyone’s encryption');
    expect(waiting.line).toContain('Waiting on: ada, bo.');
    expect(waiting.actions).toEqual([]);
  });

  it('never says "room" and never says "the start of"', () => {
    const all = [
      buildWelcome(facts()),
      buildWelcome(facts({ firstChannel: false })),
      buildWelcome(facts({ joiner: true })),
      buildWelcome(facts({ subject: DM })),
      buildWelcome(facts({ subject: GROUP })),
    ];
    for (const model of all) expect(`${model.title} ${model.line}`).not.toMatch(/\broom\b|start of/i);
  });

  it('startLine and sharedLine', () => {
    expect([0, 1, 2, 3].map(startLine)).toEqual([
      'Nothing here yet.',
      'One good way to start it.',
      'Two good ways to start it.',
      'Three good ways to start it.',
    ]);
    expect([[], ['A'], ['A', 'B'], ['A', 'B', 'C']].map(sharedLine)).toEqual([null, 'You share A', 'You share A and B', 'You share 3 servers']);
  });
});

describe('Say hello (§13.4)', () => {
  it('greets the channel, the person, the group, and a joiner', () => {
    expect(greetingFor(CHANNEL, { serverName: 'Fuel' })).toBe('Hello! Fuel is open, come hang out.');
    expect(greetingFor(CHANNEL, {})).toBe('Hello, everyone!');
    expect(greetingFor(CHANNEL, { serverName: 'Fuel', joiner: true })).toBe('Hi everyone, glad to be here!');
    expect(greetingFor({ ...DM, title: 'Jeremy Q' }, {})).toBe('Hey Jeremy!');
    expect(greetingFor(GROUP, {})).toBe('Hello, everyone!');
  });
});

describe('Plan a night’s time', () => {
  const at = (iso: string) => nextGameNight(new Date(iso));
  const label = (date: Date) => `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()} ${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;

  it('is the next Friday at 9:00 PM local that is more than a day and a half away', () => {
    // Thursday 1 October 2026 9:38 PM: tomorrow's 9 PM is 23 hours off, so it is the Friday after (the reference's "Fri 9").
    expect(label(at('2026-10-01T21:38:00'))).toBe('2026-10-9 21:00');
    // The gallery's clock, Monday 5 October 9:12 PM.
    expect(label(at('2026-10-05T21:12:00'))).toBe('2026-10-9 21:00');
    // Wednesday 9 PM: Friday 9 PM is 48 hours away.
    expect(label(at('2026-10-07T21:00:00'))).toBe('2026-10-9 21:00');
    // Thursday 8 AM: Friday 9 PM is 37 hours away.
    expect(label(at('2026-10-01T08:00:00'))).toBe('2026-10-2 21:00');
    // Friday afternoon: tonight is too close, so next Friday.
    expect(label(at('2026-10-02T15:00:00'))).toBe('2026-10-9 21:00');
    expect(at('2026-10-01T21:38:00').getDay()).toBe(5);
  });
});
