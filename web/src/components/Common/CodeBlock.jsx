import { Highlight, themes } from 'prism-react-renderer';
import { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme.jsx';

const languageAliases = {
  js: 'javascript',
  ts: 'typescript',
  py: 'python',
  rb: 'ruby',
  sh: 'bash',
  shell: 'bash',
  yml: 'yaml',
  sql: 'sql',
  json: 'json',
  html: 'markup',
  css: 'css',
  jsx: 'jsx',
  tsx: 'tsx',
  go: 'go',
  rs: 'rust',
  c: 'c',
  cpp: 'cpp',
  java: 'java',
};

function detectLanguage(code) {
  // Simple heuristics for common patterns
  if (code.includes('SELECT') || code.includes('INSERT') || code.includes('CREATE')) return 'sql';
  if (code.includes('function') || code.includes('const ') || code.includes('let ')) return 'javascript';
  if (code.includes('def ') || code.includes('import ') && code.includes(':')) return 'python';
  if (code.includes('fn ') || code.includes('let mut')) return 'rust';
  if (code.includes('func ') && code.includes(':=')) return 'go';
  if (code.includes('class ') && code.includes('public')) return 'java';
  if (code.includes('<') && code.includes('>') && code.includes('/')) return 'markup';
  return 'javascript';
}

export default function CodeBlock({ code, language, showLineNumbers = false, className = '' }) {
  const [copied, setCopied] = useState(false);
  const { isDark } = useTheme();

  const normalizedLanguage = languageAliases[language?.toLowerCase()] || language || detectLanguage(code);
  const theme = isDark ? themes.nightOwl : themes.github;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  return (
    <div className={`relative group rounded-md overflow-hidden ${className}`}>
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 p-1.5 rounded bg-bg-overlay/80 text-text-secondary hover:text-text-primary opacity-0 group-hover:opacity-100 transition-opacity z-10"
        title="Copy code"
      >
        {copied ? (
          <Check className="w-4 h-4 text-accent-green" />
        ) : (
          <Copy className="w-4 h-4" />
        )}
      </button>

      <Highlight theme={theme} code={code.trim()} language={normalizedLanguage}>
        {({ className: highlightClassName, style, tokens, getLineProps, getTokenProps }) => (
          <pre
            className={`${highlightClassName} p-4 overflow-x-auto text-sm font-mono`}
            style={{
              ...style,
              margin: 0,
              backgroundColor: isDark ? '#0d1117' : '#f6f8fa',
            }}
          >
            {tokens.map((line, i) => (
              <div key={i} {...getLineProps({ line })}>
                {showLineNumbers && (
                  <span className="select-none text-text-muted mr-4 text-right inline-block w-8">
                    {i + 1}
                  </span>
                )}
                {line.map((token, key) => (
                  <span key={key} {...getTokenProps({ token })} />
                ))}
              </div>
            ))}
          </pre>
        )}
      </Highlight>
    </div>
  );
}
