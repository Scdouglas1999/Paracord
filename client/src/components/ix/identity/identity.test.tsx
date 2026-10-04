import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { paletteHue, serverHue } from '../../../lib/identityHue';
import { Avatar, AvatarStack, PresenceDot, ServerMark, presenceKind } from './index';

/** A one-pixel PNG: a data URL the avatar resolver accepts. */
const PICTURE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const hueOf = (el: Element | null) => (el as HTMLElement).style.getPropertyValue('--ix-h');
const root = (container: HTMLElement) => container.firstElementChild as HTMLElement;

describe('Avatar', () => {
  it('draws one uppercase letter on the person hue', () => {
    const { container } = render(<Avatar userId="123456789" name="jeremy vincent" />);
    const el = root(container);
    expect(el).toHaveClass('ix-av');
    expect(el).toHaveTextContent(/^J$/);
    expect(hueOf(el)).toBe(String(paletteHue('123456789')));
  });

  it('uses the same hue for the same person everywhere', () => {
    const a = render(<Avatar userId="42" name="A" size={24} />);
    const b = render(<Avatar userId="42" name="Different name" size={88} />);
    expect(hueOf(root(a.container))).toBe(hueOf(root(b.container)));
  });

  it('takes an explicit hue over the person one', () => {
    const { container } = render(<Avatar userId="42" name="A" hue={210} />);
    expect(hueOf(root(container))).toBe('210');
  });

  it('ignores an invalid hue override', () => {
    const { container } = render(<Avatar userId="42" name="A" hue={999} />);
    expect(hueOf(root(container))).toBe(String(paletteHue('42')));
  });

  it('sizes itself and its letter: 44% of the size, 36% from 88px', () => {
    for (const [size, font] of [[24, 11], [30, 13], [32, 14], [34, 15], [38, 17], [40, 18], [76, 33], [88, 32]] as const) {
      const { container, unmount } = render(<Avatar userId="1" name="N" size={size} />);
      const el = root(container);
      expect(el.style.width, `${size}`).toBe(`${size}px`);
      expect(el.style.height, `${size}`).toBe(`${size}px`);
      expect(el.style.fontSize, `${size}`).toBe(`${font}px`);
      unmount();
    }
  });

  it('is 32px by default', () => {
    const { container } = render(<Avatar userId="1" name="N" />);
    expect(root(container).style.width).toBe('32px');
  });

  it('shows an uploaded picture instead of the monogram', () => {
    const { container } = render(<Avatar userId="1" name="Jeremy" avatar={PICTURE} />);
    const el = root(container);
    expect(container.querySelector('img')).toHaveAttribute('src', PICTURE);
    expect(el).toHaveClass('ix-has-img');
    expect(el).not.toHaveTextContent('J');
  });

  it('falls back to the monogram when the picture fails to load', () => {
    const { container } = render(<Avatar userId="1" name="Jeremy" avatar={PICTURE} />);
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
    expect(root(container)).toHaveTextContent('J');
    expect(root(container)).not.toHaveClass('ix-has-img');
  });

  it('draws the monogram when the avatar value is not a usable picture', () => {
    const { container } = render(<Avatar userId="1" name="Jeremy" avatar="https://tracker.example/pixel.png" />);
    expect(container.querySelector('img')).toBeNull();
    expect(root(container)).toHaveTextContent('J');
  });

  it('is decorative unless it is given a label', () => {
    const decorative = render(<Avatar userId="1" name="Jeremy" />);
    expect(root(decorative.container)).toHaveAttribute('aria-hidden', 'true');
    expect(root(decorative.container)).not.toHaveAttribute('role');
    const labeled = render(<Avatar userId="1" name="Jeremy" label="Jeremy, online" />);
    expect(root(labeled.container)).toHaveAttribute('role', 'img');
    expect(root(labeled.container)).toHaveAttribute('aria-label', 'Jeremy, online');
    expect(root(labeled.container)).not.toHaveAttribute('aria-hidden');
  });

  it('carries no inline glow, ring or shadow of its own', () => {
    const { container } = render(<Avatar userId="1" name="Jeremy" size={88} />);
    const style = root(container).getAttribute('style') ?? '';
    expect(style).not.toMatch(/shadow|filter|animation|gradient/);
  });

  it('draws a presence dot for online, idle and do not disturb, and none for offline or invisible', () => {
    for (const [status, kind] of [['online', 'online'], ['streaming', 'online'], ['idle', 'idle'], ['dnd', 'dnd']] as const) {
      const { container, unmount } = render(<Avatar userId="1" name="N" presence={status} />);
      expect(container.querySelector('.ix-presence')).toHaveAttribute('data-presence', kind);
      expect(root(container)).toHaveClass('ix-has-dot');
      unmount();
    }
    for (const status of ['offline', 'invisible', 'something-else', null, undefined]) {
      const { container, unmount } = render(<Avatar userId="1" name="N" presence={status} />);
      expect(container.querySelector('.ix-presence')).toBeNull();
      expect(root(container)).not.toHaveClass('ix-has-dot');
      unmount();
    }
  });

  it('shrinks the dot to 8px on a face under 30px and keeps 10px otherwise', () => {
    const small = render(<Avatar userId="1" name="N" size={24} presence="online" />);
    expect((small.container.querySelector('.ix-presence') as HTMLElement).style.getPropertyValue('--ix-dot')).toBe('8px');
    const large = render(<Avatar userId="1" name="N" size={38} presence="online" />);
    expect((large.container.querySelector('.ix-presence') as HTMLElement).style.getPropertyValue('--ix-dot')).toBe('');
  });

  it('passes the ring surface to the dot', () => {
    const { container } = render(<Avatar userId="1" name="N" presence="online" ring="var(--ix-main)" />);
    expect((container.querySelector('.ix-presence') as HTMLElement).style.getPropertyValue('--ix-ring')).toBe('var(--ix-main)');
  });
});

