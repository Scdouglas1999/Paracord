import { Moon, Sun, Monitor, Eye, Check } from 'lucide-react';
import { useUIStore, type AccentPreset } from '../../stores/uiStore';
import { ACCENT_PRESETS } from '../../hooks/useTheme';
import { cn } from '../../lib/utils';

type ThemeId = 'dark' | 'light' | 'amoled' | 'high-contrast';

interface ThemeSelectorProps {
  currentTheme?: ThemeId;
  onThemeChange?: (theme: ThemeId) => void;
}

// Representative surface hexes per theme. A preview must render OTHER themes' colors
// while the app is in the current one, so live CSS vars can't be used here — these
// mirror the surface ramp each theme defines in tokens.css / useTheme.ts. The accent
// bar reads the live --accent-primary so the swatch reflects the chosen preset too.
const THEME_SWATCH: Record<ThemeId, { base: string; raised: string; line: string }> = {
  dark: { base: '#141b17', raised: '#1b241f', line: 'rgba(234, 242, 237, 0.34)' },
  light: { base: '#eef1ec', raised: '#ffffff', line: 'rgba(20, 27, 23, 0.30)' },
  amoled: { base: '#000000', raised: '#0c0f0d', line: 'rgba(234, 242, 237, 0.32)' },
  'high-contrast': { base: '#000000', raised: '#0a0a0a', line: 'rgba(255, 255, 255, 0.55)' },
};

const THEME_OPTIONS: Array<{
  id: ThemeId;
  label: string;
  hint: string;
  icon: React.ReactNode;
}> = [
  { id: 'dark', label: 'Dark', hint: 'The warm emerald default', icon: <Moon size={16} /> },
  { id: 'light', label: 'Light', hint: 'Warm paper, green undertone', icon: <Sun size={16} /> },
  { id: 'amoled', label: 'AMOLED', hint: 'True black for OLED panels', icon: <Monitor size={16} /> },
  { id: 'high-contrast', label: 'High Contrast', hint: 'Maximum legibility', icon: <Eye size={16} /> },
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

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-3 text-section uppercase text-text-secondary">{children}</div>;
}

/** A miniature app frame — sidebar + main pane — painted in a theme's real surfaces. */
function ThemeSwatch({ id }: { id: ThemeId }) {
  const sw = THEME_SWATCH[id];
  return (
    <div className="mb-3 flex h-16 gap-1.5 rounded-sm p-1.5" style={{ background: sw.base }}>
      <div className="flex w-1/3 flex-col gap-1 rounded-[4px] p-1" style={{ background: sw.raised }}>
        <div className="h-1.5 w-full rounded-full" style={{ background: 'var(--accent-primary)' }} />
        <div className="h-1 w-3/4 rounded-full" style={{ background: sw.line }} />
        <div className="h-1 w-2/3 rounded-full" style={{ background: sw.line }} />
      </div>
      <div className="flex flex-1 flex-col gap-1 rounded-[4px] p-1" style={{ background: sw.raised }}>
        <div className="h-1 w-full rounded-full" style={{ background: sw.line }} />
        <div className="h-1 w-5/6 rounded-full" style={{ background: sw.line }} />
        <div className="mt-auto h-2 w-9 rounded-full" style={{ background: 'var(--accent-primary)' }} />
      </div>
    </div>
  );
}

export function ThemeSelector({ currentTheme, onThemeChange }: ThemeSelectorProps) {
  const storeTheme = useUIStore((state) => state.theme);
  const setTheme = useUIStore((state) => state.setTheme);
  const accentPreset = useUIStore((state) => state.accentPreset);
  const setAccentPreset = useUIStore((state) => state.setAccentPreset);
  const theme = currentTheme ?? storeTheme;

  return (
    <div className="space-y-7">
      <div>
        <div className="grid grid-cols-2 gap-3">
          {THEME_OPTIONS.map((option) => {
            const active = theme === option.id;
            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  setTheme(option.id);
                  onThemeChange?.(option.id);
                }}
                className={cn(
                  'rounded-md p-2.5 text-left transition-[background-color,box-shadow,border-color] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary focus-visible:ring-offset-2 focus-visible:ring-offset-bg-secondary',
                  active
                    ? 'bg-accent-tint shadow-[inset_0_0_0_2px_var(--accent-primary)]'
                    : 'border border-border-subtle bg-bg-tertiary hover:border-border-strong',
                )}
              >
                <ThemeSwatch id={option.id} />
                <div className="flex items-center gap-2">
                  <span className={cn('shrink-0', active ? 'text-accent-primary' : 'text-text-muted')}>
                    {option.icon}
                  </span>
                  <span className="text-label font-semibold text-text-primary">{option.label}</span>
                  {active && <Check size={15} className="ml-auto text-accent-primary" />}
                </div>
                <div className="mt-0.5 text-meta text-text-muted">{option.hint}</div>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <FieldLabel>Accent Color</FieldLabel>
        <div className="flex flex-wrap items-center gap-2.5">
          {(Object.keys(ACCENT_PRESETS) as AccentPreset[]).map((preset) => {
            const selected = accentPreset === preset;
            return (
              <button
                key={preset}
                type="button"
                onClick={() => setAccentPreset(preset)}
                className={cn(
                  'theme-accent-chip relative flex h-8 w-8 items-center justify-center rounded-full transition-transform duration-150 hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary focus-visible:ring-offset-2 focus-visible:ring-offset-bg-secondary',
                  `theme-accent-chip-${preset}`,
                  selected && 'shadow-[0_0_0_2px_var(--bg-secondary),0_0_0_4px_var(--text-primary)]',
                )}
                title={ACCENT_LABELS[preset]}
                aria-label={`Set accent ${ACCENT_LABELS[preset]}`}
                aria-pressed={selected}
              >
                {selected && <Check size={14} className="text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.5)]" />}
              </button>
            );
          })}
        </div>
        <p className="mt-2.5 text-meta text-text-muted">
          The accent drives primary buttons, active navigation, mentions, and focus rings. Teal brand
          moments stay fixed.
        </p>
      </div>
    </div>
  );
}
