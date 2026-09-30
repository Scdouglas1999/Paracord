import { useEffect, useRef } from 'react';
import { useUIStore } from '../stores/uiStore';
import { useAuthStore } from '../stores/authStore';
import { configureMotion } from '../lib/motion/reducedMotion';
import { sanitizeCustomCss } from '../lib/security';
import { clearCustomCss, renderCustomCss } from '../lib/customCss';
import { toast } from '../stores/toastStore';
import { logVoiceDiagnostic } from '../lib/desktopDiagnostics';
import { reportGroundColor } from '../lib/nativeGround';
import { asThemeId, migrateThemeId, type ThemeId } from '../lib/themes';

/** The device's own "reduce transparency" setting. Unsupported → never matches. */
const SYSTEM_REDUCED_TRANSPARENCY = '(prefers-reduced-transparency: reduce)';

/**
 * Applies the theme, reduced transparency, motion, density, low-bandwidth mode
 * and the user's custom CSS to the document root.
 *
 * The theme itself is one attribute: `data-theme` (`glass` or
 * `glass-contrast`). Every surface, shadow, glow and ring for each is declared
 * in `src/styles/tokens.css`, so there is exactly one place a color is written
 * down, and this hook writes no color of its own. Reduced transparency is one
 * more attribute, `data-reduced-transparency`, which `glass.css` reads.
 */
export function useTheme() {
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);
  const transparency = useUIStore((s) => s.transparency);
  const lowBandwidthMode = useUIStore((s) => s.lowBandwidthMode);
  const motion = useUIStore((s) => s.motion);
  const customCss = useUIStore((s) => s.customCss);
  const setCustomCss = useUIStore((s) => s.setCustomCss);
  const settings = useAuthStore((s) => s.settings);
  const initializedFromServer = useRef(false);

  // Hydrate local theme once from server settings so user changes apply immediately.
  useEffect(() => {
    if (!settings) {
      initializedFromServer.current = false;
      return;
    }
    if (!initializedFromServer.current) {
      // The server stores the theme as an opaque string, and an account that
      // last chose one of the retired looks still holds that id there. A
      // retired id becomes `glass` (or `glass-contrast`, for `high-contrast`);
      // a value that is not a theme at all leaves the local choice alone.
      const fromServer = migrateThemeId(settings.theme);
      if (fromServer) {
        setTheme(fromServer);
      }
      initializedFromServer.current = true;
    }
  }, [settings, setTheme]);

  // Persisted state can outlive the build that wrote it: anything unrecognized
  // is Glass rather than a document with no theme at all.
  const activeTheme: ThemeId = asThemeId(theme);
  // Message density has a single source of truth: the server-synced
  // message_display_compact setting (surfaced in Settings › Appearance › Display).
  const densityMode = settings?.message_display_compact ? 'compact' : 'default';

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', activeTheme);
  }, [activeTheme]);

  // Reduced transparency (docs/glass-spec.md §4). One attribute, always
  // written as 'true' or 'false' so nothing has to treat "absent" as a third
  // case; `glass.css` turns it into opaque panes. `system` follows the
  // device's own setting and keeps following it while it changes.
  useEffect(() => {
    const root = document.documentElement;
    const publish = (reduced: boolean) =>
      root.setAttribute('data-reduced-transparency', reduced ? 'true' : 'false');
    if (transparency !== 'system') {
      publish(transparency === 'reduced');
      return;
    }
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      publish(false);
      return;
    }
    const query = window.matchMedia(SYSTEM_REDUCED_TRANSPARENCY);
    publish(query.matches);
    const onChange = (event: MediaQueryListEvent) => publish(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [transparency]);

  // §5.3's one switch. The stored preference is the only thing that reaches it;
  // the OS media query is read inside `configureMotion`, never here, and the
  // answer is published as `data-motion` on <html> for CSS to follow.
  useEffect(() => {
    configureMotion(motion);
  }, [motion]);

  useEffect(() => {
    document.documentElement.setAttribute('data-density', densityMode);
  }, [densityMode]);

  useEffect(() => {
    document.documentElement.setAttribute(
      'data-low-bandwidth',
      lowBandwidthMode ? 'true' : 'false'
    );
  }, [lowBandwidthMode]);

  // The committed custom CSS, rendered through the same single stylesheet the
  // Settings preview drives. A refusal (the document's CSP declining an
  // injected stylesheet) is reported rather than left as a silent no-op —
  // Settings shows it to the user, this records it for a bug report.
  useEffect(() => {
    const css = sanitizeCustomCss(settings?.custom_css || customCss || '');
    if (!renderCustomCss(css)) {
      logVoiceDiagnostic('[theme] custom css refused by the document', { length: css.length });
    }
  }, [customCss, settings?.custom_css]);

  // The way back. Custom CSS runs against the whole interface, and while the
  // sanitizer allows no layout or visibility properties, a transparent color
  // or a zeroed font size is enough that somebody cannot find Settings again to
  // undo it. Ctrl+Alt+Shift+C removes it without needing to read the screen.
  // (Instance-wide CSS is an administrator's, not something a person pasted
  // here, and is left alone.)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || !event.altKey || !event.shiftKey) return;
      if (event.code !== 'KeyC') return;
      event.preventDefault();
      setCustomCss('');
      clearCustomCss();
      toast.success('Custom CSS removed.');
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [setCustomCss]);

  // …and the desktop shell is told what all of that came out as. The GTK
  // toplevel is what shows through wherever the DOM is transparent over a
  // native video underlay, so it has to be painted the ground the person
  // actually chose rather than a color compiled into the shell. LAST of the
  // appearance effects on purpose: by the time it runs, <html> carries the new
  // theme and the committed custom CSS — which can redefine `--bg-base`
  // itself — so what it reads is the ground as it will be drawn. See
  // `lib/nativeGround.ts`.
  useEffect(() => {
    void reportGroundColor();
  }, [activeTheme, customCss, settings?.custom_css]);

  return { theme: activeTheme };
}