describe('ServerMark', () => {
  it('draws one uppercase letter on the server hue', () => {
    const { container } = render(<ServerMark guildId="987654321" name="game night" />);
    const el = root(container);
    expect(el).toHaveClass('ix-sq');
    expect(el).toHaveTextContent(/^G$/);
    expect(hueOf(el)).toBe(String(paletteHue('987654321')));
  });

  it("uses the server's own hue when it has one, the id's when null", () => {
    const own = render(<ServerMark guildId="987654321" name="Fuel" hue={195} />);
    expect(hueOf(root(own.container))).toBe('195');
    const unset = render(<ServerMark guildId="987654321" name="Fuel" hue={null} />);
    expect(hueOf(root(unset.container))).toBe(String(serverHue({ id: '987654321' })));
  });

  it('is 34px by default with a 44% letter, and takes the sizes in use', () => {
    const base = render(<ServerMark guildId="1" name="Fuel" />);
    expect(root(base.container).style.width).toBe('34px');
    expect(root(base.container).style.fontSize).toBe('15px');
    for (const [size, font] of [[24, 11], [32, 14], [38, 17], [40, 18], [76, 33], [88, 39]] as const) {
      const { container, unmount } = render(<ServerMark guildId="1" name="Fuel" size={size} />);
      expect(root(container).style.width).toBe(`${size}px`);
      expect(root(container).style.height).toBe(`${size}px`);
      expect(root(container).style.fontSize).toBe(`${font}px`);
      unmount();
    }
  });

  it('leaves the 28% radius to the stylesheet unless a radius is passed', () => {
    const plain = render(<ServerMark guildId="1" name="Fuel" />);
    expect(root(plain.container).style.borderRadius).toBe('');
    const welcome = render(<ServerMark guildId="1" name="Fuel" size={76} radius={22} fontSize={34} />);
    expect(root(welcome.container).style.borderRadius).toBe('22px');
    expect(root(welcome.container).style.fontSize).toBe('34px');
  });

  it('shows an uploaded icon instead of the monogram', () => {
    const { container } = render(<ServerMark guildId="1" name="Fuel" icon={PICTURE} />);
    expect(container.querySelector('img')).toHaveAttribute('src', PICTURE);
    expect(root(container)).toHaveClass('ix-has-img');
    expect(root(container)).not.toHaveTextContent('F');
  });

  it('falls back to the monogram when the icon fails to load', () => {
    const { container } = render(<ServerMark guildId="1" name="Fuel" icon={PICTURE} />);
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
    expect(root(container)).toHaveTextContent('F');
  });

  it('is decorative unless it is given a label, and carries no inline glow', () => {
    const { container } = render(<ServerMark guildId="1" name="Fuel" />);
    expect(root(container)).toHaveAttribute('aria-hidden', 'true');
    expect(root(container).getAttribute('style') ?? '').not.toMatch(/shadow|filter|animation|gradient/);
    const labeled = render(<ServerMark guildId="1" name="Fuel" label="Fuel" />);
    expect(root(labeled.container)).toHaveAttribute('role', 'img');
  });
});

