import { useId } from 'react';
import { Moon, Sun, Monitor, Eye, Check } from 'lucide-react';
import { useUIStore, type AccentPreset } from '../../stores/uiStore';
import { ACCENT_PRESETS, BASE_HUE_PRESETS, type BaseHuePreset } from '../../hooks/useTheme';
import { changeLights, useReducedMotion, type MotionPreference } from '../../lib/motion';
import { cn } from '../../lib/utils';

type ThemeId = 'dark' | 'light' | 'amoled' | 'high-contrast';

interface ThemeSelectorProps {
  currentTheme?: ThemeId;
  onThemeChange?: (theme: ThemeId) => void;
}

/**
 * The four themes `useTheme` actually supports (docs/lantern-stage-spec.md §1.7).
 * There is no fifth: `useTheme` narrows anything else to Night.
 */
const THEME_OPTIONS: Array<{
  id: ThemeId;
  label: string;
  hint: string;
  icon: React.ReactNode;
}> = [
  { id: 'dark', label: 'Night', hint: 'The default — lit windows after dark', icon: <Moon size={16} /> },
  { id: 'light', label: 'Daylight', hint: 'Warm paper; lit channels read as ink', icon: <Sun size={16} /> },
  { id: 'amoled', label: 'AMOLED', hint: 'A true-black street for OLED panels', icon: <Monitor size={16} /> },
  { id: 'high-contrast', label: 'High contrast', hint: 'Thicker rims, two text steps', icon: <Eye size={16} /> },
];

/**
 * Motion (docs/lantern-stage-spec.md §5.3). The app moves for two reasons only —
 * light, and something a person did — so the choice is about how much of that
 * you want, not about switching a decoration off.
 */
const MOTION_OPTIONS: Array<{ id: MotionPreference; label: string; hint: string }> = [
  { id: 'system', label: 'Match my system', hint: 'Follow this device\u2019s reduced-motion setting' },
  { id: 'full', label: 'Full motion', hint: 'Lights bloom, messages lift, channels move' },
  { id: 'reduced', label: 'Reduced motion', hint: 'Everything lands instantly; lights still change' },
];

const ACCENT_LABELS: Record<AccentPreset, string> = {
  red: 'Red',
  blue: 'Blue',
  emerald: 'Emerald',
  amber: 'Amber',
  rose: 'Rose',
  violet: 'Violet',
  cyan: 'Cyan',
  lime: 'Lime',
  orange: 'Orange',
  slate: 'Slate',
};

/**
 * A miniature street-and-plates, painted in the theme it advertises.
 *
 * `data-theme` is the real mechanism, not a mock: `tokens.css` re-substitutes
 * the whole `--color-*` namespace on any `[data-theme]` subtree, so every
 * surface, ink, shadow and light recipe below resolves to that theme's own
 * values. Judge a theme on shapes and on the two lights, not on swatches.
 *
 * Every theme resolves a complete set here: `tokens.css` declares Night's
 * literals for `:root` and for each dark theme's own attribute, so a preview is
 * exact no matter which theme the app is currently in.
 */
function ThemePreview({ id }: { id: ThemeId }) {
  return (
    <div
      data-theme={id}
      aria-hidden
      className="pointer-events-none flex h-16 gap-1.5 rounded-[var(--radius-well)] bg-bg-base p-1.5"
    >
      <div className="flex w-1/3 flex-col justify-between rounded-[var(--radius-window)] bg-bg-plate p-1.5 shadow-[var(--shadow-tile)]">
        <span className="flex gap-[3px]">
          <span className="pc-window is-talking h-[13px] w-[10px]" />
          <span className="pc-window is-reading h-[13px] w-[10px]" />
          <span className="pc-window h-[13px] w-[10px]" />
        </span>
        <span className="h-1 w-3/4 rounded-[var(--radius-full)] bg-text-faint" />
      </div>
      <div className="flex flex-1 flex-col justify-between rounded-[var(--radius-window)] bg-bg-plate p-1.5 shadow-[var(--shadow-tile)]">
        <span className="h-1 w-full rounded-[var(--radius-full)] bg-text-primary" />
        <span className="h-1 w-5/6 rounded-[var(--radius-full)] bg-text-faint" />
        <span className="h-2 w-9 rounded-[var(--radius-chip)] bg-accent-primary" />
      </div>
    </div>
  );
}

