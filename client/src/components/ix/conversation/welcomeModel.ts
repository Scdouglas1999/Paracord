import { groupEnrollmentReason } from '../../../lib/messages/messagingReadiness';
import type { ConversationSubject } from './types';

/**
 * What an empty conversation says (docs/index-spec.md §4.13), decided from plain
 * facts so a unit test can hold every variant. Nothing here reads a store or the
 * clock: `Welcome.tsx` gathers the facts and draws the answer.
 *
 *   server   the server's first channel while no channel of it has a message:
 *            "Fuel is ready", "Three good ways to start it.", the cards that fit
 *   channel  any other empty channel: "general is ready", the topic (or "Nothing
 *            here yet."), the cards that fit
 *   joiner   the first visit to a server you did not make: "Welcome to Game
 *            Night", its description, Say hello / See who's here / Pick roles
 *   dm       a new one-to-one message: their face, their name, "You're friends"
 *            or "You share Game Night", Say hello
 *   group    a new group: "Group · 4 people", Say hello; or who it is waiting on
 *
 * Cards the person lacks permission for are left out (the row centers the rest).
 * Copy never says "room" and never says "This is the start of #x" (§1.5, §13.21).
 */

export type WelcomeVariant = 'server' | 'channel' | 'joiner' | 'dm' | 'group';
export type WelcomeAction = 'invite' | 'plan' | 'hello' | 'people' | 'roles';

export interface WelcomeFacts {
  subject: ConversationSubject;
  /** The server's name ("Fuel"); empty in a DM. */
  serverName?: string;
  /** The server's own words about itself (the joiner welcome's line). */
  description?: string | null;
  /** This is the server's first text channel, the one it opens on. */
  firstChannel: boolean;
  /** No channel of the server has a message yet. */
  serverEmpty: boolean;
  /** The first visit to a server you did not make (not yet welcomed). */
  joiner: boolean;
  canInvite: boolean;
  canPlan: boolean;
  canSend: boolean;
  /** The server's onboarding has roles to pick and you have not finished it. */
  hasRoles: boolean;
  /** A one-to-one message: what is known about the two of you. */
  relationship?: { friends: boolean; sharedServers: readonly string[] };
  /** A group whose members have not all set up encryption: who it waits on. */
  waitingOn?: readonly string[];
}

export interface WelcomeModel {
  variant: WelcomeVariant;
  title: string;
  line: string;
  actions: WelcomeAction[];
}

const COUNT_WORD = ['No', 'One', 'Two', 'Three'] as const;

/** "Three good ways to start it." / "One good way to start it." */
export function startLine(cards: number): string {
  if (cards <= 0) return 'Nothing here yet.';
  const word = COUNT_WORD[Math.min(cards, 3)];
  return `${word} good way${cards === 1 ? '' : 's'} to start it.`;
}

/** "Game Night", "Game Night and Basecamp", "3 servers" for who you share servers with. */
export function sharedLine(servers: readonly string[]): string | null {
  if (servers.length === 0) return null;
  if (servers.length === 1) return `You share ${servers[0]}`;
  if (servers.length === 2) return `You share ${servers[0]} and ${servers[1]}`;
  return `You share ${servers.length} servers`;
}

/** The joiner's cards: Say hello (when they may), See who's here, and Pick roles (when onboarding has roles). */
export function joinerActions(input: { canSend: boolean; hasRoles: boolean }): WelcomeAction[] {
  const actions: WelcomeAction[] = [];
  if (input.canSend) actions.push('hello');
  actions.push('people');
  if (input.hasRoles) actions.push('roles');
  return actions;
}

export function buildWelcome(facts: WelcomeFacts): WelcomeModel {
  const { subject } = facts;

  if (subject.kind === 'dm') {
    if (subject.isGroup) {
      const waiting = facts.waitingOn ?? [];
      if (waiting.length > 0) {
        // Naming who the group waits on is the only refusal a sender can act on.
        return {
          variant: 'group',
          title: 'Waiting on everyone’s encryption',
          line: groupEnrollmentReason(waiting),
          actions: [],
        };
      }
      const people = subject.participants;
      return {
        variant: 'group',
        title: subject.title,
        line: people && people > 1 ? `Group · ${people} people` : 'Group message',
        actions: facts.canSend ? ['hello'] : [],
      };
    }
    const relationship = facts.relationship;
    const line = relationship?.friends
      ? 'You’re friends'
      : sharedLine(relationship?.sharedServers ?? []) ?? 'Direct message';
    return { variant: 'dm', title: subject.title, line, actions: facts.canSend ? ['hello'] : [] };
  }

  const serverName = facts.serverName?.trim() || 'this server';

  if (facts.joiner) {
    return {
      variant: 'joiner',
      title: `Welcome to ${serverName}`,
      line: facts.description?.trim() || 'Say hi when you’re ready.',
      actions: joinerActions(facts),
    };
  }

  if (facts.firstChannel && facts.serverEmpty) {
    const actions: WelcomeAction[] = [];
    if (facts.canInvite) actions.push('invite');
    if (facts.canPlan) actions.push('plan');
    if (facts.canSend) actions.push('hello');
    return {
      variant: 'server',
      title: `${serverName} is ready`,
      line: startLine(actions.length),
      actions,
    };
  }

  const actions: WelcomeAction[] = [];
  if (facts.canSend) actions.push('hello');
  if (facts.canPlan) actions.push('plan');
  return {
    variant: 'channel',
    title: `${subject.channelName} is ready`,
    line: subject.topic?.trim() || 'Nothing here yet.',
    actions,
  };
}

/* ---- Say hello ---------------------------------------------------------------------- */

/** The greeting "Say hello" puts in the message box. It is filled and selected, never sent (§13.4). */
export function greetingFor(subject: ConversationSubject, facts: { serverName?: string; joiner?: boolean }): string {
  if (subject.kind === 'dm') {
    if (subject.isGroup) return 'Hello, everyone!';
    const first = subject.title.trim().split(/\s+/)[0];
    return first ? `Hey ${first}!` : 'Hello!';
  }
  if (facts.joiner) return 'Hi everyone, glad to be here!';
  const name = facts.serverName?.trim();
  return name ? `Hello! ${name} is open, come hang out.` : 'Hello, everyone!';
}

/* ---- Plan a night ------------------------------------------------------------------- */

export const DRAFT_EVENT_NAME = 'Game night';
const FRIDAY = 5;
const GAME_NIGHT_HOUR = 21;
const MIN_LEAD_MS = 36 * 60 * 60 * 1000;

/**
 * The draft's time: the next Friday at 9:00 PM local that is more than a day and
 * a half away, so there is time to give everyone their nudge ("Fri 9" on a
 * Thursday night is the Friday after tomorrow's, not tomorrow's).
 */
export function nextGameNight(now: Date): Date {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), GAME_NIGHT_HOUR, 0, 0, 0);
  start.setDate(start.getDate() + ((FRIDAY - start.getDay() + 7) % 7));
  while (start.getTime() - now.getTime() <= MIN_LEAD_MS) start.setDate(start.getDate() + 7);
  return start;
}
