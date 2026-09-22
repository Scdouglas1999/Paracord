/**
 * Typed message-search grammar.
 *
 * A draft is free text plus filter tokens (`from:`, `in:`, `has:`, `mentions:`,
 * `before:`, `after:`, `during:`, `is:`). Complete tokens become chips. The
 * trailing token, while it is still being typed, stays in the field and drives
 * the suggestion menu.
 */

export const HAS_FILTERS = ['link', 'image', 'video', 'file', 'poll', 'embed'] as const;
export type HasFilter = (typeof HAS_FILTERS)[number];

export type FilterKey = 'from' | 'in' | 'has' | 'mentions' | 'before' | 'after' | 'during' | 'is';

export const FILTER_KEYS: readonly FilterKey[] = [
  'from',
  'in',
  'has',
  'mentions',
  'before',
  'after',
  'during',
  'is',
];

export type SearchChip =
  | { kind: 'from'; userId: string; label: string }
  | { kind: 'in'; channelId: string; label: string }
  | { kind: 'has'; value: HasFilter }
  | { kind: 'mentions'; userId: string; label: string }
  | { kind: 'before'; day: string }
  | { kind: 'after'; day: string }
  | { kind: 'during'; day: string }
  | { kind: 'pinned' };

export interface CatalogMember {
  id: string;
  label: string;
  names: string[];
  avatar?: string | null;
}

export interface CatalogChannel {
  id: string;
  name: string;
}

export interface ActiveFilter {
  key: FilterKey;
  raw: string;
}

export interface SearchSuggestion {
  id: string;
  label: string;
  hint?: string;
  chip: SearchChip;
}

export interface InterpretedDraft {
  /** Filter tokens that are finished and should leave the field. */
  chips: SearchChip[];
  /** What remains in the field: free text plus a filter still being typed. */
  remainder: string;
  active: ActiveFilter | null;
  error: string | null;
}

export interface GuildSearchParams {
  q?: string;
  author_id?: string;
  channel_id?: string;
  has?: HasFilter[];
  mentions?: string;
  pinned?: boolean;
  /** RFC 3339 instant. */
  before?: string;
  /** RFC 3339 instant. */
  after?: string;
}

const DATE_KEYS = new Set<FilterKey>(['before', 'after', 'during']);

export function chipLabel(chip: SearchChip): string {
  switch (chip.kind) {
    case 'from':
      return `from:${chip.label}`;
    case 'in':
      return `in:#${chip.label.replace(/^#/, '')}`;
    case 'has':
      return `has:${chip.value}`;
    case 'mentions':
      return `mentions:${chip.label}`;
    case 'before':
      return `before:${chip.day}`;
    case 'after':
      return `after:${chip.day}`;
    case 'during':
      return `during:${chip.day}`;
    case 'pinned':
      return 'is:pinned';
  }
}

/** Calendar day `YYYY-MM-DD` in the local timezone of `date`. */
export function formatLocalDay(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  next.setDate(next.getDate() + days);
  return next;
}

/**
 * Accepts `YYYY-MM-DD`, `yesterday`, and `last week`.
 * Returns the calendar day, or null when the text is not one of those.
 */
export function parseSearchDay(raw: string, now: Date): string | null {
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  if (value === 'yesterday') return formatLocalDay(addDays(now, -1));
  if (value === 'last week') return formatLocalDay(addDays(now, -7));
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(year, month - 1, day);
  if (
    parsed.getFullYear() !== year
    || parsed.getMonth() !== month - 1
    || parsed.getDate() !== day
  ) {
    return null;
  }
  return formatLocalDay(parsed);
}

function isFilterKey(value: string): value is FilterKey {
  return (FILTER_KEYS as readonly string[]).includes(value);
}

interface RawToken {
  key: FilterKey;
  raw: string;
  start: number;
  end: number;
  /** A space (or the end of a self-complete value) finished this token. */
  closed: boolean;
}

function isBoundary(draft: string, index: number): boolean {
  return index === 0 || /\s/.test(draft[index - 1] ?? '');
}

function scanTokens(draft: string): RawToken[] {
  const tokens: RawToken[] = [];
  for (let index = 0; index < draft.length; index += 1) {
    if (!isBoundary(draft, index)) continue;
    const colon = draft.indexOf(':', index);
    if (colon <= index) continue;
    const keyText = draft.slice(index, colon).toLowerCase();
    if (!isFilterKey(keyText)) continue;
    const valueStart = colon + 1;
    let valueEnd = valueStart;
    const rest = draft.slice(valueStart).toLowerCase();
    if (DATE_KEYS.has(keyText) && rest.startsWith('last week')) {
      valueEnd = valueStart + 'last week'.length;
    } else if (DATE_KEYS.has(keyText) && rest.startsWith('last ') && 'last week'.startsWith(rest)) {
      // `last w…` is still being typed: keep the whole tail as the value so
      // the space after `last` does not finish the token early.
      valueEnd = draft.length;
    } else {
      while (valueEnd < draft.length && !/\s/.test(draft[valueEnd] ?? '')) valueEnd += 1;
    }
    const raw = draft.slice(valueStart, valueEnd);
    const hasCloser = valueEnd < draft.length && /\s/.test(draft[valueEnd] ?? '');
    const selfComplete = isSelfComplete(keyText, raw);
    tokens.push({
      key: keyText,
      raw,
      start: index,
      end: hasCloser ? valueEnd + 1 : valueEnd,
      closed: hasCloser || selfComplete,
    });
    index = (hasCloser ? valueEnd : valueEnd) - 1;
  }
  return tokens;
}

