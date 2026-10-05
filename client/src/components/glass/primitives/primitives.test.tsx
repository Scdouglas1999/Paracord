import { describe, expect, it } from 'vitest';
import { createRef } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { GlassButton, Kicker } from './index';

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
      </>,
    );
    for (const [name, variant] of [
      ['Join', 'primary'],
      ['Listen', 'glass'],
      ['Leave', 'text'],
    ]) {
      const button = screen.getByRole('button', { name });
      expect(button).toHaveClass('glass-btn', `glass-btn--${variant}`, 'glass-focusable');
    }
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
});

describe('Kicker', () => {
  it('renders the kicker, in ink or amber', () => {
    render(
      <>
        <Kicker>Coming up</Kicker>
        <Kicker tone="amber" as="span">
          Live 42 min
        </Kicker>
      </>,
    );
    expect(screen.getByText('Coming up')).toHaveClass('glass-kicker');
    expect(screen.getByText('Live 42 min').style.color).toBe('var(--amber)');
  });

  it('paints no literal color: every value the primitives write is a token', () => {
    const { container } = render(
      <>
        <Kicker tone="amber">a</Kicker>
        <GlassButton variant="primary">b</GlassButton>
      </>,
    );
    const literal = /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i;
    for (const el of container.querySelectorAll('*')) {
      expect(el.getAttribute('style') ?? '').not.toMatch(literal);
    }
  });
});
