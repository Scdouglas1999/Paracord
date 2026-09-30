import { describe, expect, it } from 'vitest';
import { createRef } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  GLYPH_NAMES,
  GlassButton,
  GlassChip,
  Glyph,
  InstrumentText,
  JoinButton,
  Kicker,
  ListenGlyph,
  Pane,
  Waveform,
  barScale,
} from './index';

/** The spec's path data (docs/glass-spec.md §2.5), verbatim. */
const SPEC_PATHS: Record<string, string[]> = {
  listen: ['M9.5 8.8a4.6 4.6 0 0 1 0 6.4M13.4 5.9a8.8 8.8 0 0 1 0 12.2M17.3 3a13 13 0 0 1 0 18'],
  watch: ['M2.8 12c2.6-4.3 5.7-6.4 9.2-6.4s6.6 2.1 9.2 6.4c-2.6 4.3-5.7 6.4-9.2 6.4S5.4 16.3 2.8 12z'],
  clip: ['M15.2 4.5h2.3a3 3 0 0 1 3 3v2.3z', 'M9 21h6', 'M8 8.5v5M11 8.5v5'],
  flame: [
    'M12 2.8c.7 3.3 5.2 5 5.2 10.1a5.2 5.2 0 0 1-10.4 0c0-2.2 1-3.6 2.3-4.7.1 2.1 1.1 3.2 2.4 3.6-.6-3-.9-6.1.5-9z',
    'M12 19.6c1.2 0 2-.9 2-2 0-1.5-1.2-2.3-2-3.5-.8 1.2-2 2-2 3.5 0 1.1.8 2 2 2z',
  ],
  theater: ['M5 20.5a1.6 1.6 0 0 1 3.2 0M10.4 20.5a1.6 1.6 0 0 1 3.2 0M15.8 20.5a1.6 1.6 0 0 1 3.2 0'],
  split: ['M15 5v14'],
};

describe('Glyph', () => {
  it('draws each glyph from the spec paths on a 24 grid with a 2px round stroke', () => {
    for (const name of GLYPH_NAMES) {
      const { container, unmount } = render(<Glyph name={name} />);
      const svg = container.querySelector('svg')!;
      expect(svg).toHaveAttribute('viewBox', '0 0 24 24');
      expect(svg).toHaveAttribute('stroke-width', '2');
      expect(svg).toHaveAttribute('stroke-linecap', 'round');
      expect(svg).toHaveAttribute('stroke-linejoin', 'round');
      expect(svg).toHaveAttribute('fill', 'none');
      const ds = [...svg.querySelectorAll('path')].map((p) => p.getAttribute('d'));
      for (const d of SPEC_PATHS[name]) expect(ds).toContain(d);
      unmount();
    }
  });

  it('keeps the spec shapes that are not paths', () => {
    const { container } = render(
      <>
        <Glyph name="listen" />
        <Glyph name="watch" />
        <Glyph name="clip" />
        <Glyph name="theater" />
        <Glyph name="split" />
      </>,
    );
    const q = (glyph: string, sel: string) => container.querySelector(`[data-glyph="${glyph}"] ${sel}`)!;
    expect(q('listen', 'circle')).toHaveAttribute('r', '1.6');
    expect(q('watch', 'circle')).toHaveAttribute('r', '2.7');
    expect(q('clip', 'rect')).toHaveAttribute('rx', '3');
    expect(q('theater', 'rect')).toHaveAttribute('height', '11.5');
    expect(q('split', 'rect')).toHaveAttribute('rx', '2');
  });

  it('fills the solid parts and leaves the clip corner stroked', () => {
    const { container } = render(<Glyph name="clip" />);
    const corner = container.querySelector('path[d^="M15.2"]')!;
    expect(corner).toHaveAttribute('fill', 'currentColor');
    expect(corner).not.toHaveAttribute('stroke', 'none');
    const { container: l } = render(<Glyph name="listen" />);
    expect(l.querySelector('circle')).toHaveAttribute('stroke', 'none');
  });

  it('is decorative without a title and named with one', () => {
    const { rerender } = render(<Glyph name="flame" />);
    expect(document.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('img')).toBeNull();
    rerender(<Glyph name="flame" title="Flame" />);
    expect(screen.getByRole('img', { name: 'Flame' })).toBeInTheDocument();
  });

  it('sizes by prop and has a named component per verb', () => {
    const { container } = render(<ListenGlyph size={17} />);
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveAttribute('width', '17');
    expect(svg).toHaveAttribute('data-glyph', 'listen');
  });
});

