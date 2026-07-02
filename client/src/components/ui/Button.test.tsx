import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button } from './Button';

describe('Button', () => {
  it('defaults to type button so action buttons do not submit forms accidentally', () => {
    render(<Button>Open menu</Button>);

    expect(screen.getByRole('button', { name: 'Open menu' })).toHaveAttribute('type', 'button');
  });

  it('preserves explicit submit buttons', () => {
    render(<Button type="submit">Log in</Button>);

    expect(screen.getByRole('button', { name: 'Log in' })).toHaveAttribute('type', 'submit');
  });
});
