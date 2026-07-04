import { useState, useEffect, useRef } from 'react';
import { RotateCcw, Save, ShieldAlert, Code2, AlertTriangle } from 'lucide-react';
import { sanitizeCustomCss } from '../../lib/security';
import { toast } from '../../stores/toastStore';

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

  const FOCUS_RING =
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary focus-visible:ring-offset-2 focus-visible:ring-offset-bg-secondary';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button
          onClick={handleReset}
          className={`inline-flex items-center gap-1.5 rounded-sm border border-border-subtle px-3 py-2 text-label font-medium text-text-secondary transition-colors duration-150 hover:bg-bg-mod-subtle hover:text-text-primary active:scale-[.97] ${FOCUS_RING}`}
        >
          <RotateCcw size={15} />
          Reset
        </button>
        <button
          onClick={handleSave}
          aria-label={saved ? 'Custom CSS saved' : 'Save custom CSS'}
          className={cnSaveButton(saved, FOCUS_RING)}
        >
          <Save size={15} />
          {saved ? 'Saved' : 'Save'}
        </button>
      </div>

      <div
        className="flex gap-2.5 rounded-md px-3.5 py-3"
        style={{ background: 'var(--warning-tint)' }}
        role="note"
      >
        <ShieldAlert size={16} className="mt-px shrink-0 text-accent-warning" />
        <p className="text-meta leading-relaxed">
          <span className="font-semibold text-accent-warning">Only paste CSS you trust. </span>
          <span className="text-text-secondary">
            Custom styles run against the whole interface. Unsafe directives (<code className="font-code">@import</code>,
            {' '}
            <code className="font-code">url()</code>, <code className="font-code">behavior</code>,
            {' '}
            <code className="font-code">expression</code>) are stripped automatically — but a theme you
            didn't write can still hide or restyle real controls.
          </span>
        </p>
      </div>

      <div className="overflow-hidden rounded-md border border-border-subtle bg-bg-tertiary transition-colors duration-150 focus-within:border-accent-primary">
        <div className="flex items-center gap-2 border-b border-border-subtle px-3.5 py-2">
          <Code2 size={13} className="text-text-muted" />
          <span className="font-code text-[11px] text-text-muted">custom.css</span>
        </div>
        <textarea
          value={css}
          onChange={(e) => setCss(e.target.value)}
          placeholder={`/* Restyle Paracord with your own CSS. */\n\n:root {\n  --accent-primary: #24d196;\n}`}
          rows={16}
          className="block w-full resize-y bg-transparent p-4 font-code text-sm text-text-primary outline-none placeholder:text-text-muted"
          style={{ lineHeight: '1.6', tabSize: 2, minHeight: '260px' }}
          spellCheck={false}
        />
      </div>

      {sanitized && (
        <div
          className="flex items-center gap-2 rounded-md px-3.5 py-2.5 text-meta font-medium text-accent-danger"
          style={{ background: 'var(--danger-tint)' }}
          role="alert"
        >
          <AlertTriangle size={15} className="shrink-0" />
          Unsafe CSS directives were removed from preview and save output.
        </div>
      )}

      <p className="text-meta text-text-muted">
        Server administrators can also apply server-wide CSS that reaches every member of that server.
      </p>
    </div>
  );
}

function cnSaveButton(saved: boolean, focusRing: string): string {
  const base =
    'inline-flex items-center gap-1.5 rounded-sm px-3.5 py-2 text-label font-semibold text-text-on-accent shadow-sm transition-[transform,background-color] duration-150 active:scale-[.97]';
  const color = saved
    ? 'bg-accent-success'
    : 'bg-accent-primary hover:bg-accent-primary-hover active:bg-accent-primary-active';
  return `${base} ${color} ${focusRing}`;
}