describe('Waveform', () => {
  const bars = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>('.glass-wave > span')];

  it('is five bars at the spec heights, hidden from assistive tech', () => {
    const { container } = render(<Waveform />);
    const root = container.querySelector('.glass-wave')!;
    expect(root).toHaveAttribute('aria-hidden', 'true');
    expect(bars(container).map((b) => b.style.height)).toEqual(['7px', '12px', '14px', '11px', '6px']);
  });

  it('loops each bar on its own duration between 0.8 and 1.2 seconds', () => {
    const { container } = render(<Waveform />);
    const durations = bars(container).map((b) => Number.parseFloat(b.style.animationDuration));
    expect(new Set(durations).size).toBeGreaterThan(1);
    for (const d of durations) {
      expect(d).toBeGreaterThanOrEqual(0.8);
      expect(d).toBeLessThanOrEqual(1.2);
    }
    expect(container.querySelector('.glass-wave')).not.toHaveAttribute('data-live-level');
  });

  it('follows a real voice level instead of looping', () => {
    const { container, rerender } = render(<Waveform level={0} />);
    const root = container.querySelector('.glass-wave')!;
    expect(root).toHaveAttribute('data-live-level');
    expect(bars(container)[0].style.animationDuration).toBe('');
    const quiet = bars(container).map((b) => Number(b.style.getPropertyValue('--wave-scale')));
    quiet.forEach((s) => expect(s).toBeCloseTo(0.35, 2));
    rerender(<Waveform level={1} />);
    const loud = bars(container).map((b) => Number(b.style.getPropertyValue('--wave-scale')));
    loud.forEach((s, i) => expect(s).toBeGreaterThan(quiet[i]));
    expect(Math.max(...loud)).toBeLessThanOrEqual(1);
  });

  it('clamps and survives a bad level', () => {
    expect(barScale(5, 1)).toBe(1);
    expect(barScale(-1, 1)).toBeCloseTo(0.35);
    expect(barScale(Number.NaN, 1)).toBeCloseTo(0.35);
  });
});

describe('GlassButton', () => {
  it('defaults to type button so it never submits a form by accident', () => {
    render(<GlassButton>Watch</GlassButton>);
    expect(screen.getByRole('button', { name: 'Watch' })).toHaveAttribute('type', 'button');
  });

  it('renders every variant with its recipe class and the focus ring hook', () => {
    render(
      <>
        <GlassButton variant="primary">Join</GlassButton>
        <GlassButton variant="glass">Listen</GlassButton>
        <GlassButton variant="text">Leave</GlassButton>
        <GlassButton variant="icon" aria-label="Mute">
          x
        </GlassButton>
      </>,
    );
    for (const [name, variant] of [
      ['Join', 'primary'],
      ['Listen', 'glass'],
      ['Leave', 'text'],
      ['Mute', 'icon'],
    ]) {
      const button = screen.getByRole('button', { name });
      expect(button).toHaveClass('glass-btn', `glass-btn--${variant}`, 'glass-focusable');
    }
  });

  it('is 36px by default and 44px at md', () => {
    render(
      <>
        <GlassButton>Small</GlassButton>
        <GlassButton size="md">Medium</GlassButton>
      </>,
    );
    expect(screen.getByRole('button', { name: 'Small' })).not.toHaveClass('glass-btn--md');
    expect(screen.getByRole('button', { name: 'Medium' })).toHaveClass('glass-btn--md');
  });

  it('reports a toggle through aria-pressed and lights amber on request', () => {
    render(
      <GlassButton pressed tone="amber">
        Listening
      </GlassButton>,
    );
    const button = screen.getByRole('button', { name: 'Listening' });
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(button).toHaveAttribute('data-tone', 'amber');
  });

  it('leaves aria-pressed off a button that is not a toggle', () => {
    render(<GlassButton>Watch</GlassButton>);
    expect(screen.getByRole('button', { name: 'Watch' })).not.toHaveAttribute('aria-pressed');
  });

  it('forwards refs and clicks, and honors disabled', async () => {
    const ref = createRef<HTMLButtonElement>();
    let clicks = 0;
    render(
      <>
        <GlassButton ref={ref} onClick={() => (clicks += 1)}>
          Go
        </GlassButton>
        <GlassButton disabled onClick={() => (clicks += 10)}>
          Nope
        </GlassButton>
      </>,
    );
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
    await userEvent.click(screen.getByRole('button', { name: 'Go' }));
    await userEvent.click(screen.getByRole('button', { name: 'Nope' }));
    expect(clicks).toBe(1);
  });

  it('JoinButton is the primary variant', () => {
    render(<JoinButton>Join</JoinButton>);
    expect(screen.getByRole('button', { name: 'Join' })).toHaveClass('glass-btn--primary');
  });
});

