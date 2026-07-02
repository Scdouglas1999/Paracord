import { useState, useEffect, useRef } from 'react';
import { RotateCcw, Save } from 'lucide-react';
import { sanitizeCustomCss } from '../../lib/security';

interface CustomCSSProps {
  initialCSS?: string;
  onSave?: (css: string) => void;
}

export function CustomCSS({ initialCSS = '', onSave }: CustomCSSProps) {
  const [css, setCss] = useState(initialCSS);
  const [saved, setSaved] = useState(false);
  const [sanitized, setSanitized] = useState(false);
  const styleRef = useRef<HTMLStyleElement | null>(null);

  // Live preview: inject CSS into document
  useEffect(() => {
    if (!styleRef.current) {
      styleRef.current = document.createElement('style');
      styleRef.current.setAttribute('data-custom-css', 'true');
      document.head.appendChild(styleRef.current);
    }
    const safeCss = sanitizeCustomCss(css);
    setSanitized(safeCss !== css);
    styleRef.current.textContent = safeCss;

    return () => {
      if (styleRef.current) {
        styleRef.current.textContent = '';
      }
    };
  }, [css]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (styleRef.current && styleRef.current.parentNode) {
        styleRef.current.parentNode.removeChild(styleRef.current);
        styleRef.current = null;
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
    if (styleRef.current) {
      styleRef.current.textContent = '';
    }
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
