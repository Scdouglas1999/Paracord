import { useId } from 'react';
import { useUIStore } from '../../stores/uiStore';
import {
  DEFAULT_THEME,
  HIGH_CONTRAST_THEME,
  asThemeId,
  type ThemeId,
  type TransparencyPreference,
} from '../../lib/themes';
import { changeLights, useReducedMotion, type MotionPreference } from '../../lib/motion';
import { ChoiceCards, ToggleRow } from '../ui';

interface ThemeSelectorProps {
  currentTheme?: ThemeId;
  onThemeChange?: (theme: ThemeId) => void;
}

/**
 * Settings › Appearance › the settings that change how Glass is drawn.
 *
 * Glass is the only look (docs/glass-spec.md), so there is no palette to pick,
 * no accent and no base color: what is live in the current server supplies the
 * color. What is left is what a person may need in order to read it:
 *
 *   High contrast         a second theme (`glass-contrast`), synced with the account
 *   Reduced transparency  per device; `glass.css` reads `data-reduced-transparency`
 *   Reduced motion        per device; the one switch in `lib/motion/reducedMotion`
 *
 * Custom CSS lives beside this in Settings, not here. `lib/themes.ts` owns the
 * ids and `hooks/useTheme.ts` writes the attributes; this only reads and sets
 * the stored choices.
 */
const TRANSPARENCY_OPTIONS: Array<{ id: TransparencyPreference; label: string; hint: string }> = [
  { id: 'system', label: 'Match my system', hint: 'Follow this device’s reduce-transparency setting' },
  { id: 'standard', label: 'Standard', hint: 'Panels are near-solid, with a hint of what is live behind them' },
  { id: 'reduced', label: 'Reduced', hint: 'Panels are fully solid and nothing is see-through' },
];

const MOTION_OPTIONS: Array<{ id: MotionPreference; label: string; hint: string }> = [
  { id: 'system', label: 'Match my system', hint: 'Follow this device’s reduced-motion setting' },
  { id: 'full', label: 'Full motion', hint: 'Views glide into place and the talking waveform moves' },
  { id: 'reduced', label: 'Reduced motion', hint: 'Views cross-fade quickly and nothing loops' },
];

export function ThemeSelector({ currentTheme, onThemeChange }: ThemeSelectorProps) {
  const storeTheme = useUIStore((state) => state.theme);
  const setTheme = useUIStore((state) => state.setTheme);
  const transparency = useUIStore((state) => state.transparency);
  const setTransparency = useUIStore((state) => state.setTransparency);
  const motion = useUIStore((state) => state.motion);
  const setMotion = useUIStore((state) => state.setMotion);
  const reduced = useReducedMotion();
  const theme = asThemeId(currentTheme ?? storeTheme);
  const contrastLabelId = useId();
  const transparencyLabelId = useId();
  const motionLabelId = useId();

  const pickTheme = (next: ThemeId) => {
    setTheme(next);
    onThemeChange?.(next);
  };

  const setHighContrast = (on: boolean) => {
    const next = on ? HIGH_CONTRAST_THEME : DEFAULT_THEME;
    // Changing the theme is the lights changing (§5.1): the whole shell
    // crosses over and the theme is applied INSIDE the crossfade, by
    // `useTheme`'s effect, which is why the engine is told how to recognize
    // that it landed. Under reduced motion `changeLights` simply calls this
    // and returns.
    void changeLights(() => pickTheme(next), {
      applied: () => document.documentElement.getAttribute('data-theme') === next,
    });
  };

  return (
    <div className="flex flex-col gap-7">
      <section aria-labelledby={contrastLabelId}>
        <h3 id={contrastLabelId} className="mb-1 text-section text-text-secondary">
          Contrast
        </h3>
        <ToggleRow
          label="High contrast"
          description="Brighter text, solid panels and a clear outline around every surface."
          checked={theme === HIGH_CONTRAST_THEME}
          onChange={setHighContrast}
          className="py-2"
        />
      </section>

      <section aria-labelledby={transparencyLabelId}>
        <h3 id={transparencyLabelId} className="mb-3 text-section text-text-secondary">
          Transparency
        </h3>
        <ChoiceCards
          labeledBy={transparencyLabelId}
          options={TRANSPARENCY_OPTIONS}
          value={transparency}
          onChange={setTransparency}
          layout="row"
        />
        <p className="mt-3 max-w-prose text-meta leading-relaxed text-text-faint">
          Reduced makes every panel fully solid, so nothing shows through.
        </p>
      </section>

      <section aria-labelledby={motionLabelId}>
        <h3 id={motionLabelId} className="mb-3 text-section text-text-secondary">
          Motion
        </h3>
        <ChoiceCards
          labeledBy={motionLabelId}
          options={MOTION_OPTIONS}
          value={motion}
          onChange={setMotion}
          layout="row"
        />
        <p className="mt-3 max-w-prose text-meta leading-relaxed text-text-faint">
          {reduced
            ? 'Motion is reduced right now: views fade quickly, and the waveform and floating reactions hold still.'
            : 'Motion is on right now. Only what is live, and what you do, ever moves.'}
        </p>
      </section>
    </div>
  );
}