/**
 * A base-colour preset, painted in the theme you are actually in.
 *
 * Not a swatch: the base colour is not one colour, it is a whole ramp, and the
 * only honest preview of it is the ramp. `data-theme` plus the two custom
 * properties is the real mechanism — `tokens.css` re-resolves every surface on
 * a `[data-theme]` subtree, and each one reads the `--ui-hue` / `--ui-chroma`
 * declared right here — so these three bars are the app's own grounds at that
 * setting, not an approximation of them.
 */
function BasePreview({ theme, hue, tint }: { theme: ThemeId; hue: number; tint: number }) {
  return (
    <div
      data-theme={theme}
      aria-hidden
      style={{ '--ui-hue': String(hue), '--ui-chroma': String(tint) } as React.CSSProperties}
      className="flex h-9 w-full gap-1 rounded-[var(--radius-well)] bg-bg-base p-1.5"
    >
      <span className="w-1/4 rounded-[var(--radius-window)] bg-bg-well" />
      <span className="flex-1 rounded-[var(--radius-window)] bg-bg-plate" />
      <span className="w-1/4 rounded-[var(--radius-window)] bg-bg-raised" />
    </div>
  );
}

export function ThemeSelector({ currentTheme, onThemeChange }: ThemeSelectorProps) {
  const storeTheme = useUIStore((state) => state.theme);
  const setTheme = useUIStore((state) => state.setTheme);
  const accentPreset = useUIStore((state) => state.accentPreset);
  const setAccentPreset = useUIStore((state) => state.setAccentPreset);
  const motion = useUIStore((state) => state.motion);
  const setMotion = useUIStore((state) => state.setMotion);
  const baseHue = useUIStore((state) => state.baseHue);
  const baseTint = useUIStore((state) => state.baseTint);
  const setBaseHue = useUIStore((state) => state.setBaseHue);
  const setBaseTint = useUIStore((state) => state.setBaseTint);
  const reduced = useReducedMotion();
  const theme = currentTheme ?? storeTheme;
  const themeLabelId = useId();
  const baseLabelId = useId();
  const hueSliderId = useId();
  const accentLabelId = useId();
  const motionLabelId = useId();
  // A preset with no tint is chosen by its tint alone: at chroma 0 the hue
  // stops meaning anything, so an Ash at 245 degrees is still Ash.
  const activePreset = (Object.keys(BASE_HUE_PRESETS) as BaseHuePreset[]).find((name) => {
    const preset = BASE_HUE_PRESETS[name];
    return preset.tint === 0 ? baseTint === 0 : baseTint === preset.tint && baseHue === preset.hue;
  });

  return (
    <div className="flex flex-col gap-7">
      <section aria-labelledby={themeLabelId}>
        <h3 id={themeLabelId} className="mb-3 text-section text-text-secondary">
          Theme
        </h3>
        <div className="grid gap-3 sm:grid-cols-2">
          {THEME_OPTIONS.map((option) => {
            const active = theme === option.id;
            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  // §5.1, WP9d: changing the theme is the lights changing. The
                  // whole shell crosses over `--duration-dim` and the light
                  // elements re-bloom behind it — and the theme itself is
                  // applied INSIDE the crossfade, by `useTheme`'s effect, which
                  // is why the engine is told how to recognise that it landed
                  // rather than guessing at a number of frames. Under reduced
                  // motion `changeLights` simply calls this and returns.
                  void changeLights(
                    () => {
                      setTheme(option.id);
                      onThemeChange?.(option.id);
                    },
                    {
                      applied: () =>
                        document.documentElement.getAttribute('data-theme') === option.id,
                    },
                  );
                }}
                className={cn(
                  'pc-focusable flex flex-col rounded-[var(--radius-card)] p-2.5 text-left',
                  'transition-[background-color,box-shadow] duration-[var(--duration-fast)] ease-[var(--ease-out)]',
                  active
                    ? // The chosen theme is raised, with the warm top highlight
                      // and an emerald edge — plus the word "Selected" below, so
                      // the state is never carried by colour alone (spec §9).
                      'bg-bg-raised shadow-[var(--shadow-raised),0_0_0_1px_var(--accent-primary)]'
                    : 'bg-bg-mod-subtle hover:bg-bg-mod-strong',
                )}
              >
                <ThemePreview id={option.id} />
                <span className="mt-3 flex items-center gap-2">
                  <span
                    className={cn('shrink-0', active ? 'text-accent-primary' : 'text-text-muted')}
                    aria-hidden
                  >
                    {option.icon}
                  </span>
                  <span className="pc-display text-name text-text-primary">{option.label}</span>
                  {active && (
                    <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-meta font-semibold text-accent-primary">
                      <Check size={14} aria-hidden />
                      Selected
                    </span>
                  )}
                </span>
                <span className="mt-0.5 text-meta leading-relaxed text-text-faint">
                  {option.hint}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section aria-labelledby={baseLabelId}>
        <h3 id={baseLabelId} className="mb-3 text-section text-text-secondary">
          Base color
        </h3>
        <div className="grid gap-2.5 sm:grid-cols-3">
          {(Object.keys(BASE_HUE_PRESETS) as BaseHuePreset[]).map((name) => {
            const preset = BASE_HUE_PRESETS[name];
            const active = activePreset === name;
            return (
              <button
                key={name}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  setBaseHue(preset.hue);
                  setBaseTint(preset.tint);
                }}
                className={cn(
                  'pc-focusable flex flex-col rounded-[var(--radius-card)] p-2.5 text-left',
                  'transition-[background-color,box-shadow] duration-[var(--duration-fast)] ease-[var(--ease-out)]',
                  active
                    ? 'bg-bg-raised shadow-[var(--shadow-raised),0_0_0_1px_var(--accent-primary)]'
                    : 'bg-bg-mod-subtle hover:bg-bg-mod-strong',
                )}
              >
                <BasePreview theme={theme} hue={preset.hue} tint={preset.tint} />
                <span className="mt-2.5 flex items-center gap-2">
                  <span className="pc-display text-name text-text-primary">{preset.label}</span>
                  {active && (
                    <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-meta font-semibold text-accent-primary">
                      <Check size={14} aria-hidden />
                      Selected
                    </span>
                  )}
                </span>
                <span className="mt-0.5 text-meta leading-relaxed text-text-faint">
                  {preset.hint}
                </span>
              </button>
            );
          })}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <label htmlFor={hueSliderId} className="text-label text-text-secondary">
            Any other color
          </label>
          <input
            id={hueSliderId}
            type="range"
            min={0}
            max={359}
            step={1}
            value={baseHue}
            onChange={(event) => {
              setBaseHue(Number(event.target.value));
              // Moving the hue while the tint is off would do nothing at all
              // and look broken. Reaching for this control means you want a
              // colour, so it turns the tint back on.
              if (baseTint === 0) setBaseTint(1);
            }}
            className="pc-focusable h-[var(--h-control)] w-48 accent-accent-primary"
            aria-describedby={`${hueSliderId}-hint`}
          />
          <span className="pc-mono w-12 text-meta text-text-faint">{baseHue}&deg;</span>
          <span aria-hidden className="ml-1 block w-28 shrink-0">
            <BasePreview theme={theme} hue={baseHue} tint={baseTint} />
          </span>
        </div>
        <p id={`${hueSliderId}-hint`} className="mt-3 max-w-prose text-meta leading-relaxed text-text-faint">
          The base color is every surface, hairline, wash and grey the app paints — nothing else
          moves with it. The light that shows who is in a channel, the emerald that means an action
          you can take, warnings and danger, and the color a person or a server wears all stay
          exactly where they are. Every setting keeps the same contrast, because only the hue
          changes and never the lightness. High contrast takes it in the chrome only — the two
          extremes that do its legibility work never tint at all.
        </p>
      </section>

      <section aria-labelledby={accentLabelId}>
        <h3 id={accentLabelId} className="mb-3 text-section text-text-secondary">
          Accent color
        </h3>
        <div className="flex flex-wrap items-center gap-2.5">
          {(Object.keys(ACCENT_PRESETS) as AccentPreset[]).map((preset) => {
            const selected = accentPreset === preset;
            return (
              <button
                key={preset}
                type="button"
                onClick={() => setAccentPreset(preset)}
                className={cn(
                  // A swatch is one of the three shapes allowed to be round, and
                  // the one place a literal colour is legitimate: it has to paint
                  // the preset's own value to be a swatch at all (spec §1.7).
                  'pc-focusable h-11 w-11 shrink-0 rounded-[var(--radius-full)] sm:h-8 sm:w-8',
                  'transition-transform duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:scale-110',
                  selected &&
                    'shadow-[0_0_0_2px_var(--bg-plate),0_0_0_4px_var(--text-primary)]',
                )}
                style={{ backgroundColor: ACCENT_PRESETS[preset] }}
                title={ACCENT_LABELS[preset]}
                aria-label={`Set accent ${ACCENT_LABELS[preset]}`}
                aria-pressed={selected}
              />
            );
          })}
        </div>
        <p className="mt-3 text-meta text-text-secondary">
          Selected: {ACCENT_LABELS[accentPreset]}.
        </p>
        <p className="mt-1 max-w-prose text-meta leading-relaxed text-text-faint">
          The accent drives primary buttons, active navigation, mentions and focus rings. The
          light that shows who is in a channel never changes colour.
        </p>
      </section>

      <section aria-labelledby={motionLabelId}>
        <h3 id={motionLabelId} className="mb-3 text-section text-text-secondary">
          Motion
        </h3>
        <div
          role="radiogroup"
          aria-labelledby={motionLabelId}
          className="flex flex-col gap-2 sm:flex-row"
        >
          {MOTION_OPTIONS.map((option) => {
            const active = motion === option.id;
            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setMotion(option.id)}
                className={cn(
                  'pc-focusable flex flex-1 flex-col gap-0.5 rounded-[var(--radius-card)] p-3 text-left',
                  'transition-[background-color,box-shadow] duration-[var(--duration-fast)] ease-[var(--ease-out)]',
                  active
                    ? 'bg-bg-raised shadow-[var(--shadow-raised),0_0_0_1px_var(--accent-primary)]'
                    : 'bg-bg-mod-subtle hover:bg-bg-mod-strong',
                )}
              >
                <span className="flex items-center gap-2">
                  <span className="pc-display text-name text-text-primary">{option.label}</span>
                  {active && (
                    <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-meta font-semibold text-accent-primary">
                      <Check size={14} aria-hidden />
                      Selected
                    </span>
                  )}
                </span>
                <span className="text-meta leading-relaxed text-text-faint">{option.hint}</span>
              </button>
            );
          })}
        </div>
        <p className="mt-3 max-w-prose text-meta leading-relaxed text-text-faint">
          {reduced
            ? 'Motion is off right now: nothing lifts, slides or flickers, and lights change without a fade.'
            : 'Motion is on right now. Only light and the things people do ever move — nothing decorative.'}
        </p>
      </section>
    </div>
  );
}
