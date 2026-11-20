'use client';

import { memo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';

interface Props {
  content: string;
  className?: string;
  isStreaming?: boolean;
}

/** Copy code block helper component */
function CodeBlock({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const match = /language-(\w+)/.exec(className || '');
  const language = match ? match[1] : '';

  // Extract raw text from children
  const rawCode = String(children).replace(/\n$/, '');

  // Never render investment_report blocks as visible code blocks
  if (language === 'investment_report') {
    return null;
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(rawCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore clipboard error
    }
  };

  return (
    <div className="group relative my-3 overflow-hidden rounded-lg border border-border bg-panel text-xs">
      <div className="flex items-center justify-between border-b border-border/60 bg-panel-2/70 px-3 py-1.5 font-mono text-[11px] text-muted">
        <span>{language || 'code'}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="rounded px-2 py-0.5 text-[10px] font-medium transition-colors hover:bg-panel hover:text-text focus:outline-none"
          title="Copy code to clipboard"
          aria-label="Copy code to clipboard"
        >
          {copied ? '✓ Copied!' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 font-mono leading-relaxed text-text">
        <code>{children}</code>
      </pre>
    </div>
  );
}

// Custom sanitizer schema allowing safe classes and attributes
const customSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code || []), 'className'],
    span: [...(defaultSchema.attributes?.span || []), 'className'],
    div: [...(defaultSchema.attributes?.div || []), 'className'],
    th: [...(defaultSchema.attributes?.th || []), 'style', 'align'],
    td: [...(defaultSchema.attributes?.td || []), 'style', 'align'],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: ['http', 'https', 'mailto'],
  },
};

export const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
  className = '',
  isStreaming = false,
}: Props) {
  // Strip out any complete or partial investment_report blocks so raw internal report JSON is never shown in Markdown
  const sanitizedContent = content
    .replace(/```investment_report[\s\S]*?(?:```|$)/g, '')
    .trim();

  if (!sanitizedContent) {
    if (isStreaming) {
      return (
        <span className="inline-block w-2 h-4 bg-accent animate-pulse align-middle" />
      );
    }
    return null;
  }

  return (
    <div className={`markdown-content space-y-2.5 text-[14px] leading-relaxed text-text/90 ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, customSchema]]}
        components={{
          h1: ({ children }) => (
            <h1 className="mt-4 mb-2 border-b border-border/80 pb-1.5 text-lg font-bold text-text">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="mt-3.5 mb-1.5 border-b border-border/50 pb-1 text-base font-semibold text-text">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="mt-3 mb-1 text-[15px] font-semibold text-text">
              {children}
            </h3>
          ),
          h4: ({ children }) => (
            <h4 className="mt-2.5 mb-1 text-sm font-semibold text-text">
              {children}
            </h4>
          ),
          h5: ({ children }) => (
            <h5 className="mt-2 mb-0.5 text-xs font-semibold uppercase tracking-wider text-muted">
              {children}
            </h5>
          ),
          h6: ({ children }) => (
            <h6 className="mt-2 mb-0.5 text-xs font-semibold text-muted">
              {children}
            </h6>
          ),
          p: ({ children }) => (
            <p className="my-2 leading-relaxed text-text/90 last:mb-0">
              {children}
            </p>
          ),
          strong: ({ children }) => (
            <strong className="font-semibold text-text">
              {children}
            </strong>
          ),
          em: ({ children }) => (
            <em className="italic text-text/90">
              {children}
            </em>
          ),
          del: ({ children }) => (
            <del className="line-through text-muted">
              {children}
            </del>
          ),
          ul: ({ children }) => (
            <ul className="my-2 space-y-1 pl-5 list-disc marker:text-accent">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="my-2 space-y-1 pl-5 list-decimal marker:text-accent">
              {children}
            </ol>
          ),
          li: ({ children }) => (
            <li className="leading-relaxed pl-0.5">
              {children}
            </li>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-3 rounded-r-md border-l-2 border-accent bg-panel-2/40 px-3.5 py-1.5 italic text-text/80">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-3.5 border-border/70" />,
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto rounded-lg border border-border shadow-xs">
              <table className="w-full min-w-full divide-y divide-border text-xs">
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="bg-panel-2 font-semibold text-text">
              {children}
            </thead>
          ),
          tbody: ({ children }) => (
            <tbody className="divide-y divide-border/40 bg-panel/30">
              {children}
            </tbody>
          ),
          tr: ({ children }) => (
            <tr className="transition-colors hover:bg-panel-2/30">
              {children}
            </tr>
          ),
          th: ({ children }) => (
            <th className="px-3 py-2 text-left font-semibold text-text whitespace-nowrap">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="px-3 py-2 text-text/90 whitespace-nowrap">
              {children}
            </td>
          ),
          code: ({ className, children, ...props }) => {
            const isInline = !className && typeof children === 'string' && !children.includes('\n');
            if (isInline) {
              return (
                <code
                  className="rounded bg-panel-2 px-1.5 py-0.5 font-mono text-xs text-accent"
                  {...props}
                >
                  {children}
                </code>
              );
            }
            return <CodeBlock className={className}>{children}</CodeBlock>;
          },
          pre: ({ children }) => <>{children}</>,
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent underline underline-offset-2 hover:text-accent/80 transition-colors"
            >
              {children}
            </a>
          ),
        }}
      >
        {sanitizedContent}
      </ReactMarkdown>
      {isStreaming && (
        <span
          className="inline-block w-1.5 h-4 ml-0.5 bg-accent animate-pulse align-middle"
          aria-hidden="true"
        />
      )}
    </div>
  );
});
