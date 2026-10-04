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

/**
 * A code block in a message (docs/index-spec.md §8.4): `--ix-code`, radius 12, the
 * language and a Copy chip in one quiet row, the code in the code face. The
 * colors are in `ix-cards.css`; highlight.js only supplies the class names, and
 * everything it returns is sanitized down to `hljs-*` spans.
 */
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
    <div className="ix-code">
      <div className="ix-code__head">
        <span className="ix-code__lang">{language || 'code'}</span>
        <button
          type="button"
          onClick={handleCopy}
          aria-label={copied ? 'Code copied to clipboard' : 'Copy code to clipboard'}
          // pc-touch (§9, primitives.css): the chip keeps the 25px ink the code
          // block's header rhythm asks for and carries its hit area out to 44px
          // on a coarse pointer. On a phone this is the only way to copy a code
          // block — there is no hover row and no context menu behind it.
          className="ix-code__copy pc-touch"
          data-copied={copied || undefined}
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
      <pre className="ix-code__pre">
        <code
          className="hljs"
          dangerouslySetInnerHTML={{ __html: safeHighlightedHtml }}
        />
      </pre>
    </div>
  );
}