describe('AvatarStack', () => {
  const people = ['1', '2', '3', '4', '5', '6'].map((id) => ({ userId: id, name: `Person ${id}` }));

  it('draws every face in order, overlapped by 7px by default', () => {
    const { container } = render(<AvatarStack people={people} />);
    const faces = container.querySelectorAll('.ix-av');
    expect(faces).toHaveLength(6);
    expect([...faces].map((f) => f.textContent)).toEqual(['P', 'P', 'P', 'P', 'P', 'P']);
    expect([...faces].map((f) => (f as HTMLElement).style.width)).toEqual(Array(6).fill('24px'));
    expect(root(container)).toHaveClass('ix-faces');
    expect(root(container).style.getPropertyValue('--ix-overlap')).toBe('7px');
  });

  it('caps the number of faces and takes a size, an overlap and a ring surface', () => {
    const { container } = render(<AvatarStack people={people} max={5} size={16} overlap={5} ring="var(--ix-room-dark)" />);
    expect(container.querySelectorAll('.ix-av')).toHaveLength(5);
    expect((container.querySelector('.ix-av') as HTMLElement).style.width).toBe('16px');
    expect(root(container).style.getPropertyValue('--ix-overlap')).toBe('5px');
    expect(root(container).style.getPropertyValue('--ix-ring')).toBe('var(--ix-room-dark)');
  });

  it('is decorative', () => {
    const { container } = render(<AvatarStack people={people} />);
    expect(root(container)).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('PresenceDot', () => {
  it('maps a status to a dot, and offline to nothing', () => {
    expect(presenceKind('online')).toBe('online');
    expect(presenceKind('streaming')).toBe('online');
    expect(presenceKind('idle')).toBe('idle');
    expect(presenceKind('dnd')).toBe('dnd');
    expect(presenceKind('offline')).toBeNull();
    expect(presenceKind('invisible')).toBeNull();
    expect(presenceKind(null)).toBeNull();
  });

  it('renders nothing for no dot and an aria-hidden dot otherwise', () => {
    const none = render(<PresenceDot status="offline" />);
    expect(none.container).toBeEmptyDOMElement();
    const dot = render(<PresenceDot status="idle" inline />);
    const el = root(dot.container);
    expect(el).toHaveAttribute('aria-hidden', 'true');
    expect(el).toHaveClass('ix-presence', 'ix-presence--idle', 'ix-presence--inline');
  });
});

describe('the identity recipes in ix-base.css', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/styles/ix-base.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (selector: string): string => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const found = css.match(new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`));
    if (!found) throw new Error(`no rule ${selector}`);
    return found[1];
  };

  it('copies the prototype .av values for a person', () => {
    const body = rule('.ix-av');
    expect(body).toContain('border-radius: 50%');
    expect(body).toContain('font-weight: 550');
    expect(body).toContain('font-stretch: 90%');
    expect(body).toContain('letter-spacing: -0.02em');
    expect(body).toContain('color: hsl(var(--ix-h) 75% 85%)');
    expect(body).toContain('background: linear-gradient(180deg, hsl(var(--ix-h) 30% 30%), hsl(var(--ix-h) 27% 23%))');
    expect(body).toContain('inset 0 0 0 1px hsl(var(--ix-h) 45% 75% / 0.13)');
  });

  it('copies the prototype .sq values for a server', () => {
    const body = rule('.ix-sq');
    expect(body).toContain('border-radius: 28%');
    expect(body).toContain('font-weight: 600');
    expect(body).toContain('font-stretch: 85%');
    expect(body).toContain('letter-spacing: -0.03em');
    expect(body).toContain('color: hsl(var(--ix-h) 85% 90%)');
    expect(body).toContain('background: linear-gradient(150deg, hsl(var(--ix-h) 44% 38%), hsl(var(--ix-h) 40% 23%))');
    expect(body).toContain('inset 0 0 0 1px hsl(var(--ix-h) 60% 80% / 0.16)');
  });

  it('is flat: no radial highlight, glow, blur, drop shadow, animation or filter on a mark', () => {
    for (const selector of ['.ix-av', '.ix-sq', ".ix-has-img::after", "[data-theme='glass-contrast'] .ix-av", "[data-theme='glass-contrast'] .ix-sq"]) {
      const body = rule(selector);
      expect(body, selector).not.toMatch(/radial-gradient|blur|drop-shadow|filter|animation|transition|text-shadow/);
      // Only a hairline: every shadow on a mark is inset, or is the hairline variable.
      for (const shadow of body.match(/box-shadow:[^;]+/g) ?? []) {
        expect(shadow, selector).toMatch(/inset|^box-shadow:\s*var\(--ix-av-hl\)$/);
      }
      for (const hairline of body.match(/--ix-av-hl:[^;]+/g) ?? []) {
        expect(hairline, selector).toMatch(/^--ix-av-hl:\s*inset 0 0 0 1px /);
      }
    }
  });

  it('keeps presence to ink: no red, green or yellow', () => {
    for (const selector of ['.ix-presence', '.ix-presence--online', '.ix-presence--idle', '.ix-presence--dnd']) {
      const body = rule(selector);
      expect(body, selector).not.toMatch(/danger|amber|hsl\(|rgb/);
    }
  });

  it('holds no literal color: the file passes through tokens and hues only', () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/\brgba?\(\s*\d/);
    expect(css).not.toMatch(/\bhsla?\(\s*\d/);
  });
});
