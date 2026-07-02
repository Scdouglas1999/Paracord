import { Moon, Sun, Monitor, Eye, Check } from 'lucide-react';
import { useUIStore, type AccentPreset } from '../../stores/uiStore';
import { ACCENT_PRESETS } from '../../hooks/useTheme';
import { cn } from '../../lib/utils';

type ThemeId = 'dark' | 'light' | 'amoled' | 'high-contrast';

interface ThemeSelectorProps {
  currentTheme?: ThemeId;
  onThemeChange?: (theme: ThemeId) => void;
}

const THEME_OPTIONS: Array<{
  id: ThemeId;
  label: string;
  icon: React.ReactNode;
  previewClass: string;
}> = [
  {
    id: 'dark',
    label: 'Dark',
    icon: <Moon size={18} />,
    previewClass: 'theme-preview-dark',
  },
  {
    id: 'light',
    label: 'Light',
    icon: <Sun size={18} />,
    previewClass: 'theme-preview-light',
  },
  {
    id: 'amoled',
    label: 'AMOLED',
    icon: <Monitor size={18} />,
    previewClass: 'theme-preview-amoled',
  },
  {
    id: 'high-contrast',
    label: 'High Contrast',
    icon: <Eye size={18} />,
    previewClass: 'theme-preview-high-contrast',
  },
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

export function ThemeSelector({ currentTheme, onThemeChange }: ThemeSelectorProps) {
  const storeTheme = useUIStore((state) => state.theme);
  const setTheme = useUIStore((state) => state.setTheme);
  const accentPreset = useUIStore((state) => state.accentPreset);
  const setAccentPreset = useUIStore((state) => state.setAccentPreset);
  const theme = currentTheme ?? storeTheme;

  return (
    <div className="space-y-6">
      <div>
        <div className="mb-3 text-xs font-bold uppercase text-text-secondary">Theme</div>
        <div className="grid grid-cols-2 gap-2">
          {THEME_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => {
                setTheme(option.id);
                onThemeChange?.(option.id);
              }}
              className={`rounded-xl border p-2 text-left transition-colors ${
                theme === option.id
                  ? 'border-accent-primary bg-accent-primary/12'
                  : 'border-border-subtle bg-bg-mod-subtle/40 hover:bg-bg-mod-subtle'
              }`}
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="text-text-secondary">{option.icon}</span>
                {theme === option.id && <Check size={14} className="text-accent-primary" />}
              </div>
              <div
                className={`mb-2 h-8 rounded-md border border-border-subtle/50 ${option.previewClass}`}
              />
              <div className="text-xs font-semibold text-text-primary">{option.label}</div>
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-3 text-xs font-bold uppercase text-text-secondary">Accent Color</div>
        <div className="flex flex-wrap gap-2">
          {(Object.keys(ACCENT_PRESETS) as AccentPreset[]).map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => setAccentPreset(preset)}
              className={cn(
                'theme-accent-chip relative h-9 w-9 rounded-full border-2 transition-transform hover:scale-105',
                `theme-accent-chip-${preset}`,
                accentPreset === preset ? 'theme-accent-chip-selected' : 'theme-accent-chip-unselected',
              )}
              title={ACCENT_LABELS[preset]}
              aria-label={`Set accent ${ACCENT_LABELS[preset]}`}
            >
              {accentPreset === preset && (
                <span className="absolute inset-0 flex items-center justify-center text-white">
                  <Check size={14} />
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
