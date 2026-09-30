import {
  createElement,
  type ReactNode,
  type MouseEvent as ReactMouseEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { parseCustomEmojiToken } from './customEmoji';
import { CustomEmojiImage } from '../components/ui/ResourceImage';
import { safeExternalUrl } from './security';
import CodeBlock from '../components/message/CodeBlock';
import { RoleMentionChip } from '../components/message/RoleMentionChip';
import { ChannelMentionChip, EventChip } from '../components/glass/cards/InlineChips';

interface Token {
  type:
    | 'text'
    | 'bold'
    | 'italic'
    | 'code'
    | 'codeblock'
    | 'strikethrough'
    | 'underline'
    | 'spoiler'
    | 'highlight'
    | 'link'
    | 'br'
    | 'customemoji'
    | 'mention'
    | 'rolemention'
    | 'channelmention'
    | 'eventmention';
  content: string;
  href?: string;
  emojiName?: string;
  emojiId?: string;
  language?: string;
  mentionUserId?: string;
  mentionRoleId?: string;
  mentionChannelId?: string;
  eventId?: string;
}

/** What the reader is, so what is addressed to them can be told from what is not. */
export interface MarkdownOptions {
  /** The reader's user id: their own `<@id>` mention is drawn as the white chip (docs/glass-spec.md §3.2). */
  selfUserId?: string | null;
}


const MARKDOWN_STYLE_ID = 'paracord-markdown-styles';
const MARKDOWN_STYLES = `
.spoiler {
  background-color: var(--spoiler-bg);
  color: transparent;
  border-radius: var(--radius-window);
  padding: 0 2px;
  cursor: pointer;
  transition: all 0.1s;
}
.spoiler.spoiler-revealed {
  background-color: var(--spoiler-bg-revealed);
  color: inherit;
}
.paracord-md-link {
  color: var(--text-link);
  text-decoration: none;
}
.paracord-md-link:hover {
  text-decoration: underline;
}
`;

/**
 * Idempotently inject the markdown stylesheet (spoiler + link classes) into the
 * document head. Safe to call repeatedly and in non-DOM environments.
 */
function ensureMarkdownStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(MARKDOWN_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = MARKDOWN_STYLE_ID;
  style.textContent = MARKDOWN_STYLES;
  document.head.appendChild(style);
}

/** Toggle a spoiler's revealed state, keeping its aria-expanded in sync. */
function toggleSpoiler(el: HTMLElement): void {
  const revealed = el.classList.toggle('spoiler-revealed');
  el.setAttribute('aria-expanded', revealed ? 'true' : 'false');
}

/**
 * True when a masked link's *label* reads as a web address for somewhere other
 * than where the link actually goes — `[https://your-bank.example](http://evil.example)`,
 * or the bare-hostname version of the same trick. Those are refused rather than
 * rendered, because a reader who checks the label has then checked nothing.
 * A label that is not address-shaped at all ("the docs") is not a claim about a
 * destination, so it masks freely.
 */
function labelClaimsAnotherDestination(label: string, safeHref: string): boolean {
  const claim = label.trim();
  const addressLike = /^(?:https?:\/\/)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:[/?#]\S*)?$/i;
  if (!addressLike.test(claim)) return false;
  try {
    const claimed = new URL(/^https?:\/\//i.test(claim) ? claim : `https://${claim}`);
    return claimed.hostname.toLowerCase() !== new URL(safeHref).hostname.toLowerCase();
  } catch {
    return true;
  }
}

function tokenizeInline(text: string): Token[] {
  const tokens: Token[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining[0] === '<') {
      const closingIndex = remaining.indexOf('>');
      if (closingIndex > 0) {
        const inner = remaining.slice(1, closingIndex);
        // Check for user mention: <@userid>
        const mentionMatch = inner.match(/^@!?(\d+)$/);
        if (mentionMatch) {
          const userId = mentionMatch[1];
          tokens.push({
            type: 'mention',
            content: remaining.slice(0, closingIndex + 1),
            mentionUserId: userId,
          });
          remaining = remaining.slice(closingIndex + 1);
          continue;
        }
        // `<#id>`: a channel. `<event:id>`: a scheduled event. Both are drawn as
        // chips in a sentence and resolved against the conversation's server.
        const channelMatch = inner.match(/^#(\d+)$/);
        if (channelMatch) {
          tokens.push({
            type: 'channelmention',
            content: remaining.slice(0, closingIndex + 1),
            mentionChannelId: channelMatch[1],
          });
          remaining = remaining.slice(closingIndex + 1);
          continue;
        }
        const eventMatch = inner.match(/^event:(\d+)$/);
        if (eventMatch) {
          tokens.push({
            type: 'eventmention',
            content: remaining.slice(0, closingIndex + 1),
            eventId: eventMatch[1],
          });
          remaining = remaining.slice(closingIndex + 1);
          continue;
        }
        const roleMatch = inner.match(/^@&(\d+)$/);
        if (roleMatch) {
          tokens.push({
            type: 'rolemention',
            content: remaining.slice(0, closingIndex + 1),
            mentionRoleId: roleMatch[1],
          });
          remaining = remaining.slice(closingIndex + 1);
          continue;
        }
        const maybeEmoji = remaining.slice(0, closingIndex + 1);
        const parsed = parseCustomEmojiToken(maybeEmoji);
        if (parsed) {
          tokens.push({
            type: 'customemoji',
            content: parsed.raw,
            emojiName: parsed.name,
            emojiId: parsed.id,
          });
          remaining = remaining.slice(parsed.raw.length);
          continue;
        }
      }
    }

    const codeBlockMatch = remaining.match(/^```([A-Za-z0-9_+-]*)\n([\s\S]*?)```/);
    if (codeBlockMatch) {
      tokens.push({
        type: 'codeblock',
        content: codeBlockMatch[2],
        language: codeBlockMatch[1] || undefined,
      });
      remaining = remaining.slice(codeBlockMatch[0].length);
      continue;
    }

    const codeMatch = remaining.match(/^`([^`\n]+)`/);
    if (codeMatch) {
      tokens.push({ type: 'code', content: codeMatch[1] });
      remaining = remaining.slice(codeMatch[0].length);
      continue;
    }

    const spoilerMatch = remaining.match(/^\|\|([^|]+)\|\|/);
    if (spoilerMatch) {
      tokens.push({ type: 'spoiler', content: spoilerMatch[1] });
      remaining = remaining.slice(spoilerMatch[0].length);
      continue;
    }

    const highlightMatch = remaining.match(/^==(.+?)==/);
    if (highlightMatch) {
      tokens.push({ type: 'highlight', content: highlightMatch[1] });
      remaining = remaining.slice(highlightMatch[0].length);
      continue;
    }

    const boldMatch = remaining.match(/^\*\*(.+?)\*\*/);
    if (boldMatch) {
      tokens.push({ type: 'bold', content: boldMatch[1] });
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    const underlineMatch = remaining.match(/^__(.+?)__/);
    if (underlineMatch) {
      tokens.push({ type: 'underline', content: underlineMatch[1] });
      remaining = remaining.slice(underlineMatch[0].length);
      continue;
    }

    const strikeMatch = remaining.match(/^~~(.+?)~~/);
    if (strikeMatch) {
      tokens.push({ type: 'strikethrough', content: strikeMatch[1] });
      remaining = remaining.slice(strikeMatch[0].length);
      continue;
    }

    const italicMatch = remaining.match(/^\*([^*]+)\*/) || remaining.match(/^_([^_]+)_/);
    if (italicMatch) {
      tokens.push({ type: 'italic', content: italicMatch[1] });
      remaining = remaining.slice(italicMatch[0].length);
      continue;
    }

    // `[label](https://…)` — what the composer's own Link button (Ctrl+K)
    // writes. The label is shown and the destination is carried in `title`, so
    // the real target is always one hover away; a label that is itself a URL
    // for somewhere else is refused below rather than allowed to lie.
    const maskedLinkMatch = remaining.match(/^\[([^\][\n]+)\]\((https?:\/\/[^\s<>()]+)\)/);
    if (maskedLinkMatch) {
      tokens.push({ type: 'link', content: maskedLinkMatch[1], href: maskedLinkMatch[2] });
      remaining = remaining.slice(maskedLinkMatch[0].length);
      continue;
    }

    const urlMatch = remaining.match(/^https?:\/\/[^\s<>[\]()]+/);
    if (urlMatch) {
      tokens.push({ type: 'link', content: urlMatch[0], href: urlMatch[0] });
      remaining = remaining.slice(urlMatch[0].length);
      continue;
    }

    if (remaining.startsWith('\n')) {
      tokens.push({ type: 'br', content: '' });
      remaining = remaining.slice(1);
      continue;
    }

    const nextSpecial = remaining.search(/[*_`~|=\n[]|https?:\/\/|</);
    if (nextSpecial === -1) {
      tokens.push({ type: 'text', content: remaining });
      remaining = '';
    } else if (nextSpecial === 0) {
      tokens.push({ type: 'text', content: remaining[0] });
      remaining = remaining.slice(1);
    } else {
      tokens.push({ type: 'text', content: remaining.slice(0, nextSpecial) });
      remaining = remaining.slice(nextSpecial);
    }
  }

  return tokens;
}


function renderInline(text: string, guildId?: string, mentionMap?: Map<string, string>, onMentionClick?: (userId: string) => void, selfUserId?: string | null): ReactNode[] {
  const tokens = tokenizeInline(text);
  return tokens.map((token, i) => {
    switch (token.type) {
      case 'bold':
        return createElement('strong', { key: i }, token.content);
      case 'italic':
        return createElement('em', { key: i }, token.content);
      case 'code':
        return createElement(
          'code',
          {
            key: i,
            style: {
              backgroundColor: 'var(--bg-code)',
              padding: '0.1em 0.3em',
              borderRadius: '3px',
              fontSize: '0.875em',
              fontFamily: 'monospace',
            },
          },
          token.content,
        );
      case 'codeblock':
        return createElement(CodeBlock, { key: i, code: token.content, language: token.language });
      case 'strikethrough':
        return createElement('s', { key: i }, token.content);
      case 'underline':
        return createElement('u', { key: i }, token.content);
      case 'spoiler':
        return createElement(
          'span',
          {
            key: i,
            className: 'spoiler',
            role: 'button',
            tabIndex: 0,
            'aria-expanded': false,
            'aria-label': 'Spoiler, activate to reveal',
            onClick: (e: ReactMouseEvent<HTMLElement>) => {
              toggleSpoiler(e.currentTarget);
            },
            onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggleSpoiler(e.currentTarget);
              }
            },
          },
          token.content,
        );
      case 'highlight':
        return createElement(
          'mark',
          {
            key: i,
            style: {
              // ==highlight== is a marker pen, and the warning token is the
              // only amber the palette has that is not a light (§1.3, §6.3).
              backgroundColor: 'var(--warning-tint)',
              color: 'inherit',
              borderRadius: 'var(--radius-window)',
              paddingInline: '2px',
            },
          },
          token.content,
        );
      case 'link': {
        const safeHref = token.href ? safeExternalUrl(token.href) : null;
        if (!safeHref) {
          return token.content;
        }
        const masked = token.content !== token.href;
        if (masked && labelClaimsAnotherDestination(token.content, safeHref)) {
          // The label names a host it does not lead to. Show the markup as
          // typed rather than render a link that lies about where it goes.
          return `[${token.content}](${token.href})`;
        }
        return createElement(
          'a',
          {
            key: i,
            href: safeHref,
            target: '_blank',
            rel: 'noopener noreferrer',
            className: 'paracord-md-link',
            // A masked label hides the destination; keep it one hover away.
            ...(masked ? { title: safeHref } : null),
          },
          token.content,
        );
      }
      case 'customemoji':
        if (!guildId || !token.emojiId || !token.emojiName) {
          return token.content;
        }
        // Not a bare `<img>`: on the desktop shell the webview cannot fetch an
        // authenticated emoji itself, so the component resolves it over the
        // native bridge and renders the resulting `blob:`.
        return createElement(CustomEmojiImage, {
          key: i,
          guildId,
          emojiId: token.emojiId,
          alt: token.emojiName,
          title: `:${token.emojiName}:`,
          loading: 'lazy',
          style: {
            width: '1.2em',
            height: '1.2em',
            objectFit: 'contain',
            display: 'inline-block',
            verticalAlign: 'text-bottom',
            marginInline: '0.05em',
          },
        });
      case 'rolemention':
        return createElement(RoleMentionChip, {
          key: i,
          guildId,
          roleId: token.mentionRoleId ?? '',
        });
      case 'channelmention':
        // A channel means nothing without the server it is in.
        if (!guildId || !token.mentionChannelId) return token.content;
        return createElement(ChannelMentionChip, { key: i, channelId: token.mentionChannelId });
      case 'eventmention':
        if (!guildId || !token.eventId) return token.content;
        return createElement(EventChip, { key: i, guildId, eventId: token.eventId });
      case 'mention': {
        const userId = token.mentionUserId ?? '';
        const displayName = mentionMap?.get(userId) ?? `<@${userId}>`;
        // A mention is a chip (glass-cards.css). It names who it is for in
        // `data-user-id`; the reader's own is the white chip (glass-timeline.css).
        return createElement(
          'span',
          {
            key: i,
            className: selfUserId && userId === selfUserId ? 'glass-mention glass-mention-self' : 'glass-mention',
            'data-user-id': userId,
            'data-clickable': onMentionClick ? '' : undefined,
            onClick: onMentionClick ? () => onMentionClick(userId) : undefined,
          },
          `@${displayName}`,
        );
      }
      case 'br':
        return createElement('br', { key: i });
      case 'text':
      default:
        return token.content;
    }
  });
}

function isCodeFenceStart(line: string): boolean {
  return /^```[A-Za-z0-9_+-]*\s*$/.test(line);
}

function isHeading(line: string): boolean {
  return /^#{1,3}\s+/.test(line);
}

function isQuote(line: string): boolean {
  return /^>\s?/.test(line);
}

function isUnorderedList(line: string): boolean {
  return /^\s*[-*]\s+/.test(line);
}

function isOrderedList(line: string): boolean {
  return /^\s*\d+\.\s+/.test(line);
}

export function parseMarkdown(
  text: string,
  guildId?: string,
  mentionMap?: Map<string, string>,
  onMentionClick?: (userId: string) => void,
  options?: MarkdownOptions,
): ReactNode[] {
  if (!text) return [];
  const selfUserId = options?.selfUserId ?? null;

  ensureMarkdownStyles();

  const lines = text.split('\n');
  const nodes: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      nodes.push(createElement('br', { key: `blank-${index}` }));
      index += 1;
      continue;
    }

    const codeStart = line.match(/^```([A-Za-z0-9_+-]*)\s*$/);
    if (codeStart) {
      const language = codeStart[1] || undefined;
      index += 1;
      const codeLines: string[] = [];
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const content = codeLines.join('\n');
      nodes.push(
        createElement(CodeBlock, { key: 'code-' + index, code: content, language: language }),
      );
      continue;
    }

    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const headingText = headingMatch[2];
      const tag = (`h${level}` as 'h1' | 'h2' | 'h3');
      nodes.push(
        createElement(
          tag,
          {
            key: `heading-${index}`,
            style: {
              margin: '6px 0 4px',
              fontWeight: 700,
              fontSize: level === 1 ? '1.05rem' : level === 2 ? '0.98rem' : '0.92rem',
              lineHeight: '1.3',
            },
          },
          renderInline(headingText, guildId, mentionMap, onMentionClick, selfUserId),
        ),
      );
      index += 1;
      continue;
    }

    if (isQuote(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && isQuote(lines[index])) {
        quoteLines.push(lines[index].replace(/^>\s?/, ''));
        index += 1;
      }
      const quoteNodes: ReactNode[] = [];
      quoteLines.forEach((quoteLine, quoteIndex) => {
        if (quoteIndex > 0) quoteNodes.push(createElement('br', { key: `quote-br-${quoteIndex}` }));
        quoteNodes.push(...renderInline(quoteLine, guildId, mentionMap, onMentionClick, selfUserId));
      });
      nodes.push(
        createElement(
          'blockquote',
          {
            key: `quote-${index}`,
            style: {
              margin: '6px 0',
              padding: '4px 0 4px 10px',
              borderLeft: '3px solid var(--border-subtle)',
              color: 'var(--text-secondary)',
            },
          },
          quoteNodes,
        ),
      );
      continue;
    }

    if (isUnorderedList(line)) {
      const items: string[] = [];
      while (index < lines.length && isUnorderedList(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*]\s+/, ''));
        index += 1;
      }
      nodes.push(
        createElement(
          'ul',
          {
            key: `ul-${index}`,
            style: {
              margin: '6px 0',
              paddingInlineStart: '1.25rem',
              listStyle: 'disc',
            },
          },
          items.map((item, itemIndex) =>
            createElement(
              'li',
              { key: `li-${itemIndex}`, style: { marginBottom: '2px' } },
              renderInline(item, guildId, mentionMap, onMentionClick, selfUserId),
            ),
          ),
        ),
      );
      continue;
    }

    if (isOrderedList(line)) {
      const items: string[] = [];
      while (index < lines.length && isOrderedList(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+\.\s+/, ''));
        index += 1;
      }
      nodes.push(
        createElement(
          'ol',
          {
            key: `ol-${index}`,
            style: {
              margin: '6px 0',
              paddingInlineStart: '1.25rem',
              listStyle: 'decimal',
            },
          },
          items.map((item, itemIndex) =>
            createElement(
              'li',
              { key: `oli-${itemIndex}`, style: { marginBottom: '2px' } },
              renderInline(item, guildId, mentionMap, onMentionClick, selfUserId),
            ),
          ),
        ),
      );
      continue;
    }

    const paragraphLines: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !isCodeFenceStart(lines[index]) &&
      !isHeading(lines[index]) &&
      !isQuote(lines[index]) &&
      !isUnorderedList(lines[index]) &&
      !isOrderedList(lines[index])
    ) {
      paragraphLines.push(lines[index]);
      index += 1;
    }

    const paragraphNodes: ReactNode[] = [];
    paragraphLines.forEach((paragraphLine, paragraphIndex) => {
      if (paragraphIndex > 0) paragraphNodes.push(createElement('br', { key: `paragraph-br-${paragraphIndex}` }));
      paragraphNodes.push(...renderInline(paragraphLine, guildId, mentionMap, onMentionClick, selfUserId));
    });
    nodes.push(
      createElement(
        'span',
        {
          key: `paragraph-${index}`,
          style: { display: 'inline' },
        },
        paragraphNodes,
      ),
    );
  }

  return nodes;
}

export function stripMarkdown(text: string): string {
  return text
    .replace(/<a?:([A-Za-z0-9_]{1,32}):([0-9]+)>/g, ':$1:')
    .replace(/\[([^\][\n]+)\]\((https?:\/\/[^\s<>()]+)\)/g, '$1')
    .replace(/```[\s\S]*?```/g, (match) => match.replace(/```\w*\n?/, '').replace(/```$/, ''))
    .replace(/`([^`]+)`/g, '$1')
    .replace(/==(.+?)==/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/\|\|(.+?)\|\|/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/_([^_\n]+)_/g, '$1')
    .replace(/^>\s?/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/^#{1,3}\s+/gm, '');
}

/**
 * One line of plain words standing in for a message: a reply chip, a channel's
 * "last said" line, a notification.
 *
 * A preview is read, not rendered, so the markup has to go rather than show. A
 * message that opens with a code block used to preview as "```ini retra…", and
 * one that opens with a mention as "<@3604144…" — the person's id instead of
 * their name. `names` is the same id-to-name map the timeline renders mentions
 * with; somebody it does not know is "@someone", never a number.
 */
export function messagePreviewText(
  content: string,
  names?: ReadonlyMap<string, string>,
  roleNames?: ReadonlyMap<string, string>,
): string {
  return stripMarkdown(
    content
      // A fenced block previews as its code, without the fence or the language tag.
      .replace(/```[^\n`]*\n?([\s\S]*?)```/g, (_match, code: string) => ` ${code} `)
      // An unclosed fence (a preview is often a truncated message) loses the fence too.
      .replace(/```[^\s`]*/g, ' '),
  )
    .replace(/<@!?(\d+)>/g, (_match, id: string) => `@${names?.get(id) ?? 'someone'}`)
    .replace(/<@&(\d+)>/g, (_match, id: string) => `@${roleNames?.get(id) ?? 'role'}`)
    .replace(/<#\d+>/g, '#channel')
    .replace(/<event:\d+>/g, 'an event')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A search result's snippet: the message as plain text, markup gone.
 *
 * Like {@link messagePreviewText}, but a result keeps its line breaks (the
 * panel clamps it rather than wrapping it into one line) and a spoiler is
 * never unwrapped — the word "spoiler" stands in for its content so a query
 * cannot leak what was hidden. Mentions resolve through the same maps the
 * preview uses; a channel mention resolves to its name when the caller has
 * the channel catalog, "#channel" when it does not; an event token (`<event:id>`)
 * reads as the event's name when the caller knows it and "an event" when not.
 */
export function messageSnippetText(
  content: string,
  names?: ReadonlyMap<string, string>,
  roleNames?: ReadonlyMap<string, string>,
  channelNames?: ReadonlyMap<string, string>,
  eventNames?: ReadonlyMap<string, string>,
): string {
  return stripMarkdown(
    content
      // Spoilers first, before `stripMarkdown` would unwrap them to the text
      // they exist to hide.
      .replace(/\|\|[^|]+\|\|/g, ' spoiler ')
      .replace(/```[^\n`]*\n?([\s\S]*?)```/g, (_match, code: string) => ` ${code} `)
      .replace(/```[^\s`]*/g, ' '),
  )
    .replace(/<@!?(\d+)>/g, (_match, id: string) => `@${names?.get(id) ?? 'someone'}`)
    .replace(/<@&(\d+)>/g, (_match, id: string) => `@${roleNames?.get(id) ?? 'role'}`)
    .replace(/<#(\d+)>/g, (_match, id: string) => `#${channelNames?.get(id) ?? 'channel'}`)
    .replace(/<event:(\d+)>/g, (_match, id: string) => eventNames?.get(id) || 'an event')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[ \t]+|[ \t]+$/gm, '')
    .trim();
}