describe('Pane', () => {
  it('is the pane surface by default, with tones and glow on request', () => {
    const { rerender } = render(<Pane data-testid="p">Hi</Pane>);
    expect(screen.getByTestId('p')).toHaveClass('glass-pane');
    expect(screen.getByTestId('p')).not.toHaveClass('glass-pane--glow');
    rerender(
      <Pane data-testid="p" tone="deep" glow>
        Hi
      </Pane>,
    );
    expect(screen.getByTestId('p')).toHaveClass('glass-pane--deep', 'glass-pane--glow');
    rerender(
      <Pane data-testid="p" tone="solid">
        Hi
      </Pane>,
    );
    expect(screen.getByTestId('p')).toHaveClass('glass-pane--solid');
  });

  it('can be a landmark element', () => {
    render(
      <Pane as="aside" aria-label="Places">
        x
      </Pane>,
    );
    expect(screen.getByRole('complementary', { name: 'Places' })).toHaveClass('glass-pane');
  });
});

describe('GlassChip, Kicker, InstrumentText', () => {
  it('draws each chip tone and gives the live chip its dot', () => {
    const { container } = render(
      <>
        <GlassChip tone="count">3</GlassChip>
        <GlassChip tone="mention">@</GlassChip>
        <GlassChip tone="live">Lounge 3 in</GlassChip>
        <GlassChip tone="event">Movie night</GlassChip>
        <GlassChip tone="reaction">5</GlassChip>
      </>,
    );
    for (const tone of ['count', 'mention', 'live', 'event', 'reaction']) {
      expect(container.querySelector(`.glass-chip--${tone}`)).not.toBeNull();
    }
    expect(container.querySelectorAll('.glass-chip__dot')).toHaveLength(1);
    expect(screen.getByText('3')).toHaveClass('glass-badge-text');
    expect(screen.getByText('Movie night')).not.toHaveClass('glass-badge-text');
  });

  it('renders the kicker and the instrument cut', () => {
    render(
      <>
        <Kicker>Coming up</Kicker>
        <Kicker tone="amber" as="span">
          Live 42 min
        </Kicker>
        <InstrumentText>9:09 PM</InstrumentText>
        <InstrumentText dateTime="2026-09-29T21:09">9:09 PM</InstrumentText>
      </>,
    );
    expect(screen.getByText('Coming up')).toHaveClass('glass-kicker');
    expect(screen.getByText('Live 42 min').style.color).toBe('var(--amber)');
    const times = screen.getAllByText('9:09 PM');
    expect(times[0].tagName).toBe('SPAN');
    expect(times[1].tagName).toBe('TIME');
    times.forEach((t) => expect(t).toHaveClass('glass-instrument'));
  });

  it('paints no literal color: every value the primitives write is a token', () => {
    const { container } = render(
      <>
        <Kicker tone="amber">a</Kicker>
        <GlassButton variant="primary">b</GlassButton>
        <GlassChip tone="live">c</GlassChip>
        <Waveform level={0.5} />
        <Glyph name="flame" />
        <Pane>d</Pane>
      </>,
    );
    const literal = /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i;
    for (const el of container.querySelectorAll('*')) {
      expect(el.getAttribute('style') ?? '').not.toMatch(literal);
    }
  });
});
