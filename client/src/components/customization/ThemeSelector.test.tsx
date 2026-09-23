import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeSelector } from './ThemeSelector';
import { BASE_HUE_DEFAULT, BASE_TINT_DEFAULT, useUIStore } from '../../stores/uiStore';
import { configureMotion, resetMotionSwitchForTests } from '../../lib/motion/reducedMotion';
import type { ThemeId } from '../../lib/themes';

/**
 * Picking a theme goes through `changeLights`, which crosses the whole shell
 * over before it applies. Under reduced motion it simply calls the apply and
 * returns (§5.3), which is the deterministic path a test wants — and it is the
 * real engine either way, not a stub.
 */
beforeEach(() => {
  configureMotion('reduced');
  useUIStore.setState({
    theme: 'dark',
    accentPreset: 'emerald',
    baseHue: BASE_HUE_DEFAULT,
    baseTint: BASE_TINT_DEFAULT,
    motion: 'reduced',
  });
});

afterEach(() => {
  resetMotionSwitchForTests();
});

/** The base-colour presets, found by their hints so "Dusk" cannot collide with
 *  the "Dusk sky" look. */
const hearth = () => screen.getByRole('button', { name: /Warm brown, the default/ });
const swatch = () => screen.getByRole('button', { name: 'Set accent Emerald' });
const hueSlider = () => screen.getByRole('slider');

describe('ThemeSelector', () => {
  it('offers the four themes and the four looks', () => {
    render(<ThemeSelector />);

    for (const name of [/Night/, /Daylight/, /AMOLED/, /High contrast/]) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: /Dusk sky/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Paper & ink/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cool charcoal/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Aubergine/ })).toBeInTheDocument();
  });

  it('labels the looks as their own group, in sentence case, and says what one is', () => {
    render(<ThemeSelector />);

    const heading = screen.getByRole('heading', { name: 'Looks' });
    expect(heading).toBeInTheDocument();
    // spec §6.8: a section label is never uppercased.
    expect(heading.className).not.toContain('uppercase');
    expect(
      screen.getByText('A look is a whole palette. It brings its own accent and ground colors.'),
    ).toBeInTheDocument();
  });

  it.each([
    ['Dusk sky', 'dusk'],
    ['Paper & ink', 'paper'],
    ['cool charcoal', 'slate'],
    ['Aubergine', 'voices'],
  ] as Array<[string, ThemeId]>)('stores %s as %s and reports it', (label, id) => {
    const onThemeChange = vi.fn();
    render(<ThemeSelector onThemeChange={onThemeChange} />);

    fireEvent.click(screen.getByRole('button', { name: new RegExp(label) }));

    expect(useUIStore.getState().theme).toBe(id);
    expect(onThemeChange).toHaveBeenCalledWith(id);
  });

  it('marks the chosen look as selected', () => {
    render(<ThemeSelector currentTheme="voices" />);

    expect(screen.getByRole('button', { name: /Aubergine/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Night/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('leaves the base colour and the accent usable for a theme that is not a look', () => {
    render(<ThemeSelector currentTheme="dark" />);

    expect(hearth()).toBeEnabled();
    expect(swatch()).toBeEnabled();
    expect(hueSlider()).toBeEnabled();
    expect(screen.queryByText(/brings its own colors/)).toBeNull();
  });

  it('disables the base colour and the accent for a look, and says which look', () => {
    render(<ThemeSelector currentTheme="dusk" />);

    expect(hearth()).toBeDisabled();
    expect(hearth()).toHaveAttribute('aria-disabled', 'true');
    expect(hueSlider()).toBeDisabled();
    expect(swatch()).toBeDisabled();
    expect(swatch()).toHaveAttribute('aria-disabled', 'true');

    // Named for the look that is in charge, and shown twice: once under each
    // control it explains. Disabled, never hidden.
    const notes = screen.getAllByText(
      'Dusk sky brings its own colors. Pick Night, Daylight, AMOLED or High contrast to change these.',
    );
    expect(notes).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'Base color' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Accent color' })).toBeInTheDocument();
  });

  it('names the note after whichever look is active', () => {
    render(<ThemeSelector currentTheme="paper" />);

    expect(screen.getAllByText(/^Paper & ink brings its own colors\./)).toHaveLength(2);
  });

  it('does not change the base colour while a look is active', () => {
    render(<ThemeSelector currentTheme="voices" />);

    // A disabled control cannot be clicked; the store is the proof.
    fireEvent.click(hearth());
    fireEvent.click(swatch());

    expect(useUIStore.getState().baseHue).toBe(BASE_HUE_DEFAULT);
    expect(useUIStore.getState().accentPreset).toBe('emerald');
  });

  it('hands the controls back when a look is swapped for a theme', () => {
    const { rerender } = render(<ThemeSelector currentTheme="dusk" />);
    expect(hearth()).toBeDisabled();

    rerender(<ThemeSelector currentTheme="high-contrast" />);

    expect(hearth()).toBeEnabled();
    expect(swatch()).toBeEnabled();
    expect(screen.queryByText(/brings its own colors/)).toBeNull();
  });
});
