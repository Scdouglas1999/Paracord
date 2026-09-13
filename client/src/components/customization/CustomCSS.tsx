import { useState, useEffect, useRef } from 'react';
import { RotateCcw, Save, ShieldAlert, Code2, AlertTriangle } from 'lucide-react';
import { sanitizeCustomCss } from '../../lib/security';
import { toast } from '../../stores/toastStore';
import { Button } from '../ui/Button';

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
    toast.success('Custom CSS saved');
    setTimeout(() => setSaved(false), 2000);
  };

  const handleReset = () => {
    setCss('');
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" onClick={handleReset}>
          <RotateCcw size={15} aria-hidden />
          Reset
        </Button>
        <Button
          onClick={handleSave}
          aria-label={saved ? 'Custom CSS saved' : 'Save custom CSS'}
        >
          <Save size={15} aria-hidden />
          {saved ? 'Saved' : 'Save'}
        </Button>
      </div>

      {/* A caution is a well carrying warning ink, not a tinted panel. */}
      <div className="pc-well flex gap-2.5 px-3.5 py-3" role="note">
        <ShieldAlert size={16} className="mt-px shrink-0 text-accent-warning" aria-hidden />
        <p className="text-meta leading-relaxed">
          <span className="font-semibold text-accent-warning">Only paste CSS you trust. </span>
          <span className="text-text-secondary">
            Custom styles run against the whole interface. Unsafe directives (<code className="pc-mono">@import</code>,
            {' '}
            <code className="pc-mono">url()</code>, <code className="pc-mono">behavior</code>,
            {' '}
            <code className="pc-mono">expression</code>) are stripped automatically — but a theme you
            didn't write can still hide or restyle real controls.
          </span>
        </p>
      </div>

      {/* The editor is one well: recessed inside its plate, depth from the inset
          shadow, the §9 focus ring layered over it. */}
      <div className="pc-well overflow-hidden focus-within:shadow-[var(--shadow-well),var(--focus-ring)]">
        <div className="flex items-center gap-2 px-3.5 py-2">
          <Code2 size={13} className="text-text-faint" aria-hidden />
          <span className="pc-mono text-meta text-text-faint">custom.css</span>
        </div>
        <textarea
          value={css}
          onChange={(e) => setCss(e.target.value)}
          aria-label="Custom CSS"
          placeholder={`/* Restyle Paracord with your own CSS. */\n\n:root {\n  --accent-primary: #24d196;\n}`}
          rows={16}
          className="block w-full resize-y bg-transparent p-4 pc-mono text-label leading-relaxed text-text-primary outline-none placeholder:text-text-faint"
          style={{ tabSize: 2, minHeight: '260px' }}
          spellCheck={false}
        />
      </div>

      {sanitized && (
        <div
          className="flex items-start gap-2 rounded-[var(--radius-well)] bg-danger-well px-3.5 py-2.5 text-meta font-medium leading-relaxed text-accent-danger shadow-[var(--shadow-well)]"
          role="alert"
        >
          <AlertTriangle size={15} className="mt-px shrink-0" aria-hidden />
          Unsafe CSS directives were removed from preview and save output.
        </div>
      )}

      <p className="max-w-prose text-meta leading-relaxed text-text-faint">
        Server administrators can also apply server-wide CSS that reaches every member of that server.
      </p>
    </div>
  );
}
