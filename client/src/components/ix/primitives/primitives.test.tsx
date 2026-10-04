import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { IxGlyph } from '../glyphs';
import { Control, CreamButton, Hairline, SectionLabel, ToolChip, WideControl } from './index';

describe('CreamButton', () => {
  it('is a button that does not submit a form, 36px by default', () => {
    render(<CreamButton>Join</CreamButton>);
    const button = screen.getByRole('button', { name: 'Join' });
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveClass('ix-cream');
    expect(button).not.toHaveClass('ix-cream--sm');
    expect(button).not.toHaveClass('ix-cream--grow');
  });

  it('takes the inline size and the grow flag, and keeps a caller class', () => {
    render(
      <CreamButton size="sm" grow className="extra">
        Post it
      </CreamButton>,
    );
    expect(screen.getByRole('button', { name: 'Post it' })).toHaveClass('ix-cream', 'ix-cream--sm', 'ix-cream--grow', 'extra');
  });

  it('clicks, and does not when disabled', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const { rerender } = render(<CreamButton onClick={onClick}>Join</CreamButton>);
    await user.click(screen.getByRole('button', { name: 'Join' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(
      <CreamButton onClick={onClick} disabled>
        Join
      </CreamButton>,
    );
    await user.click(screen.getByRole('button', { name: 'Join' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('Control', () => {
  it('names an icon-only control and holds a glyph', () => {
    render(
      <Control label="Mute">
        <IxGlyph name="mic" size={16} />
      </Control>,
    );
    const control = screen.getByRole('button', { name: 'Mute' });
    expect(control).toHaveClass('ix-ctl');
    expect(control).not.toHaveAttribute('aria-pressed');
    expect(control.querySelector('svg')).toHaveAttribute('width', '16');
  });

  it('exposes a toggle as aria-pressed', () => {
    const { rerender } = render(<Control label="Listen" pressed={false} />);
    expect(screen.getByRole('button', { name: 'Listen' })).toHaveAttribute('aria-pressed', 'false');
    rerender(<Control label="Listen" pressed />);
    expect(screen.getByRole('button', { name: 'Listen' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('wears the danger tone for Leave', () => {
    render(<Control label="Leave" tone="danger" />);
    expect(screen.getByRole('button', { name: 'Leave' })).toHaveClass('ix-ctl', 'ix-ctl--danger');
  });
});

describe('WideControl', () => {
  it('is a control with words in it', () => {
    render(<WideControl>Open call</WideControl>);
    const control = screen.getByRole('button', { name: 'Open call' });
    expect(control).toHaveClass('ix-ctl', 'ix-ctl--wide');
    expect(control).toHaveAttribute('type', 'button');
  });

  it('takes the danger tone', () => {
    render(<WideControl tone="danger">Leave call</WideControl>);
    expect(screen.getByRole('button', { name: 'Leave call' })).toHaveClass('ix-ctl--danger');
  });
});

describe('ToolChip', () => {
  it('is a chip button', () => {
    render(
      <ToolChip>
        <IxGlyph name="attach" size={14} />
        Attach
      </ToolChip>,
    );
    const chip = screen.getByRole('button', { name: 'Attach' });
    expect(chip).toHaveClass('ix-chip');
    expect(chip).toHaveAttribute('type', 'button');
  });
});

describe('SectionLabel', () => {
  it('is a sentence-case label with an optional count', () => {
    const { container } = render(<SectionLabel count="3 here">Rooms</SectionLabel>);
    const label = container.firstElementChild as HTMLElement;
    expect(label.tagName).toBe('DIV');
    expect(label).toHaveClass('ix-section-label');
    expect(label).toHaveTextContent('Rooms3 here');
    expect(label.querySelector('.ix-section-label__count')).toHaveTextContent('3 here');
  });

  it('can be a heading', () => {
    render(<SectionLabel as="h2">Channels</SectionLabel>);
    expect(screen.getByRole('heading', { level: 2, name: 'Channels' })).toHaveClass('ix-section-label');
  });

  it('has no count element without a count', () => {
    const { container } = render(<SectionLabel>Messages</SectionLabel>);
    expect(container.querySelector('.ix-section-label__count')).toBeNull();
  });
});

describe('Hairline', () => {
  it('is a horizontal separator by default', () => {
    render(<Hairline />);
    const line = screen.getByRole('separator');
    expect(line).toHaveClass('ix-hairline');
    expect(line).toHaveAttribute('aria-orientation', 'horizontal');
  });

  it('is a 24px vertical one for the dock, or any length', () => {
    const { rerender } = render(<Hairline orientation="vertical" />);
    const line = screen.getByRole('separator');
    expect(line).toHaveClass('ix-hairline--vertical');
    expect(line).toHaveAttribute('aria-orientation', 'vertical');
    expect(line.style.getPropertyValue('--ix-hairline-length')).toBe('');
    rerender(<Hairline orientation="vertical" length={32} />);
    expect(screen.getByRole('separator').style.getPropertyValue('--ix-hairline-length')).toBe('32px');
  });

  it('can be purely decorative', () => {
    const { container } = render(<Hairline decorative />);
    expect(screen.queryByRole('separator')).toBeNull();
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
  });
});
