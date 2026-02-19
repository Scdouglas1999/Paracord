import { useState, useMemo } from 'react';
import hljs from 'highlight.js/lib/core';

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

  const handleCopy = () => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div
      style={{
        margin: '6px 0',
        border: '1px solid var(--border-subtle)',
        borderRadius: '8px',
        overflow: 'hidden',
        backgroundColor: 'var(--bg-code)',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '4px 8px',
          borderBottom: '1px solid var(--border-subtle)',
          fontSize: '11px',
        }}
      >
        <span
          style={{
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            color: 'var(--text-muted)',
          }}
        >
          {language || ''}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--text-muted)',
            fontSize: '11px',
            padding: '2px 4px',
            borderRadius: '4px',
            transition: 'color 0.15s, background-color 0.15s',
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.color = 'var(--text-primary)';
            (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--bg-mod-subtle)';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.color = 'var(--text-muted)';
            (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent';
          }}
        >
          {copied ? (
            <>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              Copied!
            </>
          ) : (
            <>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
              Copy
            </>
          )}
        </button>
      </div>
      <pre
        style={{
          padding: '8px 10px',
          margin: 0,
          overflowX: 'auto',
          fontSize: '0.875em',
          lineHeight: '1.2rem',
          fontFamily: 'monospace',
        }}
      >
        <code
          className="hljs"
          dangerouslySetInnerHTML={{ __html: highlightedHtml }}
        />
      </pre>
    </div>
  );
}
