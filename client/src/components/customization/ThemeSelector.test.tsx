import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeSelector } from './ThemeSelector';
import { useUIStore } from '../../stores/uiStore';
import { configureMotion, resetMotionSwitchForTests } from '../../lib/motion/reducedMotion';

/**
 * Turning High contrast on goes through `changeLights`, which crosses the whole
 * shell over before it applies. Under reduced motion it simply calls the apply
 * and returns (§5.3), which is the deterministic path a test wants — and it is
 * the real engine either way, not a stub.
 */
beforeEach(() => {
  configureMotion('reduced');
  useUIStore.setState({
    theme: 'glass',
    transparency: 'system',
    motion: 'reduced',
  });
});

afterEach(() => {
  resetMotionSwitchForTests();
});

const highContrast = () => screen.getByRole('switch', { name: 'High contrast' });

describe('ThemeSelector', () => {
  it('offers High contrast, Transparency and Motion, and nothing that picks a look', () => {
    render(<ThemeSelector />);

    expect(screen.getByRole('heading', { name: 'Contrast' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Transparency' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Motion' })).toBeInTheDocument();
    expect(highContrast()).toBeInTheDocument();

    // The retired looks, the accent presets and the base color are all gone.
    for (const gone of [
      /Night/,
      /Daylight/,
      /AMOLED/,
      /Dusk sky/,
      /Paper & ink/,
      /Slate/,
      /Aubergine/,
      /Set accent/,
      /Any other color/,
    ]) {
      expect(screen.queryByText(gone)).toBeNull();
      expect(screen.queryByRole('button', { name: gone })).toBeNull();
    }
    expect(screen.queryByRole('heading', { name: 'Looks' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Base color' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Accent color' })).toBeNull();
    expect(screen.queryByRole('slider')).toBeNull();
  });

  describe('High contrast', () => {
    it('is off on Glass and on for the High contrast theme', () => {
      const { rerender } = render(<ThemeSelector currentTheme="glass" />);
      expect(highContrast()).toHaveAttribute('aria-checked', 'false');

      rerender(<ThemeSelector currentTheme="glass-contrast" />);
      expect(highContrast()).toHaveAttribute('aria-checked', 'true');
    });

    it('stores glass-contrast when it is turned on, and reports it', () => {
      const onThemeChange = vi.fn();
      render(<ThemeSelector onThemeChange={onThemeChange} />);

      fireEvent.click(highContrast());

      expect(useUIStore.getState().theme).toBe('glass-contrast');
      expect(onThemeChange).toHaveBeenCalledWith('glass-contrast');
    });

    it('goes back to Glass when it is turned off', () => {
      useUIStore.setState({ theme: 'glass-contrast' });
      const onThemeChange = vi.fn();
      render(<ThemeSelector onThemeChange={onThemeChange} />);

      fireEvent.click(highContrast());

      expect(useUIStore.getState().theme).toBe('glass');
      expect(onThemeChange).toHaveBeenCalledWith('glass');
    });

    it('reads a retired theme id as the theme it becomes', () => {
      // A parent that still holds an old id (the server's value, say).
      render(<ThemeSelector currentTheme={'high-contrast' as never} />);
      expect(highContrast()).toHaveAttribute('aria-checked', 'true');
    });
  });

  describe('Transparency', () => {
    const option = (name: RegExp) => screen.getByRole('radio', { name });

    it('offers match-my-system, standard and reduced, and marks the stored one', () => {
      render(<ThemeSelector />);

      expect(option(/Match my system.*reduce-transparency/)).toHaveAttribute('aria-checked', 'true');
      expect(option(/Standard/)).toHaveAttribute('aria-checked', 'false');
      expect(option(/Reduced.*fully solid/)).toHaveAttribute('aria-checked', 'false');
    });

    it.each([
      [/Standard/, 'standard'],
      [/Reduced.*fully solid/, 'reduced'],
      [/Match my system.*reduce-transparency/, 'system'],
    ] as const)('stores %s as %s', (name, expected) => {
      useUIStore.setState({ transparency: expected === 'system' ? 'reduced' : 'system' });
      render(<ThemeSelector />);

      fireEvent.click(option(name));

      expect(useUIStore.getState().transparency).toBe(expected);
    });

    it('does not change the theme', () => {
      render(<ThemeSelector />);

      fireEvent.click(option(/Reduced.*fully solid/));

      expect(useUIStore.getState().theme).toBe('glass');
    });
  });

  describe('Motion', () => {
    it('keeps the three motion choices and stores the pick', () => {
      useUIStore.setState({ motion: 'system' });
      render(<ThemeSelector />);

      fireEvent.click(screen.getByRole('radio', { name: /Reduced motion/ }));
      expect(useUIStore.getState().motion).toBe('reduced');

      fireEvent.click(screen.getByRole('radio', { name: /Full motion/ }));
      expect(useUIStore.getState().motion).toBe('full');

      fireEvent.click(screen.getByRole('radio', { name: /Match my system.*reduced-motion/ }));
      expect(useUIStore.getState().motion).toBe('system');
    });
  });

  it('uses American spelling and plain words', () => {
    const { container } = render(<ThemeSelector />);
    const text = container.textContent ?? '';

    expect(text).not.toMatch(/colour|behaviour|grey|centre|customis|organis|optimis/i);
    // The vocabulary lint's rule for page copy: no "room" or "building".
    expect(text).not.toMatch(/\broom\b|\bbuilding\b/i);
  });
});
