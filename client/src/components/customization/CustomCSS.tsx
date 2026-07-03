import { useState, useEffect, useRef } from 'react';
import { RotateCcw, Save } from 'lucide-react';
import { sanitizeCustomCss } from '../../lib/security';

// Shared with useTheme(): the single <style> element that owns rendered custom CSS.
const CUSTOM_CSS_STYLE_ID = 'paracord-custom-css';

// Mirrors the at-rule stripping in sanitizeCustomCss(); used to detect (not perform) drops.
const AT_RULE_RE = /@[^{;]+(?:;|\{[^}]*\})/g;

// Count structurally valid `prop: value` declarations across all rule blocks, ignoring
// whether the sanitizer's allow/block lists keep them. Comparing this count before and
// after sanitization reveals whether real declarations were dropped, independent of the
// reformatting sanitizeCustomCss() applies to every surviving rule.
function countDeclarations(css: string): number {
  let count = 0;
  const ruleRegex = /[^{}]+\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = ruleRegex.exec(css)) !== null) {
    for (const declaration of match[1].split(';')) {
      const idx = declaration.indexOf(':');
      if (idx <= 0) continue;
      if (declaration.slice(0, idx).trim() && declaration.slice(idx + 1).trim()) {
        count += 1;
      }
    }
  }
  return count;
}

// True only when sanitization actually removed content (an at-rule was stripped, or a
// declaration/rule was dropped) — not when it merely reformatted safe input.
function sanitizationDroppedContent(source: string, sanitized: string): boolean {
  const trimmed = source.trim();
  if (!trimmed) return false;
  const droppedAtRule = trimmed.replace(AT_RULE_RE, '') !== trimmed;
  const droppedDeclarations = countDeclarations(trimmed) > countDeclarations(sanitized);
  return droppedAtRule || droppedDeclarations;
}

interface CustomCSSProps {
  initialCSS?: string;
  onSave?: (css: string) => void;
}

export function CustomCSS({ initialCSS = '', onSave }: CustomCSSProps) {
  const [css, setCss] = useState(initialCSS);
  const [saved, setSaved] = useState(false);
  const [sanitized, setSanitized] = useState(false);
  const initialCssRef = useRef(initialCSS);

  useEffect(() => {
    initialCssRef.current = initialCSS;
  }, [initialCSS]);

  // Live preview: drive the single theme-owned <style> element (shared with useTheme),
  // never a competing private element.
  useEffect(() => {
    const safeCss = sanitizeCustomCss(css);
    setSanitized(sanitizationDroppedContent(css, safeCss));

    let styleEl = document.getElementById(CUSTOM_CSS_STYLE_ID) as HTMLStyleElement | null;
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = CUSTOM_CSS_STYLE_ID;
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = safeCss;
  }, [css]);

  // On unmount, discard unsaved preview and restore the committed value so custom CSS the
  // user actually saved (rendered via useTheme from the same source) survives.
  useEffect(() => {
    return () => {
      const styleEl = document.getElementById(CUSTOM_CSS_STYLE_ID) as HTMLStyleElement | null;
      if (!styleEl) return;
      const committed = sanitizeCustomCss(initialCssRef.current);
      if (committed) {
        styleEl.textContent = committed;
      } else {
        styleEl.remove();
      }
    };
  }, []);

  const handleSave = () => {
    onSave?.(sanitizeCustomCss(css));
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleReset = () => {
    setCss('');
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-xs font-bold uppercase" style={{ color: 'var(--text-secondary)' }}>
            Custom CSS
          </div>
          <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
            Changes are previewed live. Save to persist.
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleReset}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium transition-colors"
            style={{
              backgroundColor: 'var(--bg-accent)',
              color: 'var(--text-secondary)',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text-primary)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-secondary)'; }}
          >
            <RotateCcw size={14} />
            Reset
          </button>
          <button
            onClick={handleSave}
            aria-label={saved ? 'Custom CSS saved' : 'Save custom CSS'}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium text-white transition-colors"
            style={{ backgroundColor: saved ? 'var(--accent-success)' : 'var(--accent-primary)' }}
          >
            <Save size={14} />
            {saved ? 'Saved!' : 'Save'}
          </button>
        </div>
      </div>

      <textarea
        value={css}
        onChange={(e) => setCss(e.target.value)}
        placeholder={`/* Enter custom CSS here */\n\n/* Example: Change background color */\n:root {\n  --bg-primary: #1a1a2e;\n}`}
        rows={16}
        className="w-full rounded-lg p-4 text-sm outline-none resize-y"
        style={{
          backgroundColor: 'var(--bg-tertiary)',
          color: 'var(--text-primary)',
          border: '1px solid var(--border-subtle)',
          fontFamily: 'var(--font-code)',
          lineHeight: '1.5',
          tabSize: 2,
          minHeight: '200px',
        }}
        onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent-primary)'; }}
        onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border-subtle)'; }}
        spellCheck={false}
      />

      <div className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
        Note: Server administrators can also set server-wide CSS that applies to all members in that server.
      </div>
      {sanitized && (
        <div className="mt-1 text-xs" style={{ color: 'var(--accent-danger)' }}>
          Unsafe CSS directives were removed from preview and save output.
        </div>
      )}
    </div>
  );
}
