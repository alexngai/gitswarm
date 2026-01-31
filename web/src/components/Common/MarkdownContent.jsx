import CodeBlock from './CodeBlock';

/**
 * Simple markdown renderer that handles code blocks with syntax highlighting
 * Supports: code blocks (```lang), inline code (`), headers (#), bold (**), italic (*)
 */
export default function MarkdownContent({ content, className = '' }) {
  if (!content) return null;

  // Split content by code blocks
  const parts = content.split(/(```[\s\S]*?```)/g);

  return (
    <div className={`prose max-w-none ${className}`}>
      {parts.map((part, index) => {
        // Handle code blocks
        if (part.startsWith('```') && part.endsWith('```')) {
          const match = part.match(/```(\w+)?\n?([\s\S]*?)```/);
          if (match) {
            const language = match[1] || '';
            const code = match[2].trim();
            return (
              <CodeBlock
                key={index}
                code={code}
                language={language}
                className="my-4"
              />
            );
          }
        }

        // Handle regular text with inline markdown
        return (
          <div key={index} className="whitespace-pre-wrap">
            {renderInlineMarkdown(part)}
          </div>
        );
      })}
    </div>
  );
}

function renderInlineMarkdown(text) {
  const lines = text.split('\n');

  return lines.map((line, lineIndex) => {
    const trimmedLine = line.trim();

    // Headers
    if (trimmedLine.startsWith('## ')) {
      return (
        <h2 key={lineIndex} className="text-lg font-semibold text-text-primary mt-4 mb-2">
          {processInlineStyles(trimmedLine.slice(3))}
        </h2>
      );
    }
    if (trimmedLine.startsWith('# ')) {
      return (
        <h1 key={lineIndex} className="text-xl font-bold text-text-primary mt-4 mb-2">
          {processInlineStyles(trimmedLine.slice(2))}
        </h1>
      );
    }

    // List items
    if (trimmedLine.startsWith('- ') || trimmedLine.startsWith('* ')) {
      return (
        <div key={lineIndex} className="flex gap-2 text-text-secondary">
          <span>•</span>
          <span>{processInlineStyles(trimmedLine.slice(2))}</span>
        </div>
      );
    }

    // Regular line
    if (lineIndex < lines.length - 1) {
      return (
        <span key={lineIndex}>
          {processInlineStyles(line)}
          {'\n'}
        </span>
      );
    }

    return <span key={lineIndex}>{processInlineStyles(line)}</span>;
  });
}

function processInlineStyles(text) {
  if (!text) return text;

  // Split by inline code, bold, and italic
  const parts = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    // Check for inline code
    const codeMatch = remaining.match(/^`([^`]+)`/);
    if (codeMatch) {
      parts.push(
        <code key={key++} className="px-1.5 py-0.5 bg-bg-tertiary rounded text-sm font-mono text-accent-blue">
          {codeMatch[1]}
        </code>
      );
      remaining = remaining.slice(codeMatch[0].length);
      continue;
    }

    // Check for bold
    const boldMatch = remaining.match(/^\*\*([^*]+)\*\*/);
    if (boldMatch) {
      parts.push(
        <strong key={key++} className="font-semibold text-text-primary">
          {boldMatch[1]}
        </strong>
      );
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    // Check for italic (single asterisk)
    const italicMatch = remaining.match(/^\*([^*]+)\*/);
    if (italicMatch) {
      parts.push(<em key={key++}>{italicMatch[1]}</em>);
      remaining = remaining.slice(italicMatch[0].length);
      continue;
    }

    // Find next special character
    const nextSpecial = remaining.search(/[`*]/);
    if (nextSpecial === -1) {
      parts.push(remaining);
      break;
    } else if (nextSpecial === 0) {
      // Special char not matched, treat as regular text
      parts.push(remaining[0]);
      remaining = remaining.slice(1);
    } else {
      parts.push(remaining.slice(0, nextSpecial));
      remaining = remaining.slice(nextSpecial);
    }
  }

  return parts;
}