function isSelfComplete(key: FilterKey, raw: string): boolean {
  if (!raw) return false;
  if (key === 'has') return (HAS_FILTERS as readonly string[]).includes(raw.toLowerCase());
  if (key === 'is') return raw.toLowerCase() === 'pinned';
  if (DATE_KEYS.has(key)) return parseSearchDay(raw, new Date()) !== null;
  return false;
}

function memberScore(member: CatalogMember, raw: string): 'exact' | 'prefix' | 'none' {
  const query = raw.trim().toLowerCase();
  if (!query) return 'none';
  const names = member.names.map((name) => name.trim().toLowerCase()).filter(Boolean);
  if (names.some((name) => name === query)) return 'exact';
  if (names.some((name) => name.startsWith(query))) return 'prefix';
  return 'none';
}

function channelQuery(raw: string): string {
  return raw.trim().replace(/^#/, '').toLowerCase();
}

function channelScore(channel: CatalogChannel, raw: string): 'exact' | 'prefix' | 'none' {
  const query = channelQuery(raw);
  if (!query) return 'none';
  const name = channel.name.trim().toLowerCase().replace(/^#/, '');
  if (name === query) return 'exact';
  if (name.startsWith(query)) return 'prefix';
  return 'none';
}

function resolveMember(raw: string, members: readonly CatalogMember[], closed: boolean): CatalogMember | 'active' | 'error' {
  const exact = members.filter((member) => memberScore(member, raw) === 'exact');
  const exactIds = new Set(exact.map((member) => member.id));
  const others = members.filter((member) => memberScore(member, raw) === 'prefix' && !exactIds.has(member.id));
  if (exact.length === 1 && (closed || others.length === 0)) return exact[0]!;
  if (!closed) return 'active';
  return 'error';
}

function resolveChannel(raw: string, channels: readonly CatalogChannel[], closed: boolean): CatalogChannel | 'active' | 'error' {
  const exact = channels.filter((channel) => channelScore(channel, raw) === 'exact');
  const exactIds = new Set(exact.map((channel) => channel.id));
  const others = channels.filter((channel) => channelScore(channel, raw) === 'prefix' && !exactIds.has(channel.id));
  if (exact.length === 1 && (closed || others.length === 0)) return exact[0]!;
  if (!closed) return 'active';
  return 'error';
}

function tokenError(key: FilterKey, raw: string): string {
  if (key === 'from' || key === 'mentions') {
    return raw.trim()
      ? `No member matches “${raw.trim()}”.`
      : `Choose a member for ${key}:.`;
  }
  if (key === 'in') {
    return raw.trim()
      ? `No channel matches “${raw.trim()}”.`
      : 'Choose a channel for in:.';
  }
  if (key === 'has') {
    return 'has: is link, image, video, file, poll, or embed.';
  }
  if (key === 'is') return 'is: only accepts pinned.';
  return 'Use a date like 2026-09-01, yesterday, or last week.';
}

function chipFromToken(
  token: RawToken,
  members: readonly CatalogMember[],
  channels: readonly CatalogChannel[],
  now: Date,
): SearchChip | 'active' | 'error' {
  if (token.key === 'has') {
    const value = token.raw.toLowerCase();
    if ((HAS_FILTERS as readonly string[]).includes(value)) {
      return { kind: 'has', value: value as HasFilter };
    }
    return token.closed ? 'error' : 'active';
  }
  if (token.key === 'is') {
    if (token.raw.toLowerCase() === 'pinned') return { kind: 'pinned' };
    return token.closed ? 'error' : 'active';
  }
  if (DATE_KEYS.has(token.key)) {
    const day = parseSearchDay(token.raw, now);
    if (day) {
      if (token.key === 'before') return { kind: 'before', day };
      if (token.key === 'after') return { kind: 'after', day };
      return { kind: 'during', day };
    }
    return token.closed ? 'error' : 'active';
  }
  if (token.key === 'from' || token.key === 'mentions') {
    const member = resolveMember(token.raw, members, token.closed);
    if (member === 'active' || member === 'error') return member;
    return token.key === 'from'
      ? { kind: 'from', userId: member.id, label: member.label }
      : { kind: 'mentions', userId: member.id, label: member.label };
  }
  const channel = resolveChannel(token.raw, channels, token.closed);
  if (channel === 'active' || channel === 'error') return channel;
  return { kind: 'in', channelId: channel.id, label: channel.name.replace(/^#/, '') };
}

export function interpretSearchDraft(
  draft: string,
  members: readonly CatalogMember[],
  channels: readonly CatalogChannel[],
  now: Date,
): InterpretedDraft {
  const tokens = scanTokens(draft);
  const chips: SearchChip[] = [];
  let error: string | null = null;
  let active: ActiveFilter | null = null;
  const removed: Array<{ start: number; end: number }> = [];

  tokens.forEach((token, index) => {
    const isLast = index === tokens.length - 1;
    const resolved = chipFromToken(token, members, channels, now);
    if (resolved === 'active') {
      if (isLast) active = { key: token.key, raw: token.raw };
      else if (token.closed) error = error ?? tokenError(token.key, token.raw);
      return;
    }
    if (resolved === 'error') {
      error = error ?? tokenError(token.key, token.raw);
      return;
    }
    chips.push(resolved);
    removed.push({ start: token.start, end: token.end });
  });

  return {
    chips,
    remainder: draftWithout(draft, removed).replace(/\s+/g, ' ').trim(),
    active,
    error,
  };
}

function draftWithout(draft: string, spans: Array<{ start: number; end: number }>): string {
  const ordered = [...spans].sort((a, b) => a.start - b.start);
  let text = '';
  let cursor = 0;
  for (const span of ordered) {
    text += draft.slice(cursor, span.start);
    cursor = span.end;
  }
  text += draft.slice(cursor);
  return text;
}

export function applyChip(chips: readonly SearchChip[], chip: SearchChip): SearchChip[] {
  const without = (kind: SearchChip['kind']) => chips.filter((existing) => existing.kind !== kind);
  switch (chip.kind) {
    case 'has':
      if (chips.some((existing) => existing.kind === 'has' && existing.value === chip.value)) {
        return [...chips];
      }
      return [...chips, chip];
    case 'from':
    case 'in':
    case 'mentions':
    case 'pinned':
      return [...without(chip.kind), chip];
    case 'before':
    case 'after':
      return [...chips.filter((existing) => existing.kind !== chip.kind && existing.kind !== 'during'), chip];
    case 'during':
      return [...chips.filter((existing) => existing.kind !== 'before' && existing.kind !== 'after' && existing.kind !== 'during'), chip];
  }
}

export function draftWithoutActive(draft: string, active: ActiveFilter | null): string {
  if (!active) return draft.replace(/\s+/g, ' ').trim();
  const token = `${active.key}:${active.raw}`;
  const index = draft.toLowerCase().lastIndexOf(token.toLowerCase());
  if (index < 0) return draft.replace(/\s+/g, ' ').trim();
  return `${draft.slice(0, index)}${draft.slice(index + token.length)}`.replace(/\s+/g, ' ').trim();
}

export function suggestionsFor(
  active: ActiveFilter,
  members: readonly CatalogMember[],
  channels: readonly CatalogChannel[],
  now: Date,
): SearchSuggestion[] {
  const raw = active.raw.trim().toLowerCase();
  if (active.key === 'has') {
    return HAS_FILTERS
      .filter((value) => !raw || value.startsWith(raw))
      .map((value) => ({
        id: `has:${value}`,
        label: value,
        chip: { kind: 'has', value },
      }));
  }
  if (active.key === 'is') {
    if (raw && !'pinned'.startsWith(raw)) return [];
    return [{ id: 'is:pinned', label: 'pinned', chip: { kind: 'pinned' } }];
  }
  if (DATE_KEYS.has(active.key)) {
    const options = [
      { label: 'yesterday', day: parseSearchDay('yesterday', now)! },
      { label: 'last week', day: parseSearchDay('last week', now)! },
    ];
    return options
      .filter((option) => !raw || option.label.startsWith(raw) || option.day.startsWith(raw))
      .map((option) => ({
        id: `${active.key}:${option.label}`,
        label: option.label,
        hint: option.day,
        chip: active.key === 'before'
          ? { kind: 'before', day: option.day }
          : active.key === 'after'
            ? { kind: 'after', day: option.day }
            : { kind: 'during', day: option.day },
      }));
  }
  if (active.key === 'in') {
    return channels
      .filter((channel) => channelScore(channel, active.raw) !== 'none' || !raw)
      .slice(0, 12)
      .map((channel) => ({
        id: `in:${channel.id}`,
        label: `#${channel.name.replace(/^#/, '')}`,
        chip: { kind: 'in', channelId: channel.id, label: channel.name.replace(/^#/, '') },
      }));
  }
  return members
    .filter((member) => memberScore(member, active.raw) !== 'none' || !raw)
    .slice(0, 12)
    .map((member) => ({
      id: `${active.key}:${member.id}`,
      label: member.label,
      chip: active.key === 'mentions'
        ? { kind: 'mentions', userId: member.id, label: member.label }
        : { kind: 'from', userId: member.id, label: member.label },
    }));
}

export function toGuildSearchParams(chips: readonly SearchChip[], text: string): GuildSearchParams {
  const params: GuildSearchParams = {};
  const trimmed = text.trim();
  if (trimmed) params.q = trimmed;
  const has: HasFilter[] = [];
  for (const chip of chips) {
    switch (chip.kind) {
      case 'from':
        params.author_id = chip.userId;
        break;
      case 'in':
        params.channel_id = chip.channelId;
        break;
      case 'has':
        if (!has.includes(chip.value)) has.push(chip.value);
        break;
      case 'mentions':
        params.mentions = chip.userId;
        break;
      case 'pinned':
        params.pinned = true;
        break;
      // Days are the searcher's calendar days, sent as instants so the
      // server does not read them as UTC days. `before:` and `after:` leave
      // the named day out; `during:` is that day only.
      case 'before': {
        const bounds = dayBounds(chip.day);
        if (bounds) params.before = new Date(bounds.start - 1).toISOString();
        break;
      }
      case 'after': {
        const bounds = dayBounds(chip.day);
        if (bounds) params.after = new Date(bounds.end + 1).toISOString();
        break;
      }
      case 'during': {
        const bounds = dayBounds(chip.day);
        if (bounds) {
          params.after = new Date(bounds.start).toISOString();
          params.before = new Date(bounds.end).toISOString();
        }
        break;
      }
    }
  }
  if (has.length) params.has = has;
  return params;
}

export interface SearchableMessage {
  id: string;
  content: string | null;
  created_at?: string;
  timestamp?: string;
  pinned?: boolean;
  author?: { id?: string | null } | null;
  attachments?: Array<{ content_type?: string | null }> | null;
  embeds?: unknown[] | null;
  poll?: unknown | null;
}

function messageTime(message: SearchableMessage): number {
  const raw = message.created_at || message.timestamp || '';
  const time = new Date(raw).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function dayBounds(day: string): { start: number; end: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return null;
  const start = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0, 0);
  const end = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59, 999);
  return { start: start.getTime(), end: end.getTime() };
}

function messageHas(message: SearchableMessage, value: HasFilter): boolean {
  const content = message.content ?? '';
  const attachments = message.attachments ?? [];
  const typeOf = (attachment: { content_type?: string | null }) =>
    (attachment.content_type ?? '').toLowerCase();
  switch (value) {
    case 'link':
      return /https?:\/\//i.test(content);
    case 'image':
      return attachments.some((attachment) => typeOf(attachment).startsWith('image/'));
    case 'video':
      return attachments.some((attachment) => typeOf(attachment).startsWith('video/'));
    case 'file':
      return attachments.some((attachment) => {
        const type = typeOf(attachment);
        return !type.startsWith('image/') && !type.startsWith('video/');
      });
    case 'poll':
      return message.poll != null;
    case 'embed':
      return (message.embeds?.length ?? 0) > 0;
  }
}

/**
 * Search messages already loaded in this session. Used for direct messages,
 * which the server cannot read.
 */
export function searchLoadedMessages<T extends SearchableMessage>(
  messages: readonly T[],
  chips: readonly SearchChip[],
  text: string,
): T[] {
  const terms = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matched = messages.filter((message) => {
    const content = (message.content ?? '').toLowerCase();
    if (terms.some((term) => !content.includes(term))) return false;
    const time = messageTime(message);
    for (const chip of chips) {
      switch (chip.kind) {
        case 'from':
          if (message.author?.id !== chip.userId) return false;
          break;
        case 'mentions': {
          const body = message.content ?? '';
          const id = chip.userId;
          if (!body.includes(`<@${id}>`) && !body.includes(`<@!${id}>`)) return false;
          break;
        }
        case 'in':
          break;
        case 'has':
          if (!messageHas(message, chip.value)) return false;
          break;
        case 'pinned':
          if (!message.pinned) return false;
          break;
        case 'before':
        case 'after':
        case 'during': {
          const bounds = dayBounds(chip.day);
          if (!bounds) return false;
          if (chip.kind === 'before' && time >= bounds.start) return false;
          if (chip.kind === 'after' && time <= bounds.end) return false;
          if (chip.kind === 'during' && (time < bounds.start || time > bounds.end)) return false;
          break;
        }
      }
    }
    return true;
  });
  return [...matched].sort((a, b) => messageTime(b) - messageTime(a) || b.id.localeCompare(a.id));
}
