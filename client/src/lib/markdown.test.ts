import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { createElement } from 'react';
import { parseMarkdown, stripMarkdown } from './markdown';

describe('stripMarkdown', () => {
  it('strips bold markers', () => {
    expect(stripMarkdown('this is **bold** text')).toBe('this is bold text');
  });

  it('strips italic markers (asterisk)', () => {
    expect(stripMarkdown('this is *italic* text')).toBe('this is italic text');
  });

  it('strips italic markers (underscore)', () => {
    expect(stripMarkdown('this is _italic_ text')).toBe('this is italic text');
  });

  it('strips underline markers', () => {
    expect(stripMarkdown('this is __underlined__ text')).toBe('this is underlined text');
  });

  it('strips strikethrough markers', () => {
    expect(stripMarkdown('this is ~~struck~~ text')).toBe('this is struck text');
  });

  it('strips spoiler markers', () => {
    expect(stripMarkdown('this is ||spoiler|| text')).toBe('this is spoiler text');
  });

  it('strips inline code backticks', () => {
    expect(stripMarkdown('use `console.log`')).toBe('use console.log');
  });

  it('strips code blocks', () => {
    expect(stripMarkdown('```js\nconsole.log("hi")\n```')).toBe('console.log("hi")\n');
  });

  it('strips highlight markers', () => {
    expect(stripMarkdown('this is ==highlighted== text')).toBe('this is highlighted text');
  });

  it('strips blockquote markers', () => {
    expect(stripMarkdown('> quoted text')).toBe('quoted text');
  });

  it('strips heading markers', () => {
    expect(stripMarkdown('# Heading 1')).toBe('Heading 1');
    expect(stripMarkdown('## Heading 2')).toBe('Heading 2');
    expect(stripMarkdown('### Heading 3')).toBe('Heading 3');
  });

  it('strips unordered list markers', () => {
    expect(stripMarkdown('- item one\n- item two')).toBe('item one\nitem two');
    expect(stripMarkdown('* item one\n* item two')).toBe('item one\nitem two');
  });

  it('strips ordered list markers', () => {
    expect(stripMarkdown('1. first\n2. second')).toBe('first\nsecond');
  });

  it('converts custom emoji to short name', () => {
    expect(stripMarkdown('<:smile:123456>')).toBe(':smile:');
    expect(stripMarkdown('<a:animated:789>')).toBe(':animated:');
  });

  it('handles plain text without changes', () => {
    expect(stripMarkdown('Hello world')).toBe('Hello world');
  });

  it('handles empty string', () => {
    expect(stripMarkdown('')).toBe('');
  });

  it('handles mixed formatting', () => {
    expect(stripMarkdown('**bold** and *italic*')).toBe('bold and italic');
  });
});

describe('parseMarkdown', () => {
  it('renders headings and preserves hierarchy levels', () => {
    const { container } = render(
      createElement('div', null, parseMarkdown('# H1\n## H2\n### H3')),
    );
    expect(container.querySelectorAll('h1').length).toBe(1);
    expect(container.querySelector('h1')?.textContent).toBe('H1');
    expect(container.querySelectorAll('h2').length).toBe(1);
    expect(container.querySelector('h2')?.textContent).toBe('H2');
    expect(container.querySelectorAll('h3').length).toBe(1);
    expect(container.querySelector('h3')?.textContent).toBe('H3');
  });

  it('renders block quotes as blockquote elements', () => {
    const { container } = render(
      createElement('div', null, parseMarkdown('> first line\n> second line')),
    );
    const blockquote = container.querySelector('blockquote');
    expect(blockquote).not.toBeNull();
    expect(blockquote?.textContent).toContain('first line');
    expect(blockquote?.textContent).toContain('second line');
  });

  it('renders unordered and ordered lists', () => {
    const { container } = render(
      createElement('div', null, parseMarkdown('- alpha\n- beta\n\n1. one\n2. two')),
    );
    const unordered = container.querySelector('ul');
    const ordered = container.querySelector('ol');
    expect(unordered).not.toBeNull();
    expect(unordered?.querySelectorAll('li').length).toBe(2);
    expect(ordered).not.toBeNull();
    expect(ordered?.querySelectorAll('li').length).toBe(2);
  });

  it('renders code fences with language label and code block', () => {
    const markdown = '```ts\nconst value = 42;\n```';
    const { container } = render(createElement('div', null, parseMarkdown(markdown)));
    expect(container.querySelectorAll('pre').length).toBe(1);
    expect(container.querySelectorAll('code').length).toBeGreaterThanOrEqual(1);
    expect(container.textContent).toContain('ts');
    expect(container.textContent).toContain('const value = 42;');
  });

  it('renders highlight markup as mark elements', () => {
    const { container } = render(createElement('div', null, parseMarkdown('normal ==focus== text')));
    const mark = container.querySelector('mark');
    expect(mark).not.toBeNull();
    expect(mark?.textContent).toBe('focus');
  });

  it('renders only safe message autolinks', () => {
    const { container } = render(
      createElement(
        'div',
        null,
        parseMarkdown('good https://example.com/path bad https://user:pass@example.com/secret'),
      ),
    );

    const links = Array.from(container.querySelectorAll('a'));
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('https://example.com/path');
    expect(container.textContent).toContain('https://user:pass@example.com/secret');
  });
});
