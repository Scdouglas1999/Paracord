import { createElement, type ReactNode } from 'react';
import { buildGuildEmojiImageUrl, parseCustomEmojiToken } from './customEmoji';
import CodeBlock from '../components/message/CodeBlock';

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
    | 'customemoji';
  content: string;
  href?: string;
  emojiName?: string;
  emojiId?: string;
  language?: string;
}


function tokenizeInline(text: string): Token[] {
  const tokens: Token[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining[0] === '<') {
      const closingIndex = remaining.indexOf('>');
      if (closingIndex > 0) {
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

    const nextSpecial = remaining.search(/[*_`~|=\n]|https?:\/\/|</);
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


function renderInline(text: string, guildId?: string): ReactNode[] {
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
            style: {
              backgroundColor: 'var(--spoiler-bg, #202225)',
              color: 'transparent',
              borderRadius: '3px',
              padding: '0 2px',
              cursor: 'pointer',
              transition: 'all 0.1s',
            },
            onClick: (e: MouseEvent) => {
              const el = e.currentTarget as HTMLElement;
              el.style.backgroundColor = 'var(--spoiler-bg-revealed, rgba(255,255,255,0.1))';
              el.style.color = 'inherit';
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
              backgroundColor: 'rgba(255, 214, 10, 0.22)',
              color: 'inherit',
              borderRadius: '2px',
              paddingInline: '2px',
            },
          },
          token.content,
        );
      case 'link':
        return createElement(
          'a',
          {
            key: i,
            href: token.href,
            target: '_blank',
            rel: 'noopener noreferrer',
            style: { color: 'var(--text-link, #00aff4)', textDecoration: 'none' },
            onMouseEnter: (e: MouseEvent) => {
              (e.currentTarget as HTMLElement).style.textDecoration = 'underline';
            },
            onMouseLeave: (e: MouseEvent) => {
              (e.currentTarget as HTMLElement).style.textDecoration = 'none';
            },
          },
          token.content,
        );
      case 'customemoji':
        if (!guildId || !token.emojiId || !token.emojiName) {
          return token.content;
        }
        return createElement('img', {
          key: i,
          src: buildGuildEmojiImageUrl(guildId, token.emojiId),
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

export function parseMarkdown(text: string, guildId?: string): ReactNode[] {
  if (!text) return [];

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
          renderInline(headingText, guildId),
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
        quoteNodes.push(...renderInline(quoteLine, guildId));
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
              renderInline(item, guildId),
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
              renderInline(item, guildId),
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
      paragraphNodes.push(...renderInline(paragraphLine, guildId));
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
    .replace(/```[\s\S]*?```/g, (match) => match.replace(/```\w*\n?/, '').replace(/```$/, ''))
    .replace(/`([^`]+)`/g, '$1')
    .replace(/==(.+?)==/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/\|\|(.+?)\|\|/g, '$1')
    .replace(/\*([^\*\n]+)\*/g, '$1')
    .replace(/_([^_\n]+)_/g, '$1')
    .replace(/^>\s?/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/^#{1,3}\s+/gm, '');
}
