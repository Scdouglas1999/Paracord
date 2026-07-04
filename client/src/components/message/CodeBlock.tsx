import { useState, useMemo } from 'react';
import { Copy, Check } from 'lucide-react';
import hljs from 'highlight.js/lib/core';
import DOMPurify from 'dompurify';

import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import rust from 'highlight.js/lib/languages/rust';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import sql from 'highlight.js/lib/languages/sql';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import ruby from 'highlight.js/lib/languages/ruby';
import php from 'highlight.js/lib/languages/php';
import yaml from 'highlight.js/lib/languages/yaml';
import markdown from 'highlight.js/lib/languages/markdown';
import diff from 'highlight.js/lib/languages/diff';
import plaintext from 'highlight.js/lib/languages/plaintext';
import { writeClipboardText } from '../../lib/clipboard';
import { toast } from '../../stores/toastStore';

// TOML is registered under 'ini' in highlight.js
import ini from 'highlight.js/lib/languages/ini';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('rs', rust);
hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('shell', bash);
hljs.registerLanguage('json', json);
hljs.registerLanguage('css', css);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('go', go);
hljs.registerLanguage('java', java);
hljs.registerLanguage('c', c);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('csharp', csharp);
hljs.registerLanguage('cs', csharp);
hljs.registerLanguage('ruby', ruby);
hljs.registerLanguage('rb', ruby);
hljs.registerLanguage('php', php);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('yml', yaml);
hljs.registerLanguage('toml', ini);
hljs.registerLanguage('ini', ini);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('md', markdown);
hljs.registerLanguage('diff', diff);
hljs.registerLanguage('plaintext', plaintext);
hljs.registerLanguage('text', plaintext);

interface CodeBlockProps {
  code: string;
  language?: string;
}

function sanitizeHighlightedHtml(html: string): string {
  const sanitized = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['span'],
    ALLOWED_ATTR: ['class'],
    ALLOW_DATA_ATTR: false,
    FORBID_ATTR: ['style'],
  });

  return sanitized.replace(/class="([^"]*)"/g, (_match, classList: string) => {
    const safe = classList
      .split(/\s+/)
      .filter((token) => token === 'hljs' || token.startsWith('hljs-'))
      .join(' ');
    return safe ? `class="${safe}"` : '';
  });
}

export default function CodeBlock({ code, language }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const highlightedHtml = useMemo(() => {
    if (language) {
      try {
        const result = hljs.highlight(code, { language });
        return result.value;
      } catch {
        // Language not recognized, fall back to auto
        const result = hljs.highlightAuto(code);
        return result.value;
      }
    }
    const result = hljs.highlightAuto(code);
    return result.value;
  }, [code, language]);

  const safeHighlightedHtml = useMemo(
    () => sanitizeHighlightedHtml(highlightedHtml),
    [highlightedHtml],
  );

  const handleCopy = () => {
    writeClipboardText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch((err) => {
      toast.error(`Failed to copy code: ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  return (
    <div
      style={{
        margin: '6px 0',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-sm)',
        overflow: 'hidden',
        backgroundColor: 'var(--bg-code)',
        boxShadow: 'var(--shadow-sm)',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '4px 8px 4px 12px',
          borderBottom: '1px solid var(--border-subtle)',
        }}
      >
        <span
          style={{
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            fontSize: 'var(--text-section)',
            fontWeight: 600,
            fontFamily: 'var(--font-code)',
            color: 'var(--text-muted)',
          }}
        >
          {language || 'code'}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          aria-label={copied ? 'Code copied to clipboard' : 'Copy code to clipboard'}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '5px',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: copied ? 'var(--accent-success)' : 'var(--text-muted)',
            fontSize: 'var(--text-meta)',
            fontWeight: 500,
            padding: '3px 7px',
            borderRadius: 'var(--radius-sm)',
            outline: 'none',
            transition: 'color 140ms var(--ease-out), background-color 140ms var(--ease-out), box-shadow 140ms var(--ease-out)',
          }}
          onMouseEnter={(e) => {
            if (copied) return;
            e.currentTarget.style.color = 'var(--text-primary)';
            e.currentTarget.style.backgroundColor = 'var(--bg-mod-subtle)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = copied ? 'var(--accent-success)' : 'var(--text-muted)';
            e.currentTarget.style.backgroundColor = 'transparent';
          }}
          onFocus={(e) => {
            // Keyboard focus must be as reachable/visible as hover (a11y §8).
            e.currentTarget.style.boxShadow = 'var(--focus-ring)';
            if (!copied) e.currentTarget.style.color = 'var(--text-primary)';
          }}
          onBlur={(e) => {
            e.currentTarget.style.boxShadow = 'none';
            e.currentTarget.style.color = copied ? 'var(--accent-success)' : 'var(--text-muted)';
            e.currentTarget.style.backgroundColor = 'transparent';
          }}
        >
          {copied ? (
            <>
              <Check size={14} aria-hidden="true" />
              Copied
            </>
          ) : (
            <>
              <Copy size={14} aria-hidden="true" />
              Copy
            </>
          )}
        </button>
      </div>
      <pre
        style={{
          padding: '10px 12px',
          margin: 0,
          overflowX: 'auto',
          fontSize: '0.875em',
          lineHeight: '1.45',
          fontFamily: 'var(--font-code)',
        }}
      >
        <code
          className="hljs"
          dangerouslySetInnerHTML={{ __html: safeHighlightedHtml }}
        />
      </pre>
    </div>
  );
}
